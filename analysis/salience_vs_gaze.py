"""Положение в сетке, баланс подбора относительно случайного и связь салиентности с взглядом по группам стимулов.

Вход (--derived): {gaze_cells.csv, saliency_cells.json, pics_saliency.json}
Группы: контрольные (все четыре картинки нейтральные), эмоциональные (все) и по категориям.
Связь «доля салиентности ячейки → доля времени взгляда»:
  • r по ячейкам (среднее по участникам) с доверительным интервалом Фишера;
  • внутриучастниковый наклон (центрирование по стимулу), среднее по участникам, t-критерий;
  • бутстреп по СТИМУЛАМ (обобщение на новые стимулы): 95 % ИС среднего наклона.
"""
import sys, os, json
import numpy as np, pandas as pd
from scipy import stats

import argparse
ap = argparse.ArgumentParser(); ap.add_argument('--derived', required=True); ap.add_argument('--exclude', default='person_7.png'); a = ap.parse_args()
D = a.derived
EXCL = a.exclude
rng = np.random.default_rng(2026)

gz = pd.read_csv(os.path.join(D, 'gaze_cells.csv'), encoding='utf-8-sig')
gz = gz[gz.stimulus != EXCL]
print('пустых (нет фиксаций в картинках) участник×стимул:', gz[gz.share_gaze.isna()].groupby(['pid','stimulus']).ngroups)
gz = gz.dropna(subset=['share_gaze'])
sal = pd.DataFrame(json.load(open(os.path.join(D, 'saliency_cells.json'), encoding='utf-8')))
sal['cell'] = sal['cell'].map({'R1C1': 'TL', 'R1C2': 'TR', 'R2C1': 'BL', 'R2C2': 'BR'}); sal = sal.rename(columns={'file': 'stimulus'})
sal = sal[sal.stimulus != EXCL]
cat = lambda s: s.replace('.png', '').rsplit('_', 1)[0]
aoi_path = os.path.join(D, 'aoi_table.csv')
if os.path.exists(aoi_path):  # разметка автора: тип стимула и категория из таблицы областей интереса
    at = pd.read_csv(aoi_path, encoding='utf-8-sig').drop_duplicates('stimulus')
    label = {r.stimulus + '.png': (('control_' if r.stimulus_type == 'control' else '') + r.category) for r in at.itertuples()}
    cat = lambda s: label[s if s.endswith('.png') else s + '.png']
gz['category'] = gz.stimulus.map(cat); sal['category'] = sal.stimulus.map(cat)
cells = ['TL', 'TR', 'BL', 'BR']
print('Стимулов:', gz.stimulus.nunique(), '| участников:', gz.pid.nunique(), '| категории:', gz.drop_duplicates('stimulus').category.value_counts().to_dict())

# ---------- позиции ----------
print('\n[1] Позиция в сетке (n участников = %d)' % gz.pid.nunique())
pos = gz.groupby('cell')['share_gaze'].mean().reindex(cells) * 100
pf = gz.groupby(['pid', 'cell'])['share_gaze'].mean().unstack()[cells]
chi, p = stats.friedmanchisquare(*[pf[c].values for c in cells])
n_ps = gz.drop_duplicates(['pid', 'stimulus']).shape[0]
first = (gz.groupby('cell')['first'].sum() / n_ps * 100).reindex(cells)
print('доля времени взгляда, %:', pos.round(1).to_dict(), f'| Фридман χ²(3)={chi:.2f}, p={p:.3f}')
print('первая фиксация, %:', first.round(1).to_dict())
shp = sal.assign(pos=sal.cell).pivot_table(index='method', columns='pos', values='share', aggfunc='mean')[cells].round(1)
print('доля салиентности по позициям, %:\n', shp.to_string())

# ---------- связь салиентность → взгляд ----------
def analyse(g_gz, g_sal, method):
    s = g_sal[g_sal.method == method][['stimulus', 'cell', 'share']]
    d = g_gz.merge(s, on=['stimulus', 'cell'])
    d['sal_c'] = d['share'] - d.groupby(['pid', 'stimulus'])['share'].transform('mean')
    d['gz_c'] = d['share_gaze'] * 100 - d.groupby(['pid', 'stimulus'])['share_gaze'].transform('mean') * 100
    # r по ячейкам (среднее по участникам)
    m = d.groupby(['stimulus', 'cell']).agg(sal=('share', 'first'), gz=('share_gaze', 'mean')).reset_index()
    m['gz'] *= 100
    r, pr = stats.pearsonr(m.sal, m.gz); n = len(m)
    z = np.arctanh(r); se = 1 / np.sqrt(n - 3); lo, hi = np.tanh(z - 1.96 * se), np.tanh(z + 1.96 * se)
    # внутриучастниковые наклоны
    sl = d.groupby('pid').apply(lambda t: np.polyfit(t.sal_c, t.gz_c, 1)[0], include_groups=False)
    t_, pt = stats.ttest_1samp(sl, 0)
    # бутстреп по стимулам
    stims = d.stimulus.unique(); boots = []
    byst = {st: t for st, t in d.groupby('stimulus')}
    for _ in range(1000):
        pick = rng.choice(stims, len(stims))
        t = pd.concat([byst[s_] for s_ in pick]);
        boots.append(np.polyfit(t.sal_c, t.gz_c, 1)[0])
    # доля стимулов, где самая салиентная ячейка = самая рассматриваемая
    hit = m.groupby('stimulus').apply(lambda t: t.loc[t.sal.idxmax(), 'cell'] == t.loc[t.gz.idxmax(), 'cell'], include_groups=False)
    return dict(n_stim=len(stims), n_cells=n, r=r, r_lo=lo, r_hi=hi, p_r=pr, slope=sl.mean(), slope_p=pt,
                boot_lo=np.quantile(boots, .025), boot_hi=np.quantile(boots, .975), hit=hit.mean(), n_hit=int(hit.sum()))

groups = {
    'контрольные (все 4 нейтральные)': lambda c: c.startswith('control'),
    'эмоциональные (все)': lambda c: not c.startswith('control'),
    'эмоц.: один человек (person)': lambda c: c == 'person',
    'эмоц.: группы людей (group)': lambda c: c == 'group',
    'эмоц.: животные (animals)': lambda c: c == 'animals',
    'эмоц.: объекты (subjects)': lambda c: c == 'subjects',
}
rows = []
for gname, f in groups.items():
    g_gz = gz[gz.category.map(f)]; g_sal = sal[sal.category.map(f)]
    for method in ['ft', 'dog', 'local', 'sr']:
        res = analyse(g_gz, g_sal, method); res.update(group=gname, method=method); rows.append(res)
R = pd.DataFrame(rows)
R.to_csv(os.path.join(D, 'salience_gaze_by_group.csv'), index=False, encoding='utf-8-sig')
print('\n[2] Связь доли салиентности и доли времени взгляда (наклон: п.п. взгляда на 1 п.п. салиентности)')
for method in ['ft', 'dog', 'local', 'sr']:
    print(f'\n  метод {method}')
    for _, r in R[R.method == method].iterrows():
        print(f"   {r.group:34s} стимулов {r.n_stim:2d}, ячеек {r.n_cells:3d} | r = {r.r:5.2f} [{r.r_lo:5.2f}; {r.r_hi:5.2f}] p = {r.p_r:.3f} | наклон {r.slope:5.2f} (p по участникам {r.slope_p:.4f}), бутстреп по стимулам [{r.boot_lo:5.2f}; {r.boot_hi:5.2f}] | совпадение макс.: {r.n_hit}/{r.n_stim}")

# ---------- баланс подбора (без person_7) ----------
pics = pd.DataFrame(json.load(open(os.path.join(D, 'pics_saliency.json'), encoding='utf-8')))
pics = pics[~pics.pic.str.startswith('person_7__')]
pics['stim'] = pics['pic'].str.rsplit('__', n=1).str[0]; pics['cell'] = pics['pic'].str.rsplit('__', n=1).str[1]
out = []
for method in ['ft', 'dog', 'local', 'sr']:
    for metric in ['mean', 'spread_pct', 'entropy', 'center_bias', 'peak']:
        d = pics[pics.method == method].sort_values(['stim', 'cell']).reset_index(drop=True)
        v = d[metric].astype(float).values
        if metric == 'peak': v = np.log(v)
        z = (v - v.mean()) / v.std(ddof=0)
        groups_ = d.groupby('stim').indices; idx = np.array([groups_[s] for s in sorted(groups_)])
        obs = z[idx].std(axis=1, ddof=0).mean()
        null = np.array([z[rng.permutation(len(z)).reshape(idx.shape)].std(axis=1, ddof=0).mean() for _ in range(10000)])
        out.append(dict(method=method, metric=metric, ratio=round(obs / null.mean(), 3), p_better=round((null <= obs).mean(), 3), p05_ratio=round(np.quantile(null, .05) / null.mean(), 3)))
B = pd.DataFrame(out); B.to_csv(os.path.join(D, 'balance_vs_random_no_p7.csv'), index=False, encoding='utf-8-sig')
print('\n[3] Баланс подбора без person_7 (отношение разброса к случайному; p односторонний), стимулов:', pics.stim.nunique())
print(B.pivot(index='metric', columns='method', values='ratio').to_string())
print(B.pivot(index='metric', columns='method', values='p_better').to_string())
print('5-й процентиль случайного распределения / его среднее: от', B.p05_ratio.min(), 'до', B.p05_ratio.max())
