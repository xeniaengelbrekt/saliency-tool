#!/usr/bin/env python3
"""
make_reference.py — независимая («эталонная») реализация вычислений инструмента
на Python (numpy, scipy, OpenCV) для сверки с JavaScript-кодом.

Что делает:
  1. Берёт набор изображений, приводит их к рабочей копии (длинная сторона 256 px).
  2. Считает карты FT, DoG, Local Contrast и SR по формулам из описания (docs/methods.md),
     используя другие библиотечные реализации (cv2.cvtColor, scipy.ndimage.gaussian_filter,
     numpy.fft), а не код инструмента.
  3. Считает метрики карты и метрики соответствия фиксациям (CC, NSS, AUC-Judd, sAUC, SIM, KL)
     на синтетических фиксациях.
  4. Записывает всё в validation/data/reference.json; страница validation/compare.html
     прогоняет те же данные через JavaScript-код и выводит расхождения.

Запуск:
  python make_reference.py --images путь1.jpg путь2.png ... [--out data/reference.json]
  или: python make_reference.py --dir папка_с_изображениями

Нужны: numpy, scipy, opencv-python (есть, например, в составе PsychoPy).
Фиксации синтетические (часть — из плотности ~ карта FT, часть — центральное смещение),
поэтому проверяется СОВПАДЕНИЕ расчётов, а не предсказательная сила моделей.
"""
import argparse
import base64
import glob
import json
import os
import sys

import cv2
import numpy as np
from scipy import ndimage, stats

trapezoid = getattr(np, 'trapezoid', None) or np.trapz
TARGET = 256
EPS = 2.2204e-16
NORM_PCT = 0.999
SIGMA_KDE = 8.0          # σ ядра карты фиксаций, пиксели карты
N_PART, N_FIX = 8, 20    # участников, фиксаций на участника


def work_size(w, h):
    k = TARGET / max(w, h)
    return max(8, int(np.floor(w * k + 0.5))), max(8, int(np.floor(h * k + 0.5)))


def normalize(S):
    """Робастная нормировка (docs/methods.md, п. 3). Возвращает (нормированная карта, min, max, hi)."""
    S = np.asarray(S, dtype=np.float64)
    mn, mx = float(S.min()), float(S.max())
    n = S.size
    hi = mx
    if n >= 1000:
        srt = np.sort(S.ravel())
        hi = float(srt[min(n - 1, int(np.floor(NORM_PCT * (n - 1))))])
        if not hi > mn:
            hi = mx
    rng = hi - mn
    out = np.clip((S - mn) / rng, 0, 1) if rng > 0 else np.zeros_like(S)
    return out.astype(np.float32), mn, mx, hi


# ---------------------------- алгоритмы карт ----------------------------

def ref_ft(rgb01):
    lab = cv2.cvtColor(rgb01.astype(np.float32), cv2.COLOR_RGB2Lab)
    k = np.array([1, 4, 6, 4, 1], dtype=np.float32)
    kern = np.outer(k, k) / 256.0
    blur = cv2.filter2D(lab, -1, kern, borderType=cv2.BORDER_REPLICATE)
    mu = lab.reshape(-1, 3).mean(axis=0)
    return np.sqrt(((mu - blur) ** 2).sum(axis=-1))


def gray601(rgb255):
    return 0.299 * rgb255[..., 0] + 0.587 * rgb255[..., 1] + 0.114 * rgb255[..., 2]


def ref_dog(rgb255):
    g = gray601(rgb255)
    s = np.zeros_like(g)
    for s1, s2 in [(1, 2), (2, 4), (4, 8), (8, 16)]:
        a = ndimage.gaussian_filter(g, s1, mode='nearest', truncate=3.0)
        b = ndimage.gaussian_filter(g, s2, mode='nearest', truncate=3.0)
        s += np.abs(a - b)
    return s


def ref_local(rgb01):
    h, w = rgb01.shape[:2]
    sigma = 0.08 * max(w, h)
    s = np.zeros((h, w))
    for c in range(3):
        ch = rgb01[..., c].astype(np.float64)
        s += (ch - ndimage.gaussian_filter(ch, sigma, mode='nearest', truncate=3.0)) ** 2
    return s


def ref_sr(rgb255):
    h, w = rgb255.shape[:2]
    g = gray601(rgb255).astype(np.float32)
    small = cv2.resize(g, (64, 64), interpolation=cv2.INTER_AREA).astype(np.float64)
    F = np.fft.fft2(small)
    A = np.maximum(np.abs(F), 1e-10)
    P = np.angle(F)
    L = np.log(A)
    Q = cv2.blur(L, (3, 3), borderType=cv2.BORDER_REPLICATE)
    R = L - Q
    S = np.abs(np.fft.ifft2(np.exp(R + 1j * P))) ** 2
    G = ndimage.gaussian_filter(S, 8, mode='nearest', truncate=3.0)
    return cv2.resize(G.astype(np.float32), (w, h), interpolation=cv2.INTER_LINEAR)


# ---------------------------- метрики карты ----------------------------

def map_metrics(Sn, raw_max):
    """Sn — нормированная карта float32, raw_max — истинный максимум сырой карты."""
    h, w = Sn.shape
    mean = float(Sn.mean())
    hist = np.clip((Sn * 64).astype(np.int64), 0, 63)
    p = np.bincount(hist.ravel(), minlength=64) / Sn.size
    p = p[p > 0]
    entropy = float(-(p * np.log2(p)).sum())
    yy, xx = np.mgrid[0:h, 0:w]
    cx, cy = w / 2, h / 2
    inner = (((xx + 0.5 - cx) / (0.7 * cx)) ** 2 + ((yy + 0.5 - cy) / (0.7 * cy)) ** 2) <= 1
    inner_mean, outer_mean = Sn[inner].mean(), Sn[~inner].mean()
    center_bias = float(inner_mean / outer_mean) if outer_mean > 0 else 0.0
    spread = float((Sn > 0.5).mean() * 100)
    mask = Sn == Sn.max()
    py, px = (yy[mask] + 0.5).mean(), (xx[mask] + 0.5).mean()
    return {
        'mean': mean, 'peak': float(raw_max), 'entropy': entropy, 'center_bias': center_bias,
        'spread_pct': spread, 'peak_x': float(px / w * 100), 'peak_y': float(py / h * 100),
    }


# ------------------------ метрики соответствия фиксациям ------------------------

def center_baseline(w, h):
    yy, xx = np.mgrid[0:h, 0:w]
    dx, dy = (xx + 0.5 - w / 2) / (w / 4), (yy + 0.5 - h / 2) / (h / 4)
    return normalize(np.exp(-0.5 * (dx * dx + dy * dy)))[0]


def auc_judd(S, idx, rng, draws=20):
    """AUC-Judd по определению; ничьи в карте разрешаются малым случайным шумом
    (как в эталонных реализациях), результат усредняется по draws повторам."""
    flat = S.ravel().astype(np.float64)
    n = flat.size
    nfix = len(idx)
    vals = []
    for _ in range(draws):
        s2 = flat + rng.random(n) * 1e-7
        order = np.sort(s2[idx])[::-1]
        srt = np.sort(s2)
        above = n - np.searchsorted(srt, order, side='left')
        tp = (np.arange(nfix) + 1) / nfix
        fp = (above - (np.arange(nfix) + 1)) / (n - nfix)
        tpc = np.concatenate([[0], tp, [1]])
        fpc = np.concatenate([[0], fp, [1]])
        vals.append(float(trapezoid(tpc, fpc)))
    return float(np.mean(vals))


def eval_map(S, idx, neg_idx, dens, rng):
    S = S.astype(np.float64)
    flat = S.ravel()
    z = (S - S.mean()) / S.std()
    P = S / S.sum()
    Q = dens / dens.sum()
    pos = flat[idx]
    neg = flat[neg_idx]
    u = stats.mannwhitneyu(pos, neg, alternative='two-sided', method='asymptotic').statistic
    return {
        'cc': float(np.corrcoef(flat, dens.ravel())[0, 1]),
        'nss': float(z.ravel()[idx].mean()),
        'auc': auc_judd(S, idx, rng),
        'sauc': float(u / (len(pos) * len(neg))),
        'sim': float(np.minimum(P, Q).sum()),
        'kl': float((Q * np.log(EPS + Q / (P + EPS))).sum()),
    }


def b64(arr):
    return base64.b64encode(np.ascontiguousarray(arr).tobytes()).decode('ascii')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--images', nargs='*', default=[])
    ap.add_argument('--dir', default=None)
    ap.add_argument('--out', default=os.path.join(os.path.dirname(__file__), 'data', 'reference.json'))
    ap.add_argument('--seed', type=int, default=2026)
    a = ap.parse_args()

    paths = list(a.images)
    if a.dir:
        for ext in ('*.jpg', '*.jpeg', '*.png', '*.bmp'):
            paths += sorted(glob.glob(os.path.join(a.dir, ext)))
    if not paths:
        sys.exit('Нет изображений: укажите --images или --dir')

    rng = np.random.default_rng(a.seed)
    images = []
    for p in paths:
        bgr = cv2.imread(p, cv2.IMREAD_COLOR)
        if bgr is None:
            print('пропущено (не читается):', p)
            continue
        H, W = bgr.shape[:2]
        w, h = work_size(W, H)
        small = cv2.resize(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB), (w, h), interpolation=cv2.INTER_AREA)
        rgb255 = small.astype(np.float64)
        rgb01 = rgb255 / 255.0

        raw = {'ft': ref_ft(rgb01), 'dog': ref_dog(rgb255), 'local': ref_local(rgb01), 'sr': ref_sr(rgb255)}
        maps, rawinfo, mets = {}, {}, {}
        for m, S in raw.items():
            Sn, mn, mx, hi = normalize(S)
            maps[m] = Sn
            rawinfo[m] = {'min': mn, 'max': mx, 'hi': hi}
            mets[m] = map_metrics(Sn, mx)

        # синтетические фиксации: 70 % ~ карта FT², 30 % — центральное смещение
        n_tot = N_PART * N_FIX
        prob = (maps['ft'].astype(np.float64) ** 2).ravel() + 1e-6
        prob /= prob.sum()
        us, vs = [], []
        for i in range(n_tot):
            if rng.random() < 0.7:
                k = rng.choice(prob.size, p=prob)
                gy, gx = divmod(int(k), w)
                u, v = (gx + rng.random()) / w, (gy + rng.random()) / h
            else:
                u = float(np.clip(0.5 + rng.normal(0, 0.18), 0, 0.9999))
                v = float(np.clip(0.5 + rng.normal(0, 0.18), 0, 0.9999))
            us.append(u)
            vs.append(v)
        # убрать фиксации в одном пикселе (AUC по определению работает с уникальными пикселями)
        seen, keep = set(), []
        for i, (u, v) in enumerate(zip(us, vs)):
            key = (int(v * h), int(u * w))
            if key not in seen:
                seen.add(key)
                keep.append(i)
        images.append({
            'name': os.path.basename(p), 'orig': [W, H], 'w': w, 'h': h,
            'rgb': b64(small.astype(np.uint8)),
            'maps': {m: b64(maps[m]) for m in maps}, 'raw': rawinfo, 'metrics': mets,
            'fix': {'u': [us[i] for i in keep], 'v': [vs[i] for i in keep],
                    'participant': [f'P{i % N_PART}' for i in keep]},
        })
        print(f'{os.path.basename(p):28s} {W}x{H} -> {w}x{h}, фиксаций {len(keep)}')

    # метрики соответствия: модель = карта FT, плюс центральный baseline; негативы sAUC — фиксации других изображений
    for im in images:
        w, h = im['w'], im['h']
        idx = np.array([int(v * h) * w + int(u * w) for u, v in zip(im['fix']['u'], im['fix']['v'])])
        neg = np.array([int(v * h) * w + int(u * w)
                        for o in images if o is not im for u, v in zip(o['fix']['u'], o['fix']['v'])])
        counts = np.zeros((h, w))
        np.add.at(counts.ravel(), idx, 1)
        dens = ndimage.gaussian_filter(counts, SIGMA_KDE, mode='constant', truncate=3.0)
        ft = np.frombuffer(base64.b64decode(im['maps']['ft']), dtype=np.float32).reshape(h, w)
        im['eval'] = {
            'ft': eval_map(ft, idx, neg, dens, rng),
            'center': eval_map(center_baseline(w, h), idx, neg, dens, rng),
        }
        im['sigma'] = SIGMA_KDE

    # статистика: ANOVA, квантили t, доверительный интервал
    srng = np.random.default_rng(7)
    groups = [srng.normal(m, 1.0, n).tolist() for m, n in [(0.0, 6), (0.3, 7), (0.8, 8)]]
    F, p = stats.f_oneway(*groups)
    sample = srng.normal(0, 1, 9).tolist()
    m, sd = float(np.mean(sample)), float(np.std(sample, ddof=1))
    half = float(stats.t.ppf(0.975, 8) * sd / np.sqrt(9))
    ref_stats = {
        'groups': groups, 'F': float(F), 'p': float(p),
        't_dfs': [1, 2, 5, 10, 30, 100], 't975': [float(stats.t.ppf(0.975, d)) for d in [1, 2, 5, 10, 30, 100]],
        'sample': sample, 'ci': [m - half, m + half],
        'fcdf': [[1.0, 1, 1, float(stats.f.cdf(1.0, 1, 1))], [3.0, 2, 6, float(stats.f.cdf(3.0, 2, 6))],
                 [2.5, 5, 20, float(stats.f.cdf(2.5, 5, 20))]],
    }

    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    with open(a.out, 'w', encoding='utf-8') as fh:
        json.dump({'version': 1, 'seed': a.seed, 'images': images, 'stats': ref_stats,
                   'libs': {'numpy': np.__version__, 'scipy': __import__('scipy').__version__, 'opencv': cv2.__version__}}, fh)
    print('готово:', a.out, f'({os.path.getsize(a.out) / 1e6:.1f} МБ)')


if __name__ == '__main__':
    main()
