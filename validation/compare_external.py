#!/usr/bin/env python3
"""
compare_external.py — сверка с ВНЕШНИМИ реализациями.

  1. Метрики соответствия (CC, NSS, AUC-Judd, sAUC, SIM, KL) — с кодом pysaliency (Kümmerer et al.),
     на одинаковых входных данных (карта модели, карта плотности фиксаций, пиксели фиксаций/негативов).
  2. Карта SR — с OpenCV-contrib (cv2.saliency.StaticSaliencySpectralResidual).

Подготовка:
  - python make_reference.py ...                 → data/reference.json
  - открыть validation/compare_external.html, скопировать JSON со страницы в data/js_identical.json
  - pip install numpy scipy numba opencv-contrib-python
  - скачать исходный код pysaliency (sdist с PyPI) и распаковать; pysaliency ставить целиком не нужно
    (нужны только файлы metrics.py и numba_utils.py; сборка C-расширения не требуется).

Запуск:
  python compare_external.py --pysaliency-src путь/к/pysaliency-0.2.22/pysaliency
"""
import argparse
import base64
import importlib.util
import json
import os
import sys

import cv2
import numpy as np

# numpy ≥ 2.4 может не содержать np.trapz, которую использует pysaliency
if not hasattr(np, 'trapz'):
    np.trapz = np.trapezoid


def load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def f32(b64, shape=None):
    a = np.frombuffer(base64.b64decode(b64), dtype=np.float32)
    return a.reshape(shape) if shape else a


def main():
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')   # консоль Windows (cp1251) не выводит Δ, ρ
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser()
    ap.add_argument('--pysaliency-src', required=True)
    ap.add_argument('--reference', default=os.path.join(here, 'data', 'reference.json'))
    ap.add_argument('--js', default=os.path.join(here, 'data', 'js_identical.json'))
    a = ap.parse_args()

    metrics = load_module(os.path.join(a.pysaliency_src, 'metrics.py'), 'ps_metrics')
    nbu = load_module(os.path.join(a.pysaliency_src, 'numba_utils.py'), 'ps_numba_utils')
    ref = json.load(open(a.reference, encoding='utf-8'))
    js = {r['name']: r for r in json.load(open(a.js, encoding='utf-8'))}

    keys = ['cc', 'nss', 'auc', 'sauc', 'sim', 'kl']
    diffs = {m: {k: [] for k in keys} for m in ('ft', 'center')}
    auc_all_pixels = []
    print(f'{"изображение":16s} {"модель":7s} ' + ' '.join(f'{k:>9s}' for k in keys) + '   (Δ = JS − pysaliency)')
    for im in ref['images']:
        w, h = im['w'], im['h']
        dens = f32(im['dens'], (h, w)).astype(np.float64)
        idx = np.array(im['idx'])
        neg = np.array(im['neg'])
        ys, xs = np.divmod(idx, w)
        nonfix = np.ones(w * h, dtype=bool)
        nonfix[idx] = False
        for model, b64 in (('ft', im['maps']['ft']), ('center', im['center'])):
            S = f32(b64, (h, w)).astype(np.float64)
            flat = S.ravel()
            pos = flat[idx]
            ps = {
                'cc': float(metrics.CC(S, dens)),
                'nss': float(metrics.NSS(S, xs, ys).mean()),
                # Judd: негативы — нефиксированные пиксели, пороги — значения в фиксациях
                'auc': float(nbu.general_roc_numba(pos, flat[nonfix], judd=1)[0]),
                'sauc': float(nbu.general_roc_numba(pos, flat[neg], judd=0)[0]),
                'sim': float(metrics.SIM(S, dens)),
                'kl': float(metrics.MIT_KLDiv(S, dens)),
            }
            if model == 'ft':
                auc_all_pixels.append(float(nbu.general_roc_numba(pos, flat, judd=1)[0]) - ps['auc'])
            row = []
            for k in keys:
                d = js[im['name']][model][k] - ps[k]
                diffs[model][k].append(d)
                row.append(d)
            print(f'{im["name"]:16s} {model:7s} ' + ' '.join(f'{d:9.1e}' for d in row))

    print('\nМаксимум |Δ| по всем изображениям (JS против pysaliency):')
    print(f'{"модель":8s} ' + ' '.join(f'{k:>9s}' for k in keys))
    for m in ('ft', 'center'):
        print(f'{m:8s} ' + ' '.join(f'{np.max(np.abs(diffs[m][k])):9.1e}' for k in keys))
    print(f'\nСправочно: AUC-Judd у pysaliency при негативах «все пиксели» (а не только нефиксированные) '
          f'отличается от варианта Judd на {np.max(np.abs(auc_all_pixels)):.1e} (макс.)')

    # ---------------- OpenCV-contrib: Spectral Residual ----------------
    # Реализация OpenCV отличается от статьи Hou & Zhang (и от инструмента) сглаживанием:
    # cv2.GaussianBlur(|F^-1|, ядро 5x5, σ=8) ДО возведения в квадрат — при таком ядре это почти
    # равномерное усреднение 5x5 на сетке 64x64, тогда как в статье — гауссиан σ=8 на всей сетке.
    # Поэтому карты сравниваются дважды: (а) напрямую; (б) карта инструмента, пересчитанная шагами
    # OpenCV ("как в OpenCV"), — если (б) совпадает с OpenCV, то остальные шаги (БПФ, фаза, остаток) согласованы.
    from scipy import ndimage
    from scipy.stats import spearmanr

    def sr_steps(rgb, smoothing, resize_mode):
        h, w = rgb.shape[:2]
        gray = (0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2]).astype(np.float32)
        small = cv2.resize(gray, (64, 64), interpolation=resize_mode).astype(np.float64)
        F = np.fft.fft2(small)
        L = np.log(np.maximum(np.abs(F), 1e-10))
        Q = cv2.blur(L, (3, 3), borderType=cv2.BORDER_DEFAULT if smoothing == 'opencv' else cv2.BORDER_REPLICATE)
        m = np.abs(np.fft.ifft2(np.exp(L - Q) * np.exp(1j * np.angle(F))))
        if smoothing == 'opencv':
            m = cv2.GaussianBlur(m, (5, 5), 8, borderType=cv2.BORDER_DEFAULT) ** 2
        else:
            m = ndimage.gaussian_filter(m * m, 8, mode='nearest', truncate=3.0)
        return m

    def up(m, w, h):
        m = m / m.max()
        return cv2.resize(m.astype(np.float32), (w, h), interpolation=cv2.INTER_LINEAR_EXACT).astype(np.float64)

    print('\nSR: сравнение с cv2.saliency.StaticSaliencySpectralResidual (OpenCV-contrib %s)' % cv2.__version__)
    print(f'  {"изображение":16s} {"инструмент~OpenCV":>18s} {"«как в OpenCV»~OpenCV":>22s} {"площадь~билинейное (σ=8)":>26s}')
    cv_sr = cv2.saliency.StaticSaliencySpectralResidual_create()
    r_direct, r_like, r_resize = [], [], []
    for im in ref['images']:
        w, h = im['w'], im['h']
        rgb = np.frombuffer(base64.b64decode(im['rgb']), dtype=np.uint8).reshape(h, w, 3)
        ok, cvmap = cv_sr.computeSaliency(cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))
        cvmap = np.asarray(cvmap, dtype=np.float64)
        ours = f32(im['maps']['sr'], (h, w)).astype(np.float64)
        like = up(sr_steps(rgb, 'opencv', cv2.INTER_LINEAR_EXACT), w, h)
        pa = up(sr_steps(rgb, 'paper', cv2.INTER_AREA), w, h)
        pl = up(sr_steps(rgb, 'paper', cv2.INTER_LINEAR_EXACT), w, h)
        c = lambda x, y: np.corrcoef(x.ravel(), y.ravel())[0, 1]
        r_direct.append(c(ours, cvmap))
        r_like.append(c(like, cvmap))
        r_resize.append(c(pa, pl))
        print(f'  {im["name"]:16s} {r_direct[-1]:18.4f} {r_like[-1]:22.4f} {r_resize[-1]:26.4f}')
    print(f'  минимум / медиана:  {min(r_direct):.4f} / {np.median(r_direct):.4f}   {min(r_like):.4f} / {np.median(r_like):.4f}   '
          f'{min(r_resize):.4f} / {np.median(r_resize):.4f}')

if __name__ == '__main__':
    main()
