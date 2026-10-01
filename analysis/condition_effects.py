"""Эффект эмоционального условия на долю взгляда до и после поправки на салиентность.

Смешанная модель (statsmodels MixedLM, перекрёстные случайные свободные члены участника и изображения):
    g ~ позиция + условие + (доля салиентности − 25),  g — доля времени взгляда в ячейке, %.
Вход (всё в --derived): gaze_cells.csv (gaze_cells.py), saliency_cells.json (инструмент, режим «составной стимул»),
cell_conditions.csv (колонки stim, cell, cond, kind; cond: '0' нейтральное, 'П', 'У', 'Д'; kind: control | emotional).
Запуск: python condition_effects.py --derived DIR [--exclude person_7]
"""
import argparse, json, os, warnings
import numpy as np, pandas as pd
import statsmodels.formula.api as smf

ap = argparse.ArgumentParser()
ap.add_argument('--derived', required=True)
ap.add_argument('--exclude', nargs='*', default=['person_7'])
a = ap.parse_args()
warnings.filterwarnings('ignore')
D = a.derived

tab = pd.read_csv(os.path.join(D, 'cell_conditions.csv'), encoding='utf-8-sig')
gz = pd.read_csv(os.path.join(D, 'gaze_cells.csv'), encoding='utf-8-sig').dropna(subset=['share_gaze'])
gz['stim'] = gz.stimulus.str.replace('.png', '', regex=False)
gz = gz[~gz.stim.isin(a.exclude)].merge(tab, on=['stim', 'cell'])
gz['g'] = gz.share_gaze * 100
em = gz[gz.kind == 'emotional'].copy()
sal = pd.DataFrame(json.load(open(os.path.join(D, 'saliency_cells.json'), encoding='utf-8')))
sal['cell'] = sal.cell.map({'R1C1': 'TL', 'R1C2': 'TR', 'R2C1': 'BL', 'R2C2': 'BR'})
sal['stim'] = sal.file.str.replace('.png', '', regex=False)

rows = []
for method in ['none', 'ft', 'dog', 'local', 'sr']:
    d = em.copy()
    f = "g ~ C(cell) + C(cond, Treatment('0'))"
    if method != 'none':
        s = sal[sal.method == method][['stim', 'cell', 'share']]
        d = d.merge(s, on=['stim', 'cell']); d['sal'] = d.share - 25
        f += ' + sal'
    d['one'] = 1
    m = smf.mixedlm(f, d, groups='one', re_formula='0',
                    vc_formula={'pid': '0 + C(pid)', 'stim': '0 + C(stim)'}).fit(reml=True, method='lbfgs')
    ci = m.conf_int()
    r = {'поправка': method, 'n_наблюдений': int(m.nobs)}
    for c in ['У', 'Д', 'П']:
        k = f"C(cond, Treatment('0'))[T.{c}]"
        r[c] = f"{m.params[k]:+.2f} [{ci.loc[k, 0]:+.2f}; {ci.loc[k, 1]:+.2f}] p={m.pvalues[k]:.3f}"
    if method != 'none':
        r['γ'] = f"{m.params['sal']:.2f} [{ci.loc['sal', 0]:.2f}; {ci.loc['sal', 1]:.2f}] p={m.pvalues['sal']:.3f}"
    rows.append(r)
pd.set_option('display.width', 300, 'display.max_colwidth', 80)
R = pd.DataFrame(rows)
print(R.to_string(index=False))
R.to_csv(os.path.join(D, 'condition_effects_mixed.csv'), index=False, encoding='utf-8-sig')

# ---- совместная МНК-модель с бутстрепом по изображениям (интервалы без допущений смешанной модели) ----
rng = np.random.default_rng(2026)
print('\nМНК (совместно позиция + условие + салиентность), 95 % бутстреп по изображениям, 1000 повторов')
stims = em.stim.unique()
rows = []
for method in ['none', 'ft', 'dog', 'local', 'sr']:
    d = em.copy()
    if method != 'none':
        s = sal[sal.method == method][['stim', 'cell', 'share']]
        d = d.merge(s, on=['stim', 'cell']); d['sal'] = d.share - 25
    cols = [np.ones(len(d))] + [(d.cell == c).astype(float).values for c in ['TR', 'BL', 'BR']] + \
           [(d.cond == c).astype(float).values for c in ['У', 'Д', 'П']] + ([d.sal.values] if method != 'none' else [])
    X = np.column_stack(cols); y = d.g.values
    idx = {s_: np.where(d.stim.values == s_)[0] for s_ in stims}
    est = np.linalg.lstsq(X, y, rcond=None)[0]
    boots = []
    for _ in range(1000):
        ii = np.concatenate([idx[s_] for s_ in rng.choice(stims, len(stims))])
        boots.append(np.linalg.lstsq(X[ii], y[ii], rcond=None)[0])
    boots = np.array(boots); lo, hi = np.quantile(boots, .025, axis=0), np.quantile(boots, .975, axis=0)
    r = {'поправка': method}
    for k, c in zip([4, 5, 6], ['У', 'Д', 'П']):
        r[c] = f"{est[k]:+.2f} [{lo[k]:+.2f}; {hi[k]:+.2f}]"
    if method != 'none': r['γ'] = f"{est[7]:.2f} [{lo[7]:.2f}; {hi[7]:.2f}]"
    rows.append(r)
R2 = pd.DataFrame(rows); print(R2.to_string(index=False))
R2.to_csv(os.path.join(D, 'condition_effects_ols_boot.csv'), index=False, encoding='utf-8-sig')
