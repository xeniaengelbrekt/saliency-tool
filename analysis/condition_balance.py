"""Баланс условий по позициям и салиентности по условиям (эмоциональные стимулы).

Запуск: python condition_balance.py --derived DIR
Вход: cell_conditions.csv, saliency_cells.json. Выход в консоль: таблица условие × позиция (χ²) и средние доли салиентности
по условиям для каждого метода (перестановка условий внутри изображения, 5000 перестановок, статистика — размах средних).
"""
import argparse, json, os
import numpy as np, pandas as pd
from scipy import stats

ap = argparse.ArgumentParser(); ap.add_argument('--derived', required=True); ap.add_argument('--exclude', nargs='*', default=['person_7'])
a = ap.parse_args(); rng = np.random.default_rng(1)
tab = pd.read_csv(os.path.join(a.derived, 'cell_conditions.csv'), encoding='utf-8-sig'); em = tab[tab.kind == 'emotional']
ct = pd.crosstab(em.cond, em.cell)[['TL', 'TR', 'BL', 'BR']]; chi, p, dof, _ = stats.chi2_contingency(ct)
print('условие × позиция (число ячеек):'); print(ct.to_string()); print('χ²(%d) = %.2f, p = %.3f' % (dof, chi, p))
sal = pd.DataFrame(json.load(open(os.path.join(a.derived, 'saliency_cells.json'), encoding='utf-8')))
sal['cell'] = sal.cell.map({'R1C1': 'TL', 'R1C2': 'TR', 'R2C1': 'BL', 'R2C2': 'BR'}); sal['stim'] = sal.file.str.replace('.png', '', regex=False)
print('\nсредняя доля салиентности ячейки по условиям, % (p — перестановочный):')
for m in ['ft', 'dog', 'local', 'sr']:
    d = sal[sal.method == m].merge(em, on=['stim', 'cell'])
    def stat(x): g = x.groupby('cond').share.mean(); return g.max() - g.min()
    obs = stat(d); null = []
    for _ in range(5000):
        dd = d.copy(); dd['cond'] = dd.groupby('stim').cond.transform(lambda s: rng.permutation(s.values)); null.append(stat(dd))
    print(m, d.groupby('cond').share.mean().round(1).to_dict(), 'размах %.1f, p = %.4f' % (obs, (np.array(null) >= obs).mean()))
