"""Границы четырёх фотографий в каждом составном стимуле 2×2 на белом фоне.

Запуск: python extract_cells.py --stim-dir DIR --out cells.csv
Все PNG из DIR (рекурсивно); имя файла — имя стимула. Ячейки: TL, TR, BL, BR (x0, y0, x1, y1 в пикселях).
"""
import argparse, glob, os
import numpy as np, pandas as pd
from PIL import Image

ap = argparse.ArgumentParser(); ap.add_argument('--stim-dir', required=True); ap.add_argument('--out', required=True)
ap.add_argument('--skip', nargs='*', default=[], help='имена файлов, не являющихся составными стимулами')
a = ap.parse_args()

def runs(m):
    out, s = [], None
    for i, v in enumerate(m):
        if v and s is None: s = i
        if not v and s is not None: out.append((s, i)); s = None
    if s is not None: out.append((s, len(m)))
    return [r for r in out if r[1] - r[0] > 40]

rows = []
for path in sorted(glob.glob(os.path.join(a.stim_dir, '**', '*.png'), recursive=True)):
    fn = os.path.basename(path)
    if fn in a.skip: continue
    im = np.asarray(Image.open(path).convert('RGB')).astype(int)
    nonwhite = np.abs(im - 255).max(axis=2) > 12
    xs = runs(nonwhite.sum(axis=0) > 0.05 * im.shape[0] * 0.3); ys = runs(nonwhite.sum(axis=1) > 0.05 * im.shape[1] * 0.3)
    if len(xs) != 2 or len(ys) != 2:
        print('нестандартная раскладка:', fn, xs, ys); continue
    for r, (y0, y1) in enumerate(ys):
        for c, (x0, x1) in enumerate(xs):
            rows.append(dict(stimulus=fn, cell=['TL', 'TR', 'BL', 'BR'][r * 2 + c], x0=x0, y0=y0, x1=x1, y1=y1, W=im.shape[1], H=im.shape[0]))
pd.DataFrame(rows).to_csv(a.out, index=False, encoding='utf-8-sig')
print('стимулов:', len({r['stimulus'] for r in rows}))
