/* ============================================================
   modes/compare.js — Режим 2: сравнение
   Подрежимы: 2a (несколько изображений) и 2b (составной стимул).
   ============================================================ */

import { loadImageFile, loadImageFiles, cropToImageData } from '../loader.js';
import { computeSaliency } from '../algorithms/index.js';
import { cropMap } from '../algorithms/util.js';
import { computeMetrics, METRIC_LABELS, pearsonR, formatMetric } from '../metrics.js';
import { renderHeatmap, renderOverlay, canvasToBlob } from '../render.js';
import { getSettings, onSettingsChange } from '../app.js';
import { downloadCSV, downloadZip, stripExt } from '../export.js';
import { toastError, toastSuccess } from '../toast.js';

/* ============================================================
   Состояние подрежима 2a
   ============================================================ */

const multi = {
  items: [],         // [{ id, loaded, sal, metrics }]
  busy: false,
  showHeat: true,
  nextId: 1,
};

const dom = {};

const PERCENT_KEYS = new Set(['spread_pct', 'peak_x', 'peak_y']);
const METRIC_ORDER = ['mean', 'peak', 'entropy', 'center_bias', 'spread_pct', 'peak_x', 'peak_y'];

/* ============================================================
   Инициализация
   ============================================================ */

export function initCompareMode() {
  cacheDom();
  bindSubtabs();
  bindMulti();
  bindCompound();
  onSettingsChange(handleSettingsChange);
}

function cacheDom() {
  dom.subtabs       = document.querySelectorAll('#mode-compare .subtab');
  dom.subPanels     = document.querySelectorAll('#mode-compare .sub-panel');

  // 2a
  dom.dropzone      = document.getElementById('multi-dropzone');
  dom.fileInput     = document.getElementById('multi-file');
  dom.pickBtn       = document.getElementById('multi-pickbtn');
  dom.results       = document.getElementById('multi-results');
  dom.addBtn        = document.getElementById('multi-add');
  dom.clearBtn      = document.getElementById('multi-clear');
  dom.toggleBtn     = document.getElementById('multi-toggle');
  dom.dlCsvBtn      = document.getElementById('multi-dl-csv');
  dom.dlZipBtn      = document.getElementById('multi-dl-zip');
  dom.grid          = document.getElementById('multi-grid');
  dom.matrix        = document.getElementById('multi-matrix');
  dom.busyBar       = document.getElementById('multi-busy');
  dom.progress      = document.getElementById('multi-progress');
  dom.count         = document.getElementById('multi-count');

  // 2b
  dom.cDropzone   = document.getElementById('compound-dropzone');
  dom.cFileInput  = document.getElementById('compound-file');
  dom.cPickBtn    = document.getElementById('compound-pickbtn');
  dom.cResults    = document.getElementById('compound-results');
  dom.cReplace    = document.getElementById('compound-replace');
  dom.cGridToggle = document.querySelectorAll('#compare-compound .grid-toggle button');
  dom.cToggle     = document.getElementById('compound-toggle');
  dom.cInfo       = document.getElementById('compound-info');
  dom.cDlCsv      = document.getElementById('compound-dl-csv');
  dom.cDlZip      = document.getElementById('compound-dl-zip');
  dom.cDlComp     = document.getElementById('compound-dl-composite');
  dom.cBusy       = document.getElementById('compound-busy');
  dom.cProgress   = document.getElementById('compound-progress');
  dom.cPreview    = document.getElementById('compound-preview');
  dom.cGrid       = document.getElementById('compound-grid');
  dom.cPairs      = document.getElementById('compound-pairs');
  dom.cMargins    = document.getElementById('compound-margins');
}

function bindSubtabs() {
  dom.subtabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const sub = tab.dataset.sub;
      dom.subtabs.forEach((t) => {
        const active = t === tab;
        t.classList.toggle('active', active);
        t.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      dom.subPanels.forEach((p) => {
        p.classList.toggle('active', p.id === `compare-${sub}`);
      });
    });
  });
}

function bindMulti() {
  dom.pickBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    dom.fileInput.click();
  });
  dom.dropzone.addEventListener('click', () => dom.fileInput.click());
  dom.fileInput.addEventListener('change', () => {
    const files = dom.fileInput.files;
    if (files && files.length) handleFiles([...files]);
    dom.fileInput.value = '';
  });

  dom.dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dom.dropzone.classList.add('drag-over');
  });
  dom.dropzone.addEventListener('dragleave', () => {
    dom.dropzone.classList.remove('drag-over');
  });
  dom.dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dom.dropzone.classList.remove('drag-over');
    const files = [...(e.dataTransfer.files || [])];
    if (files.length) handleFiles(files);
  });

  dom.addBtn.addEventListener('click', () => dom.fileInput.click());
  dom.clearBtn.addEventListener('click', clearAll);
  dom.dlCsvBtn.addEventListener('click', exportCSV);
  dom.dlZipBtn.addEventListener('click', exportZip);
  dom.toggleBtn.addEventListener('click', () => {
    multi.showHeat = !multi.showHeat;
    updateMultiToggleBtn();
    renderGrid();
  });
}

function updateMultiToggleBtn() {
  const icon = dom.toggleBtn.querySelector('.control-icon');
  const lbl  = dom.toggleBtn.querySelector('.control-label');
  if (multi.showHeat) { icon.textContent = '◉'; lbl.textContent = 'Скрыть карту'; }
  else                { icon.textContent = '○'; lbl.textContent = 'Показать карту'; }
}

/* ============================================================
   Загрузка файлов и пересчёт
   ============================================================ */

async function handleFiles(files) {
  setBusy(true, 'Загрузка…');
  const { ok, errors } = await loadImageFiles(files);
  if (errors.length) {
    toastError(`Не удалось загрузить ${errors.length} из ${files.length} файлов`);
    for (const err of errors) console.warn(err.message);
  }

  // Создать пустые items, прежде чем считать — чтобы UI обновился
  const settings = getSettings();
  for (const loaded of ok) {
    multi.items.push({
      id: multi.nextId++,
      loaded,
      sal: null,
      metrics: null,
    });
  }
  showResults();
  await computeAll(settings);
  setBusy(false);
}

async function computeAll(settings) {
  const total = multi.items.length;
  for (let i = 0; i < total; i++) {
    setBusy(true, 'Вычисляем салиентность…', `${i + 1} / ${total}`);
    await new Promise((r) => setTimeout(r, 0));
    const it = multi.items[i];
    it.sal = computeSaliency(it.loaded.imageData, settings.method);
    it.metrics = computeMetrics(it.sal);
  }
  renderGrid();
  renderMatrix();
  renderToolbarInfo();
}

async function recomputeAll() {
  if (!multi.items.length) return;
  const settings = getSettings();
  await computeAll(settings);
}

/* ============================================================
   Рендер сетки результатов
   ============================================================ */

function renderGrid() {
  if (!multi.items.length) {
    dom.grid.innerHTML = '';
    return;
  }
  const settings = getSettings();
  dom.grid.innerHTML = '';

  multi.items.forEach((it, idx) => {
    const card = document.createElement('div');
    card.className = 'result-card';
    card.innerHTML = `
      <div class="result-thumb" data-id="${it.id}"></div>
      <div class="result-body">
        <div class="result-name">${escapeHtml(it.loaded.name)}</div>
        <div class="result-stats">
          ${it.metrics ? `
            <span class="result-stat">μ <strong>${formatMetric('mean', it.metrics.mean)}</strong></span>
            <span class="result-stat">peak <strong>${formatMetric('peak', it.metrics.peak)}</strong></span>
            <span class="result-stat">H <strong>${formatMetric('entropy', it.metrics.entropy)}</strong></span>
            <span class="result-stat">spread <strong>${formatMetric('spread_pct', it.metrics.spread_pct)}</strong></span>
          ` : ''}
        </div>
        <div class="result-actions">
          <button class="btn btn-ghost" data-act="dl-heat" data-id="${it.id}">↓ карта</button>
          <button class="btn btn-ghost" data-act="dl-overlay" data-id="${it.id}">↓ оверлей</button>
        </div>
      </div>
    `;

    // Тег индекса + кнопка удаления
    const thumb = card.querySelector('.result-thumb');
    const tag = document.createElement('span');
    tag.className = 'result-tag';
    tag.textContent = String(idx + 1).padStart(2, '0');
    thumb.appendChild(tag);

    const rm = document.createElement('button');
    rm.className = 'result-remove';
    rm.innerHTML = '×';
    rm.title = 'Удалить';
    rm.addEventListener('click', (ev) => {
      ev.stopPropagation();
      removeItem(it.id);
    });
    thumb.appendChild(rm);

    // Превью с тепловой картой (или без, если showHeat=false)
    if (it.sal && multi.showHeat) {
      const canvas = renderOverlay(
        it.loaded.origImage, it.sal,
        it.sal.width, it.sal.height,
        it.sal.width, it.sal.height,
        settings.colormap, settings.alpha
      );
      thumb.appendChild(canvas);
    } else {
      const img = document.createElement('img');
      img.src = it.loaded.thumb;
      thumb.appendChild(img);
    }

    // Кнопки скачивания
    card.querySelector('[data-act="dl-heat"]').addEventListener('click', () => downloadOne(it.id, 'heat'));
    card.querySelector('[data-act="dl-overlay"]').addEventListener('click', () => downloadOne(it.id, 'overlay'));

    dom.grid.appendChild(card);
  });
}

/* ============================================================
   Корреляционная матрица
   ============================================================ */

function renderMatrix() {
  if (multi.items.length < 2) {
    dom.matrix.innerHTML = '<thead><tr><th>Загрузите 2 и более изображений для корреляции</th></tr></thead>';
    return;
  }
  const items = multi.items.filter((it) => it.sal);
  if (items.length < 2) { dom.matrix.innerHTML = ''; return; }

  // Заголовок
  let html = '<thead><tr><th class="row-header"></th>';
  items.forEach((it, j) => {
    html += `<th title="${escapeHtml(it.loaded.name)}">${j + 1}</th>`;
  });
  html += '</tr></thead><tbody>';

  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    html += `<tr><th class="row-header" title="${escapeHtml(a.loaded.name)}">${i + 1}. ${truncate(a.loaded.name, 24)}</th>`;
    for (let j = 0; j < items.length; j++) {
      if (i === j) {
        html += '<td class="cell-r-self">1.000</td>';
      } else if (j < i) {
        // зеркальная нижняя половина
        const r = pearsonR(items[i].sal, items[j].sal);
        html += `<td class="${corrClass(r)}">${r.toFixed(3)}</td>`;
      } else {
        const r = pearsonR(items[i].sal, items[j].sal);
        html += `<td class="${corrClass(r)}">${r.toFixed(3)}</td>`;
      }
    }
    html += '</tr>';
  }
  html += '</tbody>';
  dom.matrix.innerHTML = html;
}

function corrClass(r) {
  if (r >= 0.9) return 'cell-r-high';
  if (r >= 0.7) return 'cell-r-mid';
  return 'cell-r-low';
}

function corrLabel(r) {
  return r >= 0.9 ? 'высокое' : r >= 0.7 ? 'умеренное' : 'слабое';
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/* ============================================================
   Управление коллекцией
   ============================================================ */

function removeItem(id) {
  multi.items = multi.items.filter((it) => it.id !== id);
  if (!multi.items.length) {
    clearAll();
    return;
  }
  renderGrid();
  renderMatrix();
  renderToolbarInfo();
}

function clearAll() {
  multi.items = [];
  dom.grid.innerHTML = '';
  dom.matrix.innerHTML = '';
  dom.results.hidden = true;
  dom.dropzone.hidden = false;
  renderToolbarInfo();
}

function showResults() {
  dom.dropzone.hidden = true;
  dom.results.hidden = false;
}

function renderToolbarInfo() {
  dom.count.textContent = multi.items.length
    ? `${multi.items.length} изображени${pluralize(multi.items.length)}`
    : '';
}

function pluralize(n) {
  const m = n % 10;
  if (n % 100 >= 11 && n % 100 <= 14) return 'й';
  if (m === 1) return 'е';
  if (m >= 2 && m <= 4) return 'я';
  return 'й';
}

/* ============================================================
   Скачивание одного / всех
   ============================================================ */

async function downloadOne(id, kind) {
  const it = multi.items.find((x) => x.id === id);
  if (!it || !it.sal) return;
  const settings = getSettings();
  const { origImage, origW, origH, name } = it.loaded;
  let canvas;
  let suffix;
  if (kind === 'heat') {
    canvas = renderHeatmap(it.sal, it.sal.width, it.sal.height, origW, origH, settings.colormap, settings.alpha);
    suffix = '_saliency.png';
  } else {
    canvas = renderOverlay(origImage, it.sal, it.sal.width, it.sal.height, origW, origH, settings.colormap, settings.alpha);
    suffix = '_overlay.png';
  }
  const blob = await canvasToBlob(canvas, 'image/png');
  if (blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${stripExt(name)}${suffix}`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
    }, 0);
  }
}

async function exportZip() {
  if (!multi.items.length) return;
  setBusy(true, 'Генерируем PNG…', `0 / ${multi.items.length}`);
  const settings = getSettings();
  const entries = [];
  for (let i = 0; i < multi.items.length; i++) {
    const it = multi.items[i];
    if (!it.sal) continue;
    const { origImage, origW, origH, name } = it.loaded;
    const canvas = renderOverlay(
      origImage, it.sal,
      it.sal.width, it.sal.height,
      origW, origH,
      settings.colormap, settings.alpha
    );
    const blob = await canvasToBlob(canvas, 'image/png');
    if (blob) {
      entries.push({ name: `${stripExt(name)}_overlay.png`, blob });
    }
    setBusy(true, 'Генерируем PNG…', `${i + 1} / ${multi.items.length}`);
    await new Promise((r) => setTimeout(r, 0));
  }
  setBusy(true, 'Упаковываем ZIP…');
  await downloadZip(entries, 'saliency_maps.zip');
  setBusy(false);
  toastSuccess(`Сохранено: saliency_maps.zip · ${entries.length} карт`);
}

function exportCSV() {
  if (!multi.items.length) return;
  const items = multi.items.filter((it) => it.metrics);
  if (!items.length) return;

  const settings = getSettings();
  const rows = [];
  rows.push(['# Saliency export · ' + new Date().toISOString()]);
  rows.push(['# method', settings.method, 'colormap', settings.colormap, 'alpha', settings.alpha]);
  rows.push([]);
  rows.push(['filename', ...METRIC_ORDER]);
  for (const it of items) {
    const m = it.metrics;
    rows.push([
      it.loaded.name,
      ...METRIC_ORDER.map((k) => m[k]),
    ]);
  }

  // Корреляционная матрица
  if (items.length >= 2) {
    rows.push([]);
    rows.push(['Корреляция (Pearson r)', ...items.map((it) => it.loaded.name)]);
    for (let i = 0; i < items.length; i++) {
      const row = [items[i].loaded.name];
      for (let j = 0; j < items.length; j++) {
        if (i === j) row.push(1);
        else row.push(+pearsonR(items[i].sal, items[j].sal).toFixed(4));
      }
      rows.push(row);
    }
  }

  downloadCSV(rows, 'saliency_compare.csv');
  toastSuccess('Сохранено: saliency_compare.csv');
}

/* ============================================================
   ============================================================
      ПОДРЕЖИМ 2b — СОСТАВНОЙ СТИМУЛ
   ============================================================
   ============================================================ */

const compound = {
  loaded: null,        // { imageData, origImage, origW, origH, name, file }
  grid: '2x2',        // '2x1' | '1x2' | '2x2'
  sal: null,           // карта салиентности ВСЕГО составного изображения
  regions: [],        // [{ name, row, col, sx, sy, sw, sh, cell, trimmed, thumb, sal, metrics, share }]
  ignoreMargins: true, // не учитывать однородные поля вокруг картинок
  marginsFound: 0,     // в скольких ячейках найдены поля
  showHeat: true,
  busy: false,
};

const GRID_DIMS = {
  '2x1': { rows: 2, cols: 1 },  // 2 строки, 1 столбец → R1C1, R2C1
  '1x2': { rows: 1, cols: 2 },  // 1 строка, 2 столбца → R1C1, R1C2
  '2x2': { rows: 2, cols: 2 },
};

function bindCompound() {
  dom.cPickBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    dom.cFileInput.click();
  });
  dom.cDropzone.addEventListener('click', () => dom.cFileInput.click());
  dom.cFileInput.addEventListener('change', () => {
    const f = dom.cFileInput.files?.[0];
    if (f) handleCompoundFile(f);
    dom.cFileInput.value = '';
  });

  dom.cDropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dom.cDropzone.classList.add('drag-over');
  });
  dom.cDropzone.addEventListener('dragleave', () => {
    dom.cDropzone.classList.remove('drag-over');
  });
  dom.cDropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dom.cDropzone.classList.remove('drag-over');
    const f = e.dataTransfer.files?.[0];
    if (f) handleCompoundFile(f);
  });

  dom.cReplace.addEventListener('click', resetCompound);
  dom.cGridToggle.forEach((btn) => {
    btn.addEventListener('click', () => {
      const g = btn.dataset.grid;
      if (g === compound.grid) return;
      dom.cGridToggle.forEach((b) => b.classList.toggle('active', b === btn));
      compound.grid = g;
      if (compound.loaded) computeCompound();
    });
  });

  dom.cMargins?.addEventListener('change', () => {
    compound.ignoreMargins = dom.cMargins.checked;
    if (compound.loaded) computeCompound();
  });

  dom.cDlCsv.addEventListener('click', exportCompoundCSV);
  dom.cDlZip.addEventListener('click', exportCompoundZip);
  dom.cDlComp.addEventListener('click', exportCompositeMap);

  dom.cToggle.addEventListener('click', () => {
    compound.showHeat = !compound.showHeat;
    updateCompoundToggleBtn();
    renderCompoundPreview();
    renderCompoundGrid();
  });
}

function updateCompoundToggleBtn() {
  const icon = dom.cToggle.querySelector('.control-icon');
  const lbl  = dom.cToggle.querySelector('.control-label');
  if (compound.showHeat) { icon.textContent = '◉'; lbl.textContent = 'Скрыть карту'; }
  else                   { icon.textContent = '○'; lbl.textContent = 'Показать карту'; }
}

async function handleCompoundFile(file) {
  setCompoundBusy(true, 'Загрузка изображения…');
  try {
    compound.loaded = await loadImageFile(file);
    showCompoundResults();
    await computeCompound();
  } catch (err) {
    console.error(err);
    toastError(err.message || String(err));
  } finally {
    setCompoundBusy(false);
  }
}

/**
 * Карта салиентности считается ОДИН раз по всему составному изображению.
 * Регионы вырезаются из общей карты без перенормировки — поэтому их
 * метрики лежат на одной шкале и показывают, какой подстимул заметнее
 * в контексте остальных. (Если нормировать каждый регион в [0, 1]
 * отдельно, все регионы по построению выглядят одинаково «яркими».)
 *
 * Поля вокруг картинок. Если стимулы вписаны в ячейки с однородным
 * фоном (белые поля), фон сам даёт салиентность (для FT белый далёк от
 * среднего цвета сцены) и ложные края по контуру картинок. Поэтому
 * в каждой ячейке ищется прямоугольник содержимого; всё вне него
 * перед расчётом заливается средним цветом картинок, а после расчёта
 * обнуляется и в метрики не входит.
 */
async function computeCompound() {
  if (!compound.loaded) return;
  setCompoundBusy(true, 'Вычисляем салиентность…');
  await new Promise((r) => setTimeout(r, 0));

  const cells = gridCells();
  const boxes = compound.ignoreMargins ? detectContentBoxes(compound.loaded.origImage, cells) : cells.map(() => null);
  compound.marginsFound = boxes.filter(Boolean).length;
  const rects = cells.map((c, i) => boxes[i] || c);

  const { imageData } = compound.loaded;
  const gw = imageData.width, gh = imageData.height;
  const gridRects = rects.map((r) => toGrid(r, gw, gh));

  let input = imageData;
  if (compound.marginsFound) input = fillOutside(imageData, gridRects);
  const sal = computeSaliency(input, getSettings().method);
  if (compound.marginsFound) maskOutside(sal, gridRects);
  compound.sal = sal;

  buildRegions(cells, rects, gridRects, boxes);
  renderCompoundAll();
  setCompoundBusy(false);
}

/** Ячейки сетки в пикселях оригинала — без пропусков и перекрытий. */
function gridCells() {
  const { rows, cols } = GRID_DIMS[compound.grid];
  const { origW, origH } = compound.loaded;
  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = Math.round(c * origW / cols);
      const y0 = Math.round(r * origH / rows);
      const x1 = c === cols - 1 ? origW : Math.round((c + 1) * origW / cols);
      const y1 = r === rows - 1 ? origH : Math.round((r + 1) * origH / rows);
      cells.push({ row: r, col: c, x0, y0, x1, y1 });
    }
  }
  return cells;
}

/** Прямоугольник оригинала → прямоугольник сетки карты (не меньше 1 px). */
function toGrid(r, gw, gh) {
  const { origW, origH } = compound.loaded;
  const x0 = Math.min(gw - 1, Math.floor(r.x0 * gw / origW));
  const y0 = Math.min(gh - 1, Math.floor(r.y0 * gh / origH));
  const x1 = Math.max(x0 + 1, Math.min(gw, Math.ceil(r.x1 * gw / origW)));
  const y1 = Math.max(y0 + 1, Math.min(gh, Math.ceil(r.y1 * gh / origH)));
  return { x0, y0, x1, y1 };
}

/**
 * Поиск картинок внутри ячеек.
 * 1) Цвет фона — медиана пикселей по внешней рамке изображения; фон
 *    признаётся, только если рамка однородна (≥ 90 % пикселей близки
 *    к медиане). Прозрачные пиксели PNG тоже считаются фоном.
 * 2) В каждой ячейке строка/столбец — «содержимое», если в них хотя бы
 *    1.5 % пикселей заметно отличаются от фона. Прямоугольник от первой
 *    до последней такой строки и столбца — картинка.
 * Возвращает массив прямоугольников в пикселях оригинала (null — полей
 * в ячейке нет или найти картинку не удалось).
 */
function detectContentBoxes(img, cells) {
  const { origW, origH } = compound.loaded;
  const k = Math.min(1, 900 / Math.max(origW, origH));
  const w = Math.max(1, Math.round(origW * k));
  const h = Math.max(1, Math.round(origH * k));
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;

  const TOL = 20;
  const px = (x, y) => (y * w + x) * 4;

  // Фон по внешней рамке (2 px)
  const rs = [], gs = [], bs = [];
  let transparent = 0, total = 0;
  const pushPx = (x, y) => {
    const i = px(x, y);
    total++;
    if (d[i + 3] < 128) { transparent++; return; }
    rs.push(d[i]); gs.push(d[i + 1]); bs.push(d[i + 2]);
  };
  for (let x = 0; x < w; x++) for (const y of [0, 1, h - 2, h - 1]) if (y >= 0 && y < h) pushPx(x, y);
  for (let y = 2; y < h - 2; y++) for (const x of [0, 1, w - 2, w - 1]) if (x >= 0 && x < w) pushPx(x, y);
  const med = (a) => { const s2 = a.slice().sort((p, q) => p - q); return s2[s2.length >> 1] ?? 0; };
  const bg = [med(rs), med(gs), med(bs)];
  let close = transparent;
  for (let i = 0; i < rs.length; i++) {
    if (Math.max(Math.abs(rs[i] - bg[0]), Math.abs(gs[i] - bg[1]), Math.abs(bs[i] - bg[2])) <= TOL) close++;
  }
  if (!total || close / total < 0.9) return cells.map(() => null);

  const isContent = (x, y) => {
    const i = px(x, y);
    if (d[i + 3] < 128) return false;
    return Math.max(Math.abs(d[i] - bg[0]), Math.abs(d[i + 1] - bg[1]), Math.abs(d[i + 2] - bg[2])) > TOL;
  };

  return cells.map((c) => {
    const cx0 = Math.floor(c.x0 * k), cy0 = Math.floor(c.y0 * k);
    const cx1 = Math.min(w, Math.ceil(c.x1 * k)), cy1 = Math.min(h, Math.ceil(c.y1 * k));
    const cw = cx1 - cx0, ch = cy1 - cy0;
    if (cw < 4 || ch < 4) return null;
    const rowCnt = new Int32Array(ch), colCnt = new Int32Array(cw);
    for (let y = cy0; y < cy1; y++) {
      for (let x = cx0; x < cx1; x++) {
        if (isContent(x, y)) { rowCnt[y - cy0]++; colCnt[x - cx0]++; }
      }
    }
    const rowMin = Math.max(2, 0.015 * cw), colMin = Math.max(2, 0.015 * ch);
    let top = -1, bottom = -1, left = -1, right = -1;
    for (let i = 0; i < ch; i++) if (rowCnt[i] >= rowMin) { if (top < 0) top = i; bottom = i; }
    for (let i = 0; i < cw; i++) if (colCnt[i] >= colMin) { if (left < 0) left = i; right = i; }
    if (top < 0 || left < 0) return null;
    const bw = right - left + 1, bh = bottom - top + 1;
    // Содержимое почти на всю ячейку — полей нет; слишком мелкое — скорее шум
    if (bw * bh > 0.97 * cw * ch || bw * bh < 0.03 * cw * ch) return null;
    return {
      row: c.row, col: c.col,
      x0: Math.max(c.x0, Math.floor((cx0 + left) / k)),
      y0: Math.max(c.y0, Math.floor((cy0 + top) / k)),
      x1: Math.min(c.x1, Math.ceil((cx0 + right + 1) / k)),
      y1: Math.min(c.y1, Math.ceil((cy0 + bottom + 1) / k)),
    };
  });
}

/** Копия ImageData, где всё вне прямоугольников залито средним цветом содержимого. */
function fillOutside(imageData, rects) {
  const { width: w, height: h, data } = imageData;
  const inside = new Uint8Array(w * h);
  for (const r of rects) {
    for (let y = r.y0; y < r.y1; y++) inside.fill(1, y * w + r.x0, y * w + r.x1);
  }
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let i = 0; i < w * h; i++) {
    if (!inside[i]) continue;
    sr += data[i * 4]; sg += data[i * 4 + 1]; sb += data[i * 4 + 2]; n++;
  }
  if (!n) return imageData;
  const mr = sr / n, mg = sg / n, mb = sb / n;
  const out = new ImageData(new Uint8ClampedArray(data), w, h);
  for (let i = 0; i < w * h; i++) {
    if (inside[i]) continue;
    out.data[i * 4] = mr; out.data[i * 4 + 1] = mg; out.data[i * 4 + 2] = mb; out.data[i * 4 + 3] = 255;
  }
  return out;
}

/** Обнулить карту вне прямоугольников (поля не показываются и не входят в доли). */
function maskOutside(sal, rects) {
  const w = sal.width;
  const inside = new Uint8Array(sal.length);
  for (const r of rects) {
    for (let y = r.y0; y < r.y1; y++) inside.fill(1, y * w + r.x0, y * w + r.x1);
  }
  for (let i = 0; i < sal.length; i++) if (!inside[i]) sal[i] = 0;
}

function buildRegions(cells, rects, gridRects, boxes) {
  const { origImage } = compound.loaded;
  const sal = compound.sal;
  const gw = sal.width;

  const regs = cells.map((c, i) => {
    const r = rects[i], g = gridRects[i];
    const regSal = cropMap(sal, gw, g.x0, g.y0, g.x1, g.y1);
    let sum = 0;
    for (let j = 0; j < regSal.length; j++) sum += regSal[j];
    const sx = r.x0, sy = r.y0, sw = r.x1 - r.x0, sh = r.y1 - r.y0;
    const { thumb } = cropToImageData(origImage, sx, sy, sw, sh);
    return {
      name: `R${c.row + 1}C${c.col + 1}`,
      row: c.row,
      col: c.col,
      sx, sy, sw, sh,
      cell: c,
      trimmed: !!boxes[i],
      thumb,
      sal: regSal,
      metrics: computeMetrics(regSal),
      sum,
    };
  });
  const total = regs.reduce((t, r) => t + r.sum, 0);
  for (const r of regs) r.share = total > 0 ? +(r.sum / total * 100).toFixed(2) : 0;
  compound.regions = regs;
}

function renderCompoundAll() {
  renderCompoundPreview();
  renderCompoundGrid();
  renderCompoundPairs();
  renderCompoundInfo();
}

async function recomputeCompound() {
  if (!compound.loaded) return;
  await computeCompound();
}

/* ---------- Render: composite preview ---------- */

function renderCompoundPreview() {
  if (!compound.loaded || !compound.sal) return;
  const { origImage, origW, origH } = compound.loaded;
  const settings = getSettings();
  const maxW = 720;
  const ratio = Math.min(1, maxW / origW);
  const dispW = Math.round(origW * ratio);
  const dispH = Math.round(origH * ratio);

  let canvas;
  if (compound.showHeat) {
    canvas = renderOverlay(origImage, compound.sal, compound.sal.width, compound.sal.height, dispW, dispH, settings.colormap, settings.alpha);
  } else {
    canvas = document.createElement('canvas');
    canvas.width = dispW;
    canvas.height = dispH;
    const c = canvas.getContext('2d');
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    c.drawImage(origImage, 0, 0, dispW, dispH);
  }
  const ctx = canvas.getContext('2d');

  // Пунктирная сетка поверх для наглядности
  const { rows, cols } = GRID_DIMS[compound.grid];
  ctx.strokeStyle = 'rgba(74, 222, 128, 0.55)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  for (let c = 1; c < cols; c++) {
    const x = (c / cols) * dispW;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, dispH);
    ctx.stroke();
  }
  for (let r = 1; r < rows; r++) {
    const y = (r / rows) * dispH;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(dispW, y);
    ctx.stroke();
  }

  // Рамки найденных картинок (поля не учитываются)
  ctx.setLineDash([]);
  const kx = dispW / origW, ky = dispH / origH;
  ctx.strokeStyle = 'rgba(74, 222, 128, 0.9)';
  ctx.lineWidth = 1.5;
  for (const reg of compound.regions) {
    if (!reg.trimmed) continue;
    ctx.strokeRect(reg.sx * kx + 0.5, reg.sy * ky + 0.5, reg.sw * kx - 1, reg.sh * ky - 1);
  }

  // Подписи регионов с долей салиентности
  ctx.font = '11px JetBrains Mono, monospace';
  ctx.fillStyle = 'rgba(74, 222, 128, 0.95)';
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
  ctx.lineWidth = 3;
  for (const reg of compound.regions) {
    const x = reg.cell.x0 * kx + 8;
    const y = reg.cell.y0 * ky + 16;
    const label = `${reg.name} · ${reg.share}%`;
    ctx.strokeText(label, x, y);
    ctx.fillText(label, x, y);
  }

  dom.cPreview.innerHTML = '';
  dom.cPreview.appendChild(canvas);
}

/* ---------- Render: regions grid ---------- */

function renderCompoundGrid() {
  if (!compound.regions.length) {
    dom.cGrid.innerHTML = '';
    return;
  }
  const settings = getSettings();
  dom.cGrid.innerHTML = '';

  for (const reg of compound.regions) {
    const card = document.createElement('div');
    card.className = 'result-card';
    card.innerHTML = `
      <div class="result-thumb"></div>
      <div class="result-body">
        <div class="result-name">${reg.name} · ${reg.sw}×${reg.sh}px${reg.trimmed ? ' · без полей' : ''}</div>
        <div class="result-stats">
          ${reg.metrics ? `
            <span class="result-stat" title="Доля всей салиентности изображения, приходящаяся на регион">доля <strong>${reg.share}%</strong></span>
            <span class="result-stat">μ <strong>${formatMetric('mean', reg.metrics.mean)}</strong></span>
            <span class="result-stat">peak <strong>${formatMetric('peak', reg.metrics.peak)}</strong></span>
            <span class="result-stat">H <strong>${formatMetric('entropy', reg.metrics.entropy)}</strong></span>
            <span class="result-stat">spread <strong>${formatMetric('spread_pct', reg.metrics.spread_pct)}</strong></span>
          ` : ''}
        </div>
      </div>
    `;

    const thumb = card.querySelector('.result-thumb');
    const tag = document.createElement('span');
    tag.className = 'result-tag';
    tag.textContent = reg.name;
    thumb.appendChild(tag);

    if (reg.sal && compound.showHeat) {
      const w = reg.sal.width, h = reg.sal.height;
      const previewCanvas = document.createElement('canvas');
      previewCanvas.width = w;
      previewCanvas.height = h;
      const pctx = previewCanvas.getContext('2d');
      pctx.imageSmoothingEnabled = true;
      pctx.imageSmoothingQuality = 'high';
      pctx.drawImage(compound.loaded.origImage, reg.sx, reg.sy, reg.sw, reg.sh, 0, 0, w, h);
      const heat = renderHeatmap(reg.sal, w, h, w, h, settings.colormap, settings.alpha);
      pctx.drawImage(heat, 0, 0);
      thumb.appendChild(previewCanvas);
    } else {
      const img = document.createElement('img');
      img.src = reg.thumb;
      thumb.appendChild(img);
    }

    dom.cGrid.appendChild(card);
  }
}

/* ---------- Render: pairs table ---------- */

function pairRows() {
  const regs = compound.regions.filter((r) => r.sal && r.metrics);
  const out = [];
  for (let i = 0; i < regs.length; i++) {
    for (let j = i + 1; j < regs.length; j++) {
      const a = regs[i], b = regs[j];
      out.push({
        a, b,
        r: pearsonR(a.sal, b.sal),
        dShare: Math.abs(a.share - b.share),
        dMean: Math.abs(a.metrics.mean - b.metrics.mean),
        dEnt: Math.abs(a.metrics.entropy - b.metrics.entropy),
        dPk: Math.abs(a.metrics.peak - b.metrics.peak),
      });
    }
  }
  return out;
}

function renderCompoundPairs() {
  const pairs = pairRows();
  if (!pairs.length) {
    dom.cPairs.innerHTML = '';
    return;
  }

  let html = `
    <thead>
      <tr>
        <th>Пара</th>
        <th title="Разница долей общей салиентности, процентные пункты">Δ доля, п.п.</th>
        <th>Δ mean</th>
        <th>Δ entropy</th>
        <th>Δ peak</th>
        <th title="Сходство пространственного рисунка карт (в относительных координатах региона)">r (Pearson)</th>
        <th>Сходство рисунка</th>
      </tr>
    </thead>
    <tbody>
  `;
  for (const p of pairs) {
    html += `
      <tr>
        <td><strong>${p.a.name} × ${p.b.name}</strong></td>
        <td class="num green">${p.dShare.toFixed(2)}</td>
        <td class="num">${formatMetric('mean', +p.dMean.toFixed(4))}</td>
        <td class="num">${formatMetric('entropy', +p.dEnt.toFixed(2))}</td>
        <td class="num">${formatMetric('peak', +p.dPk.toPrecision(4))}</td>
        <td class="num">${p.r.toFixed(3)}</td>
        <td><span class="corr-key ${corrClass(p.r)}"></span> ${corrLabel(p.r)}</td>
      </tr>
    `;
  }
  html += '</tbody>';
  dom.cPairs.innerHTML = html;
}

function renderCompoundInfo() {
  if (!compound.loaded) { dom.cInfo.textContent = ''; return; }
  const { name, origW, origH } = compound.loaded;
  const { rows, cols } = GRID_DIMS[compound.grid];
  const n = compound.regions.length;
  const margins = !compound.ignoreMargins ? ' · поля учитываются'
    : compound.marginsFound ? ` · поля найдены: ${compound.marginsFound} из ${n}` : ' · полей не найдено';
  dom.cInfo.textContent = `${truncate(name, 30)} · ${origW}×${origH} · ${cols}×${rows}${margins}`;
}

/* ---------- Reset ---------- */

function resetCompound() {
  compound.loaded = null;
  compound.sal = null;
  compound.regions = [];
  compound.marginsFound = 0;
  dom.cDropzone.hidden = false;
  dom.cResults.hidden = true;
  dom.cFileInput.value = '';
  dom.cPreview.innerHTML = '';
  dom.cGrid.innerHTML = '';
  dom.cPairs.innerHTML = '';
  dom.cInfo.textContent = '';
}

function showCompoundResults() {
  dom.cDropzone.hidden = true;
  dom.cResults.hidden = false;
}

function setCompoundBusy(busy, msg = '', progress = '') {
  compound.busy = busy;
  if (!dom.cBusy) return;
  dom.cBusy.hidden = !busy;
  if (busy) {
    const text = dom.cBusy.querySelector('.busy-text');
    if (text) text.textContent = msg;
    dom.cProgress.textContent = progress;
  }
}

/* ---------- Export: CSV ---------- */

function exportCompoundCSV() {
  const regs = compound.regions.filter((r) => r.metrics);
  if (regs.length < 2) return;

  const settings = getSettings();
  const rows = [];
  rows.push(['# Saliency compound · ' + new Date().toISOString()]);
  rows.push(['# file', compound.loaded.name, 'grid', compound.grid, 'method', settings.method]);
  rows.push(['# карта считается по всему изображению; регионы сравниваются на общей шкале']);
  rows.push(['# ignore_margins', compound.ignoreMargins ? 1 : 0, 'margins_found', compound.marginsFound]);
  rows.push([]);
  rows.push(['region', 'share_pct', 'x0', 'y0', 'width', 'height', 'margins_trimmed', ...METRIC_ORDER]);
  for (const reg of regs) {
    rows.push([reg.name, reg.share, reg.sx, reg.sy, reg.sw, reg.sh, reg.trimmed ? 1 : 0,
      ...METRIC_ORDER.map((k) => reg.metrics[k])]);
  }

  rows.push([]);
  rows.push(['Попарное сравнение', 'delta_share_pp', 'delta_mean', 'delta_entropy', 'delta_peak', 'r_pearson']);
  for (const p of pairRows()) {
    rows.push([
      `${p.a.name} × ${p.b.name}`,
      +p.dShare.toFixed(2),
      +p.dMean.toFixed(4),
      +p.dEnt.toFixed(2),
      +p.dPk.toPrecision(4),
      +p.r.toFixed(4),
    ]);
  }

  downloadCSV(rows, 'saliency_compound.csv');
  toastSuccess('Сохранено: saliency_compound.csv');
}

/* ---------- Export: ZIP всех регионов ---------- */

async function exportCompoundZip() {
  const regs = compound.regions.filter((r) => r.sal);
  if (!regs.length) return;
  setCompoundBusy(true, 'Генерируем PNG регионов…', `0 / ${regs.length}`);
  const settings = getSettings();
  const entries = [];
  for (let i = 0; i < regs.length; i++) {
    const reg = regs[i];
    const canvas = renderHeatmap(
      reg.sal,
      reg.sal.width, reg.sal.height,
      reg.sw, reg.sh,
      settings.colormap, settings.alpha
    );
    const blob = await canvasToBlob(canvas, 'image/png');
    if (blob) entries.push({ name: `saliency_${reg.name}.png`, blob });
    setCompoundBusy(true, 'Генерируем PNG регионов…', `${i + 1} / ${regs.length}`);
    await new Promise((r) => setTimeout(r, 0));
  }
  const composite = buildCompositeCanvas(settings);
  if (composite) {
    const blob = await canvasToBlob(composite, 'image/png');
    if (blob) entries.push({ name: 'saliency_composite.png', blob });
  }
  setCompoundBusy(true, 'Упаковываем ZIP…');
  await downloadZip(entries, 'saliency_compound.zip');
  setCompoundBusy(false);
  toastSuccess(`Сохранено: saliency_compound.zip · ${entries.length} файл(ов)`);
}

/* ---------- Export: composite PNG ---------- */

async function exportCompositeMap() {
  if (!compound.sal) return;
  const canvas = buildCompositeCanvas(getSettings());
  if (!canvas) return;
  const blob = await canvasToBlob(canvas, 'image/png');
  if (blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${stripExt(compound.loaded.name)}_composite.png`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
    }, 0);
  }
}

function buildCompositeCanvas(settings) {
  if (!compound.loaded || !compound.sal) return null;
  const { origW, origH } = compound.loaded;
  return renderHeatmap(compound.sal, compound.sal.width, compound.sal.height, origW, origH, settings.colormap, 1.0);
}

/* ============================================================
   Реакция на изменение настроек
   ============================================================ */

async function handleSettingsChange(_settings, changed) {
  // Если поменялся только colormap/alpha — пересчитывать sal не нужно, только перерисовать
  if (changed.method) {
    if (multi.items.length) await recomputeAll();
    if (compound.loaded) await recomputeCompound();
  } else if (changed.colormap || changed.alpha) {
    if (multi.items.length) renderGrid();
    if (compound.sal) {
      renderCompoundPreview();
      renderCompoundGrid();
    }
  }
}

/* ============================================================
   Утилиты
   ============================================================ */

function setBusy(busy, msg = '', progress = '') {
  multi.busy = busy;
  if (!dom.busyBar) return;
  dom.busyBar.hidden = !busy;
  if (busy) {
    const text = dom.busyBar.querySelector('.busy-text');
    if (text) text.textContent = msg;
    dom.progress.textContent = progress;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
