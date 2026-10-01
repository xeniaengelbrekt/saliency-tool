"""Доля времени фиксаций по четырём ячейкам каждого составного стимула.

Вход: fixations_saccades.csv («Нейробюро», разделитель «;»; колонки result_name, stimulus, type, x_px, y_px, dur_sec) и cells.csv (extract_cells.py).
Запуск: python gaze_cells.py --fixations fixations_saccades.csv --cells cells.csv --out gaze_cells.csv [--min-stimuli 47]
Правило включения участников задаётся до анализа: полными считаются записи, где фиксации есть не менее чем на --min-stimuli составных стимулах.
Фиксация относится к ячейке, если её центр лежит внутри ячейки; фиксации на белых полях не учитываются.
"""
import argparse
import numpy as np, pandas as pd

ap = argparse.ArgumentParser()
ap.add_argument('--fixations', required=True); ap.add_argument('--cells', required=True); ap.add_argument('--out', required=True)
ap.add_argument('--min-stimuli', type=int, default=47)
ap.add_argument('--skip', nargs='*', default=['__baseline', 'Слайд6.png', 'thenks.png'], help='стимулы, не являющиеся составными')
a = ap.parse_args()

fx = pd.read_csv(a.fixations, sep=';', encoding='utf-8-sig')
cells = pd.read_csv(a.cells, encoding='utf-8-sig').drop_duplicates(['stimulus', 'cell'])
# латинские и кириллические двойники в кодах участников приводим к одному написанию
norm = str.maketrans({'A': 'А', 'B': 'В', 'C': 'С', 'E': 'Е', 'H': 'Н', 'K': 'К', 'M': 'М', 'O': 'О', 'P': 'Р', 'T': 'Т', 'X': 'Х'})
fx['pid'] = fx['result_name'].astype(str).str.translate(norm)
f = fx[(fx.type == 'fixation') & (~fx.stimulus.isin(a.skip))].copy()
per = f.groupby('pid')['stimulus'].nunique()
complete = per[per >= a.min_stimuli].index
print('участников:', per.size, '| полных:', len(complete))
f = f[f.pid.isin(complete)]

rects = {s: g.set_index('cell')[['x0', 'y0', 'x1', 'y1']] for s, g in cells.groupby('stimulus')}
names = ['TL', 'TR', 'BL', 'BR']
out = []
for (pid, st), g in f.groupby(['pid', 'stimulus']):
    if st not in rects: continue
    r = rects[st]; x, y, d = g['x_px'].values, g['y_px'].values, g['dur_sec'].values
    inside = np.zeros((len(g), 4), bool)
    for k, c in enumerate(names):
        q = r.loc[c]; inside[:, k] = (x >= q.x0) & (x < q.x1) & (y >= q.y0) & (y < q.y1)
    tot = (d[:, None] * inside).sum()
    first = int(np.argmax(inside[np.argmax(inside.any(axis=1))])) if inside.any() else -1
    for k, c in enumerate(names):
        out.append(dict(pid=pid, stimulus=st, cell=c, dwell=float((d * inside[:, k]).sum()), dwell_total_in_cells=float(tot),
                        share_gaze=float((d * inside[:, k]).sum() / tot) if tot > 0 else np.nan, n_fix=int(inside[:, k].sum()),
                        first=int(first == k), outside_share=float(1 - tot / d.sum()) if d.sum() > 0 else np.nan))
gz = pd.DataFrame(out); gz.to_csv(a.out, index=False, encoding='utf-8-sig')
print('строк:', len(gz), '| доля времени вне картинок: %.1f %%' % (100 * gz.drop_duplicates(['pid', 'stimulus'])['outside_share'].mean()))
