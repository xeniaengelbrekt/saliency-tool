"""Таблица «область интереса → положение, условие, категория» по экспорту геометрии AOI из «Нейробюро».

Запуск: python aoi_table.py --geometry aoi_geometry.csv --out-dir DIR [--control-extra person_3]
Выход (в DIR): aoi_table.csv (все характеристики), cells_aoi.csv (для gaze_cells.py), cell_conditions.csv (для condition_effects.py).
Положение определяется по центру области (верх/низ — по середине экрана по вертикали, лево/право — по горизонтали).
Условие задаётся порядком имён областей в стимуле: «AOI 1» — нейтральное, «(копия)» — положительное,
«(копия) (копия)» — дисфорическое, «(копия) (копия) (копия)» — угрожающее. Контрольные стимулы (имя начинается с control_
и перечисленные в --control-extra) нейтральны во всех областях.
"""
import argparse, os
import numpy as np, pandas as pd

ap = argparse.ArgumentParser()
ap.add_argument('--geometry', required=True); ap.add_argument('--out-dir', required=True)
ap.add_argument('--control-extra', nargs='*', default=['person_3'], help='стимулы, которые контрольные, несмотря на имя')
ap.add_argument('--exclude', nargs='*', default=['person_7'])
a = ap.parse_args()

g = pd.read_csv(a.geometry, sep=';', encoding='utf-8-sig')
g['stim'] = g.stimulus.str.replace('.png', '', regex=False)
g = g[~g.stim.isin(a.exclude)].copy()
order = {'AOI 1': 0, 'AOI 1 (копия)': 1, 'AOI 1 (копия) (копия)': 2, 'AOI 1 (копия) (копия) (копия)': 3}
g['ord'] = g.aoi_name.map(order); assert g.ord.notna().all(), 'неожиданное имя области'
sw, sh = g.stimulus_width_px.iloc[0], g.stimulus_height_px.iloc[0]
g['position'] = np.where(g.y_px + g.height_px / 2 < sh / 2, 'T', 'B') + np.where(g.x_px + g.width_px / 2 < sw / 2, 'L', 'R')
assert (g.groupby('stim').position.nunique() == 4).all(), 'в стимуле не 4 разных положения'
g['is_control'] = g.stim.str.startswith('control_') | g.stim.isin(a.control_extra)
g['condition'] = np.where(g.is_control, 'neutral', np.array(['neutral', 'positive', 'dysphoric', 'threatening'])[g.ord.values])
g['stimulus_type'] = np.where(g.is_control, 'control', 'emotional')
g['category'] = g.stim.map(lambda s: s.replace('control_', '').rsplit('_', 1)[0] if s not in a.control_extra else s.rsplit('_', 1)[0])
g['category_ru'] = g.category.map({'subjects': 'предметы', 'animals': 'животные', 'person': 'один человек', 'group': 'группа людей'})
g['aoi_order'] = g.ord + 1
out = g[['stim', 'stimulus_id', 'aoi_name', 'aoi_order', 'position', 'condition', 'stimulus_type', 'category', 'category_ru',
         'x_px', 'y_px', 'width_px', 'height_px']].rename(columns={'stim': 'stimulus'})
out = out.sort_values(['stimulus_type', 'category', 'stimulus', 'position']).reset_index(drop=True)
os.makedirs(a.out_dir, exist_ok=True)
out.to_csv(os.path.join(a.out_dir, 'aoi_table.csv'), index=False, encoding='utf-8-sig')
out.assign(stimulus=out.stimulus + '.png', cell=out.position, x0=out.x_px, y0=out.y_px, x1=out.x_px + out.width_px, y1=out.y_px + out.height_px)[
    ['stimulus', 'cell', 'x0', 'y0', 'x1', 'y1']].to_csv(os.path.join(a.out_dir, 'cells_aoi.csv'), index=False, encoding='utf-8-sig')
out.assign(stim=out.stimulus, cell=out.position, cond=out.condition.map({'neutral': '0', 'positive': 'П', 'threatening': 'У', 'dysphoric': 'Д'}),
           kind=out.stimulus_type)[['stim', 'cell', 'cond', 'kind']].to_csv(os.path.join(a.out_dir, 'cell_conditions.csv'), index=False, encoding='utf-8-sig')
print('стимулов:', out.stimulus.nunique(), '| контрольных:', out[out.stimulus_type == 'control'].stimulus.nunique())
print(out.drop_duplicates('stimulus').groupby(['stimulus_type', 'category_ru']).size().to_string())
