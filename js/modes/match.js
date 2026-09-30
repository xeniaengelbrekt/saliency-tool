/* ============================================================
   modes/match.js — Режим 3: подбор групп
   2-4 группы изображений → поиск комбинаций (по одному из каждой)
   с минимальной дисперсией выбранных метрик; K непересекающихся
   наборов + ANOVA-проверка баланса между группами.
   ============================================================ */

import { loadImageFiles } from '../loader.js';
import { computeSaliency } from '../algorithms/index.js';
import { computeMetrics, formatMetric } from '../metrics.js';
import { renderHeatmap, renderOverlay, canvasToBlob } from '../render.js';
import { getSettings, onSettingsChange } from '../app.js';
import { downloadCSV, downloadZip, stripExt } from '../export.js';
import { toastError, toastSuccess } from '../toast.js';
import { meanOf, sdOf, oneWayAnova, formatP } from '../stats.js';

const MIN_GROUPS = 2;
const MAX_GROUPS = 4;
const TOP_N = 5;
const CHUNK_SIZE = 5000;   // комбинаций за итерацию (RAF-нонблокинг)

const match = {
  groups: [],         // [{ id, name, items: [{ id, loaded, sal, metrics }] }]
  results: [],        // [{ rank, cost, variance, mean, range, items: [item, ...], groups }]
  anova: null,        // результаты ANOVA для K > 1
  criteria: ['mean'],
  k: 1,
  busy: false,
  nextGroupId: 1,
  nextItemId: 1,
};

const dom = {};

export function initMatchMode() {
  cacheDom();
  bindEvents();
  // Стартуем с двумя группами по умолчанию
  addGroup();
  addGroup();
  renderGroups();
  updateToolbar();
  onSettingsChange(handleSettingsChange);
}

function cacheDom() {
  dom.addGroup   = document.getElementById('match-add-group');
  dom.findBtn    = document.getElementById('match-find');
  dom.groupsBox  = document.getElementById('match-groups');
  dom.results    = document.getElementById('match-results');
  dom.combos     = document.getElementById('match-combos');
  dom.dlCsv      = document.getElementById('match-dl-csv');
  dom.busy       = document.getElementById('match-busy');
  dom.progress   = document.getElementById('match-progress');
  dom.info       = document.getElementById('match-info');
  dom.k          = document.getElementById('match-k');
  dom.crit       = document.querySelectorAll('#mode-match .match-crit');
  dom.resTitle   = document.getElementById('match-res-title');
  dom.resSub     = document.getElementById('match-res-sub');
  dom.stats      = document.getElementById('match-stats');
}

function bindEvents() {
  dom.addGroup.addEventListener('click', () => {
    if (match.groups.length >= MAX_GROUPS) return;
    addGroup();
    renderGroups();
    updateToolbar();
  });
  dom.findBtn.addEventListener('click', findCombinations);
  dom.dlCsv.addEventListener('click', exportMatchCSV);
  dom.k?.addEventListener('change', () => { hideResults(); updateToolbar(); });
  dom.crit?.forEach((c) => c.addEventListener('change', hideResults));
}

/* ============================================================
   Управление группами
   ============================================================ */

function addGroup() {
  if (match.groups.length >= MAX_GROUPS) return;
  const id = match.nextGroupId++;
  match.groups.push({
    id,
    name: `Группа ${match.groups.length + 1}`,
    items: [],
  });
}

function removeGroup(groupId) {
  if (match.groups.length <= MIN_GROUPS) return;
  match.groups = match.groups.filter((g) => g.id !== groupId);
  // Перенумеруем дефолтные имена, если они не были переименованы
  match.groups.forEach((g, i) => {
    if (/^Группа \d+$/.test(g.name)) g.name = `Группа ${i + 1}`;
  });
  hideResults();
  renderGroups();
  updateToolbar();
}

function removeGroupItem(groupId, itemId) {
  const g = match.groups.find((x) => x.id === groupId);
  if (!g) return;
  g.items = g.items.filter((it) => it.id !== itemId);
  hideResults();
  renderGroups();
  updateToolbar();
}

async function handleGroupFiles(groupId, files) {
  const g = match.groups.find((x) => x.id === groupId);
  if (!g) return;
  setBusy(true, 'Загрузка изображений…');
  const { ok, errors } = await loadImageFiles(files);
  if (errors.length) {
    toastError(`Не удалось загрузить ${errors.length} из ${files.length} файлов`);
    for (const err of errors) console.warn(err.message);
  }

  const settings = getSettings();
  const total = ok.length;
  for (let i = 0; i < total; i++) {
    setBusy(true, `Группа: ${g.name} · вычисление…`, `${i + 1} / ${total}`);
    await new Promise((r) => setTimeout(r, 0));
    const loaded = ok[i];
    const sal = computeSaliency(loaded.imageData, settings.method);
    const metrics = computeMetrics(sal);
    g.items.push({
      id: match.nextItemId++,
      loaded,
      sal,
      metrics,
    });
  }
  hideResults();
  renderGroups();
  updateToolbar();
  setBusy(false);
}

/* ============================================================
   Рендер групп
   ============================================================ */

function renderGroups() {
  dom.groupsBox.innerHTML = '';
  match.groups.forEach((g, idx) => {
    const card = document.createElement('div');
    card.className = 'group-card';
    card.dataset.groupId = String(g.id);

    card.innerHTML = `
      <header class="group-head">
        <span class="group-num">${String(idx + 1).padStart(2, '0')}</span>
        <input class="group-name" type="text" value="${escapeAttr(g.name)}" />
        <span class="group-count">${g.items.length} файл${pluralFile(g.items.length)}</span>
        <button class="group-remove" title="Удалить группу" ${match.groups.length <= MIN_GROUPS ? 'disabled' : ''}>×</button>
      </header>

      <div class="group-load">
        <input type="file" multiple accept="image/jpeg,image/png,image/webp,image/bmp" hidden>
        <button class="btn btn-ghost btn-block" data-act="upload">+ Загрузить изображения</button>
      </div>

      <div class="group-items">
        ${g.items.length ? '' : '<div class="group-empty">Файлы не добавлены</div>'}
      </div>
    `;

    // Имя группы
    const nameInp = card.querySelector('.group-name');
    nameInp.addEventListener('change', () => {
      g.name = nameInp.value.trim() || `Группа ${idx + 1}`;
    });

    // Удалить группу
    card.querySelector('.group-remove').addEventListener('click', () => removeGroup(g.id));

    // Загрузка файлов
    const fileInp = card.querySelector('input[type="file"]');
    const uploadBtn = card.querySelector('[data-act="upload"]');
    uploadBtn.addEventListener('click', () => fileInp.click());
    fileInp.addEventListener('change', () => {
      if (fileInp.files && fileInp.files.length) {
        handleGroupFiles(g.id, [...fileInp.files]);
      }
      fileInp.value = '';
    });

    // Список items
    const itemsBox = card.querySelector('.group-items');
    g.items.forEach((it) => {
      const row = document.createElement('div');
      row.className = 'group-item';
      row.innerHTML = `
        <img class="group-item-thumb" src="${it.loaded.thumb}" alt="">
        <div class="group-item-info">
          <span class="group-item-name" title="${escapeAttr(it.loaded.name)}">${escapeHtml(it.loaded.name)}</span>
          <span class="group-item-mean">μ <strong>${it.metrics ? formatMetric('mean', it.metrics.mean) : '—'}</strong></span>
        </div>
        <button class="group-item-remove" title="Удалить">×</button>
      `;
      row.querySelector('.group-item-remove').addEventListener('click', () => removeGroupItem(g.id, it.id));
      itemsBox.appendChild(row);
    });

    dom.groupsBox.appendChild(card);
  });
}

function updateToolbar() {
  dom.info.textContent = `${match.groups.length} групп${pluralGroup(match.groups.length)}`;
  dom.addGroup.disabled = match.groups.length >= MAX_GROUPS;

  const allHaveItems = match.groups.length >= MIN_GROUPS &&
                       match.groups.every((g) => g.items.length > 0);
  dom.findBtn.disabled = !allHaveItems;

  const totalItems = match.groups.reduce((s, g) => s + g.items.length, 0);
  if (totalItems > 0) {
    const product = match.groups.reduce((p, g) => p * g.items.length, 1);
    dom.findBtn.textContent = `Найти лучшие комбинации · ${product.toLocaleString('ru-RU')} вариант${pluralVar(product)}`;
  } else {
    dom.findBtn.textContent = 'Найти лучшие комбинации';
  }
}

/* ============================================================
   Поиск комбинаций

   Критерий: сумма дисперсий выбранных метрик внутри комбинации,
   где каждая метрика предварительно z-нормирована по всем
   загруженным изображениям (иначе метрики в разных единицах —
   доли, проценты, биты — нельзя складывать).
   При одном критерии mean порядок комбинаций совпадает
   с «минимальной дисперсией средней салиентности».

   K = 1 → топ-5 альтернативных комбинаций (могут пересекаться).
   K > 1 → K НЕПЕРЕСЕКАЮЩИХСЯ наборов жадным алгоритмом: лучший
           набор, его изображения исключаются, поиск повторяется.
           Жадный подбор не гарантирует глобального оптимума
           разбиения, но каждый следующий набор — лучший из оставшихся.
           После подбора — однофакторный ANOVA по группам.
   ============================================================ */

const CRITERIA = ['mean', 'spread_pct', 'entropy', 'center_bias'];

function readOptions() {
  const k = Math.max(1, Math.min(50, parseInt(dom.k?.value, 10) || 1));
  const crit = [...(dom.crit || [])].filter((c) => c.checked).map((c) => c.value);
  return { k, criteria: crit.length ? crit : ['mean'] };
}

/** z-параметры каждой метрики по всем изображениям всех групп. */
function zParams(arrays, criteria) {
  const all = arrays.flat();
  const out = {};
  for (const key of criteria) {
    const vals = all.map((it) => it.metrics[key]);
    const m = meanOf(vals);
    const s = vals.length > 1 ? sdOf(vals) : 0;
    out[key] = { m, s: s > 0 ? s : 1 };
  }
  return out;
}

async function findCombinations() {
  const groups = match.groups.filter((g) => g.items.length > 0);
  if (groups.length < MIN_GROUPS) return;

  const { k, criteria } = readOptions();
  const arrays = groups.map((g) => g.items.filter((it) => it.metrics));
  if (arrays.some((arr) => arr.length === 0)) return;

  const minSize = Math.min(...arrays.map((a) => a.length));
  if (k > minSize) {
    toastError(`Нельзя подобрать ${k} непересекающихся наборов: в самой маленькой группе ${minSize} изображени${minSize === 1 ? 'е' : 'й'}.`);
    return;
  }

  const z = zParams(arrays, criteria);
  // Кэш z-векторов: item.id → Float64Array по критериям
  const zvec = new Map();
  for (const it of arrays.flat()) {
    zvec.set(it.id, Float64Array.from(criteria.map((key) => (it.metrics[key] - z[key].m) / z[key].s)));
  }

  const used = new Set();
  const results = [];

  for (let round = 0; round < k; round++) {
    const pools = arrays.map((arr) => arr.filter((it) => !used.has(it.id)));
    const keep = k === 1 ? TOP_N : 1;
    const top = await searchBest(pools, zvec, criteria.length, keep,
      k === 1 ? 'Поиск комбинаций…' : `Набор ${round + 1} из ${k}…`);
    if (!top.length) break;
    if (k === 1) {
      results.push(...top);
    } else {
      results.push(top[0]);
      for (const it of top[0].combo) used.add(it.id);
    }
  }

  match.criteria = criteria;
  match.k = k;
  match.results = results.map((entry, idx) => ({
    rank: idx + 1,
    cost: entry.cost,
    variance: computeVariance(entry.combo.map((it) => it.metrics.mean)),
    mean: avg(entry.combo.map((it) => it.metrics.mean)),
    range: [
      Math.min(...entry.combo.map((it) => it.metrics.mean)),
      Math.max(...entry.combo.map((it) => it.metrics.mean)),
    ],
    items: entry.combo,
    groups,
  }));
  match.anova = k > 1 ? computeAnova(groups.length) : null;

  setBusy(false);
  renderResults();
  const total = arrays.reduce((p, arr) => p * arr.length, 1);
  toastSuccess(k === 1
    ? `Проверено ${total.toLocaleString('ru-RU')} комбинаций · показаны лучшие ${match.results.length}`
    : `Подобрано ${match.results.length} непересекающихся наборов`);
}

/**
 * Полный перебор декартова произведения pools. Возвращает keep лучших
 * записей {combo, cost} по возрастанию cost. Нон-блокирующими порциями.
 */
async function searchBest(pools, zvec, nCrit, keep, label) {
  const N = pools.length;
  if (pools.some((p) => !p.length)) return [];
  const total = pools.reduce((p, arr) => p * arr.length, 1);
  const zs = pools.map((arr) => arr.map((it) => zvec.get(it.id)));
  const indices = new Array(N).fill(0);
  const top = [];
  let processed = 0;
  let done = false;
  const sum = new Float64Array(nCrit);
  const sq = new Float64Array(nCrit);

  setBusy(true, label, `0 / ${total.toLocaleString('ru-RU')}`);
  while (!done) {
    let chunk = 0;
    while (chunk < CHUNK_SIZE && !done) {
      sum.fill(0); sq.fill(0);
      for (let g = 0; g < N; g++) {
        const v = zs[g][indices[g]];
        for (let c = 0; c < nCrit; c++) { sum[c] += v[c]; sq[c] += v[c] * v[c]; }
      }
      // Σ по критериям популяционной дисперсии внутри комбинации
      let cost = 0;
      for (let c = 0; c < nCrit; c++) {
        const m = sum[c] / N;
        cost += sq[c] / N - m * m;
      }
      if (top.length < keep || cost < top[top.length - 1].cost) {
        const combo = indices.map((ix, g) => pools[g][ix]);
        considerForTop(top, { combo, cost }, keep);
      }
      processed++;
      chunk++;

      let i = N - 1;
      while (i >= 0) {
        indices[i]++;
        if (indices[i] < pools[i].length) break;
        indices[i] = 0;
        i--;
      }
      if (i < 0) done = true;
    }
    setBusy(true, label, `${processed.toLocaleString('ru-RU')} / ${total.toLocaleString('ru-RU')}`);
    await new Promise((r) => setTimeout(r, 0));
  }
  return top;
}

/**
 * ANOVA по группам для итоговых K наборов: для каждой метрики —
 * отличаются ли группы (категории) между собой после подбора.
 */
function computeAnova(nGroups) {
  const keys = ['mean', 'spread_pct', 'entropy', 'center_bias', 'peak'];
  const out = [];
  for (const key of keys) {
    const perGroup = [];
    for (let g = 0; g < nGroups; g++) {
      perGroup.push(match.results.map((res) => res.items[g].metrics[key]));
    }
    const a = oneWayAnova(perGroup);
    out.push({
      key,
      balanced: match.criteria.includes(key),
      groupMeans: perGroup.map((vals) => meanOf(vals)),
      groupSds: perGroup.map((vals) => sdOf(vals)),
      anova: a,
    });
  }
  return out;
}

function computeVariance(arr) {
  const n = arr.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += arr[i];
  const m = sum / n;
  let v = 0;
  for (let i = 0; i < n; i++) { const d = arr[i] - m; v += d * d; }
  return v / n;
}

function avg(arr) {
  let s = 0; for (let i = 0; i < arr.length; i++) s += arr[i];
  return s / arr.length;
}

function considerForTop(top, entry, keep) {
  if (top.length < keep) {
    insertSorted(top, entry);
    return;
  }
  if (entry.cost < top[top.length - 1].cost) {
    top.pop();
    insertSorted(top, entry);
  }
}

function insertSorted(arr, entry) {
  let i = 0;
  while (i < arr.length && arr[i].cost <= entry.cost) i++;
  arr.splice(i, 0, entry);
}

/* ============================================================
   Рендер результатов
   ============================================================ */

const CRIT_LABELS = {
  mean: 'mean',
  spread_pct: 'spread',
  entropy: 'entropy',
  center_bias: 'центр/периф.',
  peak: 'peak',
};

function renderResults() {
  if (!match.results.length) {
    dom.results.hidden = true;
    return;
  }
  dom.results.hidden = false;
  const settings = getSettings();
  const multiSet = match.k > 1;
  dom.resTitle.firstChild.textContent = multiSet
    ? `${match.results.length} непересекающ${pluralSet(match.results.length)} `
    : `Топ-${match.results.length} комбинаций `;
  dom.resSub.textContent = `критерий: минимальная суммарная дисперсия z-оценок (${match.criteria.map((c) => CRIT_LABELS[c]).join(', ')})`
    + (multiSet ? ' · жадный подбор без повторов' : ' · альтернативы могут содержать одни и те же изображения');
  dom.combos.innerHTML = '';

  for (const res of match.results) {
    const card = document.createElement('div');
    card.className = `combo-card${res.rank === 1 ? ' rank-1' : ''}`;
    const extra = match.criteria.filter((c) => c !== 'mean').map((c) => {
      const vals = res.items.map((it) => it.metrics[c]);
      return `<span><span class="stat-key">${CRIT_LABELS[c]}</span><span class="stat-val">${fmt(Math.min(...vals))} … ${fmt(Math.max(...vals))}</span></span>`;
    }).join('');
    card.innerHTML = `
      <div class="combo-rank">
        <span class="combo-rank-num">#${res.rank}</span>
        <span class="combo-rank-label">${multiSet ? 'набор' : (res.rank === 1 ? 'лучшая' : 'rank')}</span>
      </div>
      <div class="combo-meta">
        <div class="combo-stat-row">
          <span><span class="stat-key">cost</span><span class="stat-val">${res.cost.toExponential(2)}</span></span>
          <span><span class="stat-key">μ̄</span><span class="stat-val">${res.mean.toFixed(4)}</span></span>
          <span><span class="stat-key">mean</span><span class="stat-val">${res.range[0].toFixed(4)} … ${res.range[1].toFixed(4)}</span></span>
          ${extra}
        </div>
        <div class="combo-items"></div>
      </div>
      <div class="combo-actions">
        <button class="btn btn-ghost" data-act="dl-zip">↓ ZIP</button>
        ${res.rank === 1 && !multiSet ? '<span class="combo-rank-label" style="text-align:center;color:var(--green)">★ best match</span>' : ''}
      </div>
    `;

    const itemsBox = card.querySelector('.combo-items');
    res.items.forEach((it, idx) => {
      const groupName = res.groups[idx].name;
      const item = document.createElement('div');
      item.className = 'combo-item';
      const thumb = document.createElement('div');
      thumb.className = 'combo-item-thumb';
      // Превью с тепловой картой 80×80
      const c = document.createElement('canvas');
      c.width = 80; c.height = 80;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(it.loaded.origImage, 0, 0, 80, 80);
      const heat = renderHeatmap(it.sal, it.sal.width, it.sal.height, 80, 80, settings.colormap, settings.alpha);
      ctx.drawImage(heat, 0, 0);
      thumb.appendChild(c);
      item.appendChild(thumb);

      const grp = document.createElement('span');
      grp.className = 'combo-item-group';
      grp.textContent = groupName;
      item.appendChild(grp);

      const nm = document.createElement('span');
      nm.className = 'combo-item-name';
      nm.title = it.loaded.name;
      nm.textContent = it.loaded.name;
      item.appendChild(nm);

      const mn = document.createElement('span');
      mn.className = 'combo-item-mean';
      mn.innerHTML = `μ <strong style="color:var(--green)">${formatMetric('mean', it.metrics.mean)}</strong>`;
      item.appendChild(mn);

      itemsBox.appendChild(item);
    });

    card.querySelector('[data-act="dl-zip"]').addEventListener('click', () => exportComboZip(res));
    dom.combos.appendChild(card);
  }

  renderAnova();
}

function renderAnova() {
  if (!dom.stats) return;
  if (!match.anova) {
    dom.stats.hidden = true;
    dom.stats.innerHTML = '';
    return;
  }
  const groups = match.results[0].groups;
  let html = `
    <h3 class="section-title">Проверка баланса между группами
      <span class="section-sub">однофакторный ANOVA по ${match.results.length} наборам · p &gt; .05 и малое η² — группы не различаются</span>
    </h3>
    <div class="data-table-wrap"><table class="data-table">
      <thead><tr>
        <th>Метрика</th>
        ${groups.map((g) => `<th>${escapeHtml(g.name)}<br>M (SD)</th>`).join('')}
        <th>F</th><th>p</th><th>η²</th>
      </tr></thead><tbody>
  `;
  for (const row of match.anova) {
    const a = row.anova;
    const warn = a && a.p < 0.05;
    html += `<tr>
      <td>${CRIT_LABELS[row.key]}${row.balanced ? ' <span title="Уравнивалась при подборе" style="color:var(--green)">●</span>' : ''}</td>
      ${row.groupMeans.map((m, i) => `<td class="num">${fmt(m)} (${fmt(row.groupSds[i])})</td>`).join('')}
      <td class="num">${a ? (a.df1 && isFinite(a.F) ? `F(${a.df1}, ${a.df2}) = ${a.F.toFixed(2)}` : '—') : '—'}</td>
      <td class="num" style="${warn ? 'color:var(--warn)' : ''}">${a ? formatP(a.p) : '—'}</td>
      <td class="num">${a ? a.eta2.toFixed(3) : '—'}</td>
    </tr>`;
  }
  html += '</tbody></table></div>';
  dom.stats.innerHTML = html;
  dom.stats.hidden = false;
}

function fmt(v) {
  if (!isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a !== 0 && (a >= 10000 || a < 0.001)) return v.toExponential(2);
  return a >= 100 ? v.toFixed(1) : a >= 10 ? v.toFixed(2) : v.toFixed(4);
}

function hideResults() {
  match.results = [];
  match.anova = null;
  dom.results.hidden = true;
  dom.combos.innerHTML = '';
  if (dom.stats) { dom.stats.hidden = true; dom.stats.innerHTML = ''; }
}

/* ============================================================
   Экспорт
   ============================================================ */

async function exportComboZip(res) {
  setBusy(true, 'Сборка ZIP комбинации…');
  const settings = getSettings();
  const entries = [];
  for (let i = 0; i < res.items.length; i++) {
    const it = res.items[i];
    const groupSafe = sanitize(res.groups[i].name);
    const { origImage, origW, origH, name } = it.loaded;
    const canvas = renderOverlay(
      origImage, it.sal,
      it.sal.width, it.sal.height,
      origW, origH,
      settings.colormap, settings.alpha
    );
    const blob = await canvasToBlob(canvas, 'image/png');
    if (blob) {
      entries.push({
        name: `${groupSafe}_${stripExt(name)}_saliency.png`,
        blob,
      });
    }
    await new Promise((r) => setTimeout(r, 0));
  }
  await downloadZip(entries, `match_rank${res.rank}.zip`);
  setBusy(false);
  toastSuccess(`Сохранено: match_rank${res.rank}.zip`);
}

function exportMatchCSV() {
  if (!match.results.length) return;
  const settings = getSettings();
  const groups = match.results[0].groups;
  const metricKeys = ['mean', 'spread_pct', 'entropy', 'center_bias', 'peak'];

  const header = ['rank', 'cost', 'mean_avg', 'mean_min', 'mean_max'];
  for (let i = 0; i < groups.length; i++) {
    header.push(`group${i + 1}_name`, `group${i + 1}_file`, ...metricKeys.map((k) => `group${i + 1}_${k}`));
  }

  const rows = [];
  rows.push(['# Saliency match · ' + new Date().toISOString()]);
  rows.push(['# method', settings.method, 'sets', match.k, 'criteria', match.criteria.join('+'),
    'mode', match.k > 1 ? 'disjoint_greedy' : 'top_alternatives']);
  rows.push([]);
  rows.push(header);
  for (const res of match.results) {
    const row = [
      res.rank,
      +res.cost.toExponential(6),
      +res.mean.toFixed(4),
      +res.range[0].toFixed(4),
      +res.range[1].toFixed(4),
    ];
    res.items.forEach((it, i) => {
      row.push(groups[i].name, it.loaded.name, ...metricKeys.map((k) => it.metrics[k]));
    });
    rows.push(row);
  }

  if (match.anova) {
    rows.push([]);
    rows.push(['ANOVA', 'balanced', ...groups.map((g) => `${g.name}_M`), ...groups.map((g) => `${g.name}_SD`), 'df1', 'df2', 'F', 'p', 'eta2']);
    for (const r of match.anova) {
      const a = r.anova;
      rows.push([r.key, r.balanced ? 1 : 0,
        ...r.groupMeans.map((v) => +v.toPrecision(6)),
        ...r.groupSds.map((v) => (isFinite(v) ? +v.toPrecision(6) : '')),
        a ? a.df1 : '', a ? a.df2 : '', a ? +a.F.toPrecision(6) : '', a ? +a.p.toPrecision(4) : '', a ? +a.eta2.toFixed(4) : '']);
    }
  }
  downloadCSV(rows, 'saliency_match.csv');
  toastSuccess('Сохранено: saliency_match.csv');
}

/* ============================================================
   Реакция на изменение настроек
   ============================================================ */

async function handleSettingsChange(_settings, changed) {
  const allItems = match.groups.flatMap((g) => g.items);
  if (!allItems.length) return;

  if (changed.method) {
    const settings = getSettings();
    setBusy(true, 'Пересчёт групп…', `0 / ${allItems.length}`);
    for (let i = 0; i < allItems.length; i++) {
      setBusy(true, 'Пересчёт групп…', `${i + 1} / ${allItems.length}`);
      await new Promise((r) => setTimeout(r, 0));
      const it = allItems[i];
      it.sal = computeSaliency(it.loaded.imageData, settings.method);
      it.metrics = computeMetrics(it.sal);
    }
    hideResults();
    renderGroups();
    setBusy(false);
  } else if (changed.colormap || changed.alpha) {
    // Превью в комбо-картах используют colormap/alpha — просто перерисовать
    if (match.results.length) renderResults();
  }
}

/* ============================================================
   Утилиты
   ============================================================ */

function setBusy(busy, msg = '', progress = '') {
  match.busy = busy;
  if (!dom.busy) return;
  dom.busy.hidden = !busy;
  if (busy) {
    const text = dom.busy.querySelector('.busy-text');
    if (text) text.textContent = msg;
    dom.progress.textContent = progress;
  }
}

function pluralFile(n) {
  const m = n % 10;
  if (n % 100 >= 11 && n % 100 <= 14) return 'ов';
  if (m === 1) return '';
  if (m >= 2 && m <= 4) return 'а';
  return 'ов';
}

function pluralGroup(n) {
  const m = n % 10;
  if (n % 100 >= 11 && n % 100 <= 14) return '';
  if (m === 1) return 'а';
  if (m >= 2 && m <= 4) return 'ы';
  return '';
}

function pluralSet(n) {
  const m = n % 10;
  if (n % 100 >= 11 && n % 100 <= 14) return 'ихся наборов';
  if (m === 1) return 'ийся набор';
  if (m >= 2 && m <= 4) return 'ихся набора';
  return 'ихся наборов';
}

function pluralVar(n) {
  const m = n % 10;
  if (n % 100 >= 11 && n % 100 <= 14) return 'ов';
  if (m === 1) return '';
  if (m >= 2 && m <= 4) return 'а';
  return 'ов';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function escapeAttr(s) {
  return escapeHtml(s);
}

function sanitize(s) {
  return String(s).replace(/[^\wа-яА-Я-]+/g, '_').replace(/_+/g, '_');
}
