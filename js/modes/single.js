/* ============================================================
   modes/single.js — Режим 1: одно изображение
   ============================================================ */

import { loadImageFile, TARGET_SIZE } from '../loader.js';
import { computeSaliency } from '../algorithms/index.js';
import { computeMetrics, METRIC_LABELS, formatMetric } from '../metrics.js';
import { renderHeatmap, renderOverlay } from '../render.js';
import { colormapLegendDataURL, getColormap as getColormap } from '../colormap.js';
import { getSettings, onSettingsChange } from '../app.js';
import { downloadCanvasPNG, stripExt } from '../export.js';
import { toastError, toastSuccess } from '../toast.js';

const state = {
  loaded: null,    // { imageData, thumb, origW, origH, origImage, name, file }
  sal: null,       // Float32Array, 256×256
  metrics: null,
  showHeat: true,
  busy: false,
  selectedMetric: null,
};

const dom = {};

const MAX_DISPLAY_W = 720;

const PERCENT_KEYS = new Set(['spread_pct', 'peak_x', 'peak_y']);
const METRIC_ORDER = ['mean', 'peak', 'entropy', 'center_bias', 'spread_pct', 'peak_x', 'peak_y'];

export function initSingleMode() {
  cacheDom();
  bindEvents();
  onSettingsChange(handleSettingsChange);
  updateLegend();
}

function cacheDom() {
  dom.dropzone   = document.getElementById('single-dropzone');
  dom.fileInput  = document.getElementById('single-file');
  dom.pickBtn    = document.getElementById('single-pickbtn');
  dom.results    = document.getElementById('single-results');
  dom.stage      = document.getElementById('single-stage');
  dom.toggleBtn  = document.getElementById('single-toggle-heat');
  dom.replaceBtn = document.getElementById('single-replace');
  dom.dlHeat     = document.getElementById('single-dl-heat');
  dom.dlOverlay  = document.getElementById('single-dl-overlay');
  dom.metrics    = document.getElementById('single-metrics');
  dom.fileInfo   = document.getElementById('single-fileinfo');
  dom.legend     = document.getElementById('single-legend');
  dom.busy       = document.getElementById('single-busy');
  dom.histogram  = document.getElementById('single-histogram');
  dom.explainer  = document.getElementById('metric-explainer');
}

function bindEvents() {
  dom.pickBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    dom.fileInput.click();
  });
  dom.dropzone.addEventListener('click', () => {
    dom.fileInput.click();
  });

  dom.fileInput.addEventListener('change', () => {
    const f = dom.fileInput.files?.[0];
    if (f) handleFile(f);
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
    const f = e.dataTransfer.files?.[0];
    if (f) handleFile(f);
  });

  dom.toggleBtn.addEventListener('click', () => {
    state.showHeat = !state.showHeat;
    updateToggleBtn();
    renderStage();
  });

  dom.replaceBtn.addEventListener('click', resetState);
  dom.dlHeat.addEventListener('click', downloadHeatmapPNG);
  dom.dlOverlay.addEventListener('click', downloadOverlayPNG);
}

async function handleFile(file) {
  setBusy(true, 'Загрузка изображения…');
  try {
    state.loaded = await loadImageFile(file);
    state.showHeat = true;
    updateToggleBtn();
    showResults();
    await recompute();
  } catch (err) {
    setBusy(false);
    console.error(err);
    toastError(err.message || String(err));
  }
}

async function recompute() {
  if (!state.loaded) return;
  setBusy(true, 'Вычисляем салиентность…');
  // Дать UI отрисоваться перед тяжёлым циклом
  await new Promise((r) => setTimeout(r, 0));
  const settings = getSettings();
  state.sal = computeSaliency(state.loaded.imageData, settings.method);
  state.metrics = computeMetrics(state.sal, TARGET_SIZE, TARGET_SIZE);
  renderStage();
  renderMetrics();
  renderHistogram();
  renderFileInfo();
  setBusy(false);
}

function renderStage() {
  if (!state.loaded || !state.sal) return;
  const { origImage, origW, origH } = state.loaded;
  const settings = getSettings();

  const ratio = Math.min(1, MAX_DISPLAY_W / origW);
  const dispW = Math.max(1, Math.round(origW * ratio));
  const dispH = Math.max(1, Math.round(origH * ratio));

  let canvas;
  if (state.showHeat) {
    canvas = renderOverlay(
      origImage, state.sal,
      TARGET_SIZE, TARGET_SIZE,
      dispW, dispH,
      settings.colormap, settings.alpha
    );
  } else {
    canvas = document.createElement('canvas');
    canvas.width = dispW;
    canvas.height = dispH;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(origImage, 0, 0, dispW, dispH);
  }

  dom.stage.innerHTML = '';
  dom.stage.appendChild(canvas);
}

function renderMetrics() {
  if (!state.metrics) return;
  const m = state.metrics;
  dom.metrics.innerHTML = METRIC_ORDER.map((key) => {
    const meta = METRIC_LABELS[key];
    const display = formatMetric(key, m[key]);
    const sel = state.selectedMetric === key ? ' selected' : '';
    return `
      <div class="metric-card${sel}" data-metric="${key}" role="button" tabindex="0"
           title="${meta.desc} · клик для подробного описания">
        <div class="metric-label">${meta.label}</div>
        <div class="metric-value">${display}</div>
        <div class="metric-key">${key}</div>
      </div>
    `;
  }).join('');

  // Привязываем клик
  dom.metrics.querySelectorAll('.metric-card[data-metric]').forEach((el) => {
    el.addEventListener('click', () => selectMetric(el.dataset.metric));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectMetric(el.dataset.metric);
      }
    });
  });

  renderExplainer();
}

/**
 * Переключает выделенную метрику. Повторный клик по той же — снимает выделение.
 */
function selectMetric(key) {
  state.selectedMetric = state.selectedMetric === key ? null : key;
  // Обновить активное состояние карточек без полного перерисовывания
  dom.metrics.querySelectorAll('.metric-card').forEach((el) => {
    el.classList.toggle('selected', el.dataset.metric === state.selectedMetric);
  });
  renderExplainer();
}

/**
 * Рендерит эксплейнер: для выбранной метрики выводит формулу, интерпретацию
 * и подсказку «как использовать». Без выбора — пустое состояние.
 */
function renderExplainer() {
  if (!dom.explainer) return;
  const key = state.selectedMetric;
  if (!key) {
    dom.explainer.classList.remove('has-content');
    dom.explainer.innerHTML = `
      <div class="explainer-empty">
        <span class="explainer-arrow">↑</span>
        Кликните по любой метрике, чтобы увидеть формулу,
        интерпретацию значений и подсказку, как использовать в исследовании
      </div>
    `;
    return;
  }
  const meta = METRIC_LABELS[key];
  const m = state.metrics;
  const value = m ? m[key] : null;
  const valueDisplay = value == null ? '' : formatMetric(key, value);

  dom.explainer.classList.add('has-content');
  dom.explainer.innerHTML = `
    <div class="explainer-body">
      <div class="explainer-head">
        <span class="explainer-name">${escapeHtml(meta.label)}</span>
        <span class="explainer-key">${key}</span>
        ${value != null ? `<span class="explainer-key" style="color:var(--green-bright);background:rgba(74,222,128,0.1)">текущее: ${valueDisplay}</span>` : ''}
      </div>
      <div class="explainer-row">
        <span class="explainer-row-label">Что это</span>
        <span>${escapeHtml(meta.what)}</span>
      </div>
      <div class="explainer-row">
        <span class="explainer-row-label">Формула</span>
        <code class="explainer-formula">${escapeHtml(meta.formula)}</code>
      </div>
      <div class="explainer-row">
        <span class="explainer-row-label">Как читать</span>
        <div class="explainer-read">
          ${meta.read.map(([range, comment]) => `
            <div class="explainer-read-row">
              <span class="explainer-read-key">${escapeHtml(range)}</span>
              <span>${escapeHtml(comment)}</span>
            </div>
          `).join('')}
        </div>
      </div>
      <div class="explainer-row">
        <span class="explainer-row-label">В исследованиях</span>
        <span>${escapeHtml(meta.useFor)}</span>
      </div>
    </div>
  `;
}

function renderFileInfo() {
  const { name, origW, origH } = state.loaded;
  dom.fileInfo.innerHTML = `
    <span class="file-info-tag">FILE</span>
    <span class="file-name">${escapeHtml(name)}</span>
    <span class="file-meta">${origW} × ${origH} px · внутреннее представление 256×256</span>
  `;
}

/**
 * Рисует гистограмму распределения салиентности (32 бина).
 * Цвет столбцов соответствует выбранной colormap, что визуально связывает
 * шкалу легенды и гистограмму.
 */
function renderHistogram() {
  if (!state.sal || !dom.histogram) return;
  const canvas = dom.histogram;

  // HiDPI-фриндли: масштабируем backing store под devicePixelRatio
  const cssW = canvas.clientWidth || 720;
  const cssH = canvas.clientHeight || 120;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const bins = 32;
  const hist = new Uint32Array(bins);
  for (let i = 0; i < state.sal.length; i++) {
    let b = (state.sal[i] * bins) | 0;
    if (b >= bins) b = bins - 1;
    else if (b < 0) b = 0;
    hist[b]++;
  }

  let maxVal = 0;
  for (let i = 0; i < bins; i++) if (hist[i] > maxVal) maxVal = hist[i];
  if (maxVal === 0) return;

  const settings = getSettings();
  const cmap = getColormap(settings.colormap);

  const padX = 2;
  const padTop = 6;
  const padBottom = 6;
  const innerW = cssW - padX * 2;
  const innerH = cssH - padTop - padBottom;
  const barW = innerW / bins;

  // Базовая линия
  ctx.strokeStyle = 'rgba(74, 222, 128, 0.12)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padX, cssH - padBottom + 0.5);
  ctx.lineTo(cssW - padX, cssH - padBottom + 0.5);
  ctx.stroke();

  // Столбцы
  for (let i = 0; i < bins; i++) {
    const ratio = hist[i] / maxVal;
    const h = Math.max(1, ratio * innerH);
    const x = padX + i * barW;
    const y = cssH - padBottom - h;
    const s = (i + 0.5) / bins;
    const [r, g, b] = cmap(s);
    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
    ctx.fillRect(x, y, Math.max(1, barW - 1), h);
  }

  // Индикатор порога spread = 0.5
  const xMid = padX + innerW * 0.5;
  ctx.strokeStyle = 'rgba(74, 222, 128, 0.45)';
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(xMid, padTop);
  ctx.lineTo(xMid, cssH - padBottom);
  ctx.stroke();
  ctx.setLineDash([]);

  // Подпись для spread
  ctx.fillStyle = 'rgba(109, 168, 112, 0.85)';
  ctx.font = '10px JetBrains Mono, monospace';
  const spreadLabel = `spread > 0.5  ${state.metrics?.spread_pct ?? 0}%`;
  const txtW = ctx.measureText(spreadLabel).width;
  ctx.fillText(spreadLabel, Math.min(xMid + 4, cssW - txtW - 4), padTop + 9);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function showResults() {
  dom.dropzone.hidden = true;
  dom.results.hidden = false;
}

function resetState() {
  state.loaded = null;
  state.sal = null;
  state.metrics = null;
  state.showHeat = true;
  state.selectedMetric = null;
  dom.dropzone.hidden = false;
  dom.results.hidden = true;
  dom.fileInput.value = '';
  dom.stage.innerHTML = '';
  dom.metrics.innerHTML = '';
  dom.fileInfo.innerHTML = '';
  renderExplainer();
  if (dom.histogram) {
    const ctx = dom.histogram.getContext('2d');
    ctx.clearRect(0, 0, dom.histogram.width, dom.histogram.height);
  }
}

function setBusy(busy, msg = '') {
  state.busy = busy;
  if (!dom.busy) return;
  dom.busy.hidden = !busy;
  if (busy) {
    const text = dom.busy.querySelector('.busy-text');
    if (text) text.textContent = msg;
  }
}

function updateToggleBtn() {
  const icon = dom.toggleBtn.querySelector('.control-icon');
  const lbl  = dom.toggleBtn.querySelector('.control-label');
  if (state.showHeat) {
    icon.textContent = '◉';
    lbl.textContent = 'Скрыть тепловую карту';
  } else {
    icon.textContent = '○';
    lbl.textContent = 'Показать тепловую карту';
  }
}

function handleSettingsChange(_settings, changed) {
  updateLegend();
  if (!state.loaded) return;
  if (changed.method) {
    recompute();
  } else if (changed.colormap || changed.alpha) {
    renderStage();
    if (changed.colormap) renderHistogram();
  }
}

function updateLegend() {
  if (!dom.legend) return;
  const s = getSettings();
  dom.legend.style.backgroundImage = `url(${colormapLegendDataURL(s.colormap, 200, 12)})`;
}

async function downloadHeatmapPNG() {
  if (!state.sal || !state.loaded) return;
  const { origW, origH, name } = state.loaded;
  const settings = getSettings();
  const canvas = renderHeatmap(
    state.sal,
    TARGET_SIZE, TARGET_SIZE,
    origW, origH,
    settings.colormap, settings.alpha
  );
  const fname = `${stripExt(name)}_saliency.png`;
  await downloadCanvasPNG(canvas, fname);
  toastSuccess(`Сохранено: ${fname}`);
}

async function downloadOverlayPNG() {
  if (!state.sal || !state.loaded) return;
  const { origImage, origW, origH, name } = state.loaded;
  const settings = getSettings();
  const canvas = renderOverlay(
    origImage, state.sal,
    TARGET_SIZE, TARGET_SIZE,
    origW, origH,
    settings.colormap, settings.alpha
  );
  const fname = `${stripExt(name)}_overlay.png`;
  await downloadCanvasPNG(canvas, fname);
  toastSuccess(`Сохранено: ${fname}`);
}
