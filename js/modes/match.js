/* ============================================================
   modes/match.js — Режим 3: подбор групп
   2-4 группы изображений → поиск комбинаций (по одному из каждой)
   с минимальной дисперсией средней салиентности.
   ============================================================ */

import { loadImageFiles, TARGET_SIZE } from '../loader.js';
import { computeSaliency } from '../algorithms/index.js';
import { computeMetrics, formatMetric } from '../metrics.js';
import { renderHeatmap, renderOverlay, canvasToBlob } from '../render.js';
import { getSettings, onSettingsChange } from '../app.js';
import { downloadCSV, downloadZip, stripExt } from '../export.js';
import { toastError, toastSuccess } from '../toast.js';

const MIN_GROUPS = 2;
const MAX_GROUPS = 4;
const TOP_N = 5;
const CHUNK_SIZE = 5000;   // комбинаций за итерацию (RAF-нонблокинг)

const match = {
  groups: [],         // [{ id, name, items: [{ id, loaded, sal, metrics }] }]
  results: [],        // [{ rank, variance, mean, range, items: [item, ...] }]
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
    const metrics = computeMetrics(sal, TARGET_SIZE, TARGET_SIZE);
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
   Поиск комбинаций (декартово произведение → дисперсия → сорт)
   ============================================================ */

async function findCombinations() {
  const groups = match.groups.filter((g) => g.items.length > 0);
  if (groups.length < MIN_GROUPS) return;

  const arrays = groups.map((g) => g.items.filter((it) => it.metrics));
  if (arrays.some((arr) => arr.length === 0)) return;

  const total = arrays.reduce((p, arr) => p * arr.length, 1);
  setBusy(true, 'Поиск комбинаций…', `0 / ${total.toLocaleString('ru-RU')}`);

  // Top-N min-heap (простая реализация: храним отсортированный массив длины <= TOP_N)
  const top = [];

  // Итеративный обход декартова произведения с RAF-чанкингом
  const N = arrays.length;
  const indices = new Array(N).fill(0);
  let processed = 0;
  let done = false;

  while (!done) {
    let chunkCount = 0;
    while (chunkCount < CHUNK_SIZE && !done) {
      // Текущая комбинация
      const combo = new Array(N);
      const means = new Array(N);
      for (let k = 0; k < N; k++) {
        combo[k] = arrays[k][indices[k]];
        means[k] = combo[k].metrics.mean;
      }
      const variance = computeVariance(means);
      considerForTop(top, { combo: combo.slice(), groups, variance, means });
      processed++;
      chunkCount++;

      // Инкремент индексов
      let i = N - 1;
      while (i >= 0) {
        indices[i]++;
        if (indices[i] < arrays[i].length) break;
        indices[i] = 0;
        i--;
      }
      if (i < 0) done = true;
    }
    setBusy(true, 'Поиск комбинаций…', `${processed.toLocaleString('ru-RU')} / ${total.toLocaleString('ru-RU')}`);
    await new Promise((r) => setTimeout(r, 0));
  }

  match.results = top.map((entry, idx) => ({
    rank: idx + 1,
    variance: entry.variance,
    mean: avg(entry.means),
    range: [Math.min(...entry.means), Math.max(...entry.means)],
    items: entry.combo,
    groups,
  }));

  setBusy(false);
  renderResults();
  toastSuccess(`Найдено ${total.toLocaleString('ru-RU')} комбинаций · показаны лучшие ${match.results.length}`);
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

function considerForTop(top, entry) {
  if (top.length < TOP_N) {
    insertSorted(top, entry);
    return;
  }
  if (entry.variance < top[top.length - 1].variance) {
    top.pop();
    insertSorted(top, entry);
  }
}

function insertSorted(arr, entry) {
  // arr отсортирован по variance возр.; вставка простая O(N), N ≤ TOP_N=5
  let i = 0;
  while (i < arr.length && arr[i].variance <= entry.variance) i++;
  arr.splice(i, 0, entry);
}

/* ============================================================
   Рендер результатов
   ============================================================ */

function renderResults() {
  if (!match.results.length) {
    dom.results.hidden = true;
    return;
  }
  dom.results.hidden = false;
  const settings = getSettings();
  dom.combos.innerHTML = '';

  for (const res of match.results) {
    const card = document.createElement('div');
    card.className = `combo-card${res.rank === 1 ? ' rank-1' : ''}`;
    card.innerHTML = `
      <div class="combo-rank">
        <span class="combo-rank-num">#${res.rank}</span>
        <span class="combo-rank-label">${res.rank === 1 ? 'лучшая' : 'rank'}</span>
      </div>
      <div class="combo-meta">
        <div class="combo-stat-row">
          <span><span class="stat-key">σ²</span><span class="stat-val">${res.variance.toExponential(2)}</span></span>
          <span><span class="stat-key">μ̄</span><span class="stat-val">${res.mean.toFixed(4)}</span></span>
          <span><span class="stat-key">диапазон</span><span class="stat-val">${res.range[0].toFixed(4)} … ${res.range[1].toFixed(4)}</span></span>
        </div>
        <div class="combo-items"></div>
      </div>
      <div class="combo-actions">
        <button class="btn btn-ghost" data-act="dl-zip">↓ ZIP</button>
        ${res.rank === 1 ? '<span class="combo-rank-label" style="text-align:center;color:var(--green)">★ best match</span>' : ''}
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
      const heat = renderHeatmap(it.sal, TARGET_SIZE, TARGET_SIZE, 80, 80, settings.colormap, settings.alpha);
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
}

function hideResults() {
  match.results = [];
  dom.results.hidden = true;
  dom.combos.innerHTML = '';
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
      TARGET_SIZE, TARGET_SIZE,
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

  const header = ['rank', 'variance', 'mean_avg', 'mean_min', 'mean_max'];
  for (let i = 0; i < groups.length; i++) {
    header.push(`group${i + 1}_name`, `group${i + 1}_file`, `group${i + 1}_mean`);
  }

  const rows = [];
  rows.push(['# Saliency match · ' + new Date().toISOString()]);
  rows.push(['# method', settings.method, 'top', match.results.length]);
  rows.push([]);
  rows.push(header);
  for (const res of match.results) {
    const row = [
      res.rank,
      +res.variance.toExponential(6),
      +res.mean.toFixed(4),
      +res.range[0].toFixed(4),
      +res.range[1].toFixed(4),
    ];
    res.items.forEach((it, i) => {
      row.push(groups[i].name, it.loaded.name, it.metrics.mean);
    });
    rows.push(row);
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
      it.metrics = computeMetrics(it.sal, TARGET_SIZE, TARGET_SIZE);
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
