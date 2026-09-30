/* ============================================================
   fixations-app.js — модуль сравнения карт айтрекинга
   и моделей салиентности.

   Точка входа отдельной страницы fixations.html.
   Использует общие алгоритмы салиентности из js/algorithms/.
   ============================================================ */

import { loadImageFile, loadImageFiles } from './loader.js';
import { computeSaliency, METHOD_LABELS } from './algorithms/index.js';
import { renderHeatmap, renderOverlay, canvasToBlob } from './render.js';
import { downloadCSV, downloadZip, stripExt } from './export.js';
import { toastError, toastSuccess, toastInfo } from './toast.js';
import { meanCI95 } from './stats.js';
import {
  parseCSV, detectColumns, extractFixations, uniqueStimuli, matchStimulus, COLUMN_ROLES,
} from './eyetracking/csv-parser.js';
import {
  mapFixations, buildFixationMap, centerBaseline, prepareMap, evaluateMap,
  interObserverCeiling, perParticipant, differenceMap,
} from './eyetracking/fixmap.js';

/* ============================================================
   Состояние
   ============================================================ */

const ALL_STIMULI = '__all__';

const state = {
  stim: null,           // {imageData, origImage, origW, origH, name, ...}
  csv: {
    parsed: null,
    mapping: null,
    stimuli: [],
    fileName: '',
  },
  params: {
    method: 'ft',
    sigmaPx: 30,
    selectedStimulus: '',
    frameMode: 'image',  // image | center | fit | manual
    screenW: null,
    screenH: null,
    rect: { x0: 0, y0: 0, w: null, h: null },
    norm: false,
    weighted: false,
  },
  frameTouched: false,  // пользователь сам менял режим кадра — не переключать автоматически
  result: null,
  batch: { images: [], rows: [], summary: null },
  busy: false,
};

const dom = {};

/** Метрики соответствия: ключ, подпись, «больше — лучше?», формат. */
const EVAL_KEYS = [
  ['cc',   'CC (Pearson r)', true],
  ['nss',  'NSS',            true],
  ['auc',  'AUC-Judd',       true],
  ['sauc', 'sAUC',           true],
  ['sim',  'SIM',            true],
  ['kl',   'KL',             false],
];

/* ============================================================
   Инициализация
   ============================================================ */

document.addEventListener('DOMContentLoaded', () => {
  cacheDom();
  bindEvents();
  renderParams();
  updateRunButton();
});

function cacheDom() {
  const $ = (id) => document.getElementById(id);
  dom.stimDz = $('stim-dropzone');
  dom.stimFile = $('stim-file');
  dom.stimPick = $('stim-pick');
  dom.stimInfo = $('stim-info');

  dom.csvDz = $('csv-dropzone');
  dom.csvFile = $('csv-file');
  dom.csvPick = $('csv-pick');
  dom.csvInfo = $('csv-info');

  dom.params = $('params');
  dom.method = $('param-method');
  dom.sigma = $('param-sigma');
  dom.sigmaVal = $('param-sigma-val');
  dom.stimFilter = $('param-stim-filter');
  dom.colGrid = $('col-grid');
  dom.colSummary = $('col-summary');
  dom.frameMode = $('frame-mode');
  dom.screenW = $('screen-w');
  dom.screenH = $('screen-h');
  dom.rectX = $('rect-x');
  dom.rectY = $('rect-y');
  dom.rectW = $('rect-w');
  dom.rectH = $('rect-h');
  dom.norm = $('coords-norm');
  dom.weighted = $('opt-duration');
  dom.frameHint = $('frame-hint');
  dom.frameGroups = document.querySelectorAll('.frame-group[data-modes]');
  dom.runBtn = $('run-btn');

  dom.results = $('results');
  dom.busy = $('busy');
  dom.metricsBox = $('eval-metrics');
  dom.benchTable = $('bench-table');
  dom.benchNote = $('bench-note');
  dom.ppBlock = $('pp-block');
  dom.ppTable = $('pp-table');
  dom.stageRow = $('stage-row');
  dom.dlCsv = $('dl-csv');
  dom.dlZip = $('dl-zip');

  dom.batch = $('batch');
  dom.batchFiles = $('batch-files');
  dom.batchPick = $('batch-pick');
  dom.batchInfo = $('batch-info');
  dom.batchRun = $('batch-run');
  dom.batchResults = $('batch-results');
  dom.batchTable = $('batch-table');
  dom.batchDl = $('batch-dl');
}

function bindEvents() {
  // ---- стимул ----
  dom.stimPick.addEventListener('click', (e) => {
    e.stopPropagation();
    dom.stimFile.click();
  });
  dom.stimDz.addEventListener('click', () => dom.stimFile.click());
  dom.stimFile.addEventListener('change', () => {
    const f = dom.stimFile.files?.[0];
    if (f) handleStimulus(f);
  });
  bindDrop(dom.stimDz, (files) => { if (files[0]) handleStimulus(files[0]); });

  // ---- csv ----
  dom.csvPick.addEventListener('click', (e) => {
    e.stopPropagation();
    dom.csvFile.click();
  });
  dom.csvDz.addEventListener('click', () => dom.csvFile.click());
  dom.csvFile.addEventListener('change', () => {
    const f = dom.csvFile.files?.[0];
    if (f) handleCsv(f);
  });
  bindDrop(dom.csvDz, (files) => { if (files[0]) handleCsv(files[0]); });

  // ---- параметры ----
  dom.method.addEventListener('change', () => { state.params.method = dom.method.value; });
  dom.sigma.addEventListener('input', () => {
    state.params.sigmaPx = +dom.sigma.value;
    dom.sigmaVal.textContent = state.params.sigmaPx;
  });
  dom.stimFilter.addEventListener('change', () => {
    state.params.selectedStimulus = dom.stimFilter.value;
    onFixationsChanged();
  });

  // ---- кадр ----
  dom.frameMode.addEventListener('change', () => {
    state.params.frameMode = dom.frameMode.value;
    state.frameTouched = true;
    if (state.params.frameMode === 'manual' && state.params.rect.w == null) fillManualFromCurrent();
    renderFrameFields();
    updateFrameHint();
  });
  const numInput = (el, fn) => el.addEventListener('input', () => {
    const v = parseFloat(el.value);
    fn(isFinite(v) ? v : null);
    state.frameTouched = true;
    updateFrameHint();
  });
  numInput(dom.screenW, (v) => { state.params.screenW = v > 0 ? v : null; });
  numInput(dom.screenH, (v) => { state.params.screenH = v > 0 ? v : null; });
  numInput(dom.rectX, (v) => { state.params.rect.x0 = v ?? 0; });
  numInput(dom.rectY, (v) => { state.params.rect.y0 = v ?? 0; });
  numInput(dom.rectW, (v) => { state.params.rect.w = v > 0 ? v : null; });
  numInput(dom.rectH, (v) => { state.params.rect.h = v > 0 ? v : null; });
  dom.norm.addEventListener('change', () => {
    state.params.norm = dom.norm.checked;
    renderFrameFields();
    updateFrameHint();
  });
  dom.weighted.addEventListener('change', () => { state.params.weighted = dom.weighted.checked; });

  // ---- кнопки ----
  dom.runBtn.addEventListener('click', runComparison);
  dom.dlCsv.addEventListener('click', exportCsvReport);
  dom.dlZip.addEventListener('click', exportZipMaps);

  // ---- пакет ----
  dom.batchPick.addEventListener('click', () => dom.batchFiles.click());
  dom.batchFiles.addEventListener('change', () => {
    const files = [...(dom.batchFiles.files || [])];
    if (files.length) handleBatchImages(files);
    dom.batchFiles.value = '';
  });
  dom.batchRun.addEventListener('click', runBatch);
  dom.batchDl.addEventListener('click', exportBatchCsv);
}

function bindDrop(zone, onFiles) {
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('drag-over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    const files = [...(e.dataTransfer.files || [])];
    if (files.length) onFiles(files);
  });
}

/* ============================================================
   Стимул
   ============================================================ */

async function handleStimulus(file) {
  try {
    state.stim = await loadImageFile(file);
    // Если в CSV есть стимул с таким же именем — выбрать его автоматически
    if (state.csv.stimuli.length) {
      const m = matchStimulus(state.csv.stimuli, state.stim.name);
      if (m) state.params.selectedStimulus = m;
      renderStimulusFilter();
    }
    autoFrame();
    renderStimInfo();
    renderCsvInfo();
    updateFrameHint();
    updateRunButton();
  } catch (err) {
    toastError(err.message || String(err));
  }
}

function renderStimInfo() {
  if (!state.stim) {
    dom.stimInfo.hidden = true;
    return;
  }
  const { name, origW, origH } = state.stim;
  dom.stimInfo.hidden = false;
  dom.stimInfo.innerHTML = `
    <span class="upload-tag">STIMULUS</span>
    <span class="upload-name">${escapeHtml(name)}</span>
    <span class="upload-meta">${origW} × ${origH} px</span>
    <button class="upload-replace" data-act="replace-stim" type="button">↻ заменить</button>
  `;
  dom.stimInfo.querySelector('[data-act="replace-stim"]').addEventListener('click', () => {
    state.stim = null;
    state.result = null;
    renderStimInfo();
    hideResults();
    updateRunButton();
    dom.stimFile.value = '';
  });
}

/* ============================================================
   CSV
   ============================================================ */

async function handleCsv(file) {
  try {
    if (file.size > 200 * 1024 * 1024) {
      toastError(
        `Файл ${file.name} слишком большой (${(file.size / 1024 / 1024).toFixed(1)} МБ). ` +
        `Сохраните из пакета айтрекера только нужные колонки или только события-фиксации.`
      );
      return;
    }
    const text = await file.text();
    if (!text.trim()) {
      toastError('CSV-файл пустой.');
      return;
    }

    const parsed = parseCSV(text);
    if (!parsed.columns.length) {
      toastError('Не удалось разобрать заголовок CSV. Проверьте, что в первой строке есть имена колонок.');
      return;
    }
    if (!parsed.rows.length) {
      toastError('В CSV есть только заголовок, но нет строк с данными.');
      return;
    }

    state.csv.parsed = parsed;
    state.csv.mapping = detectColumns(parsed.columns);
    state.csv.fileName = file.name;

    if (!state.csv.mapping.x || !state.csv.mapping.y) {
      toastInfo(
        'Не удалось уверенно найти колонки координат. Выберите X и Y вручную в блоке «Столбцы CSV».',
        8000
      );
      dom.params.hidden = false;
      document.getElementById('col-block').open = true;
    }

    onMappingChanged(true);

    const n = countFixations();
    if (n === 0) {
      toastInfo('CSV распознан, но после фильтрации не осталось фиксаций. Проверьте столбцы и выбор стимула.', 7000);
    } else {
      toastSuccess(`CSV распознан · ${n} фиксаци${pluralFix(n)}`);
    }
  } catch (err) {
    toastError(err.message || String(err));
  }
}

/** Пересчитать всё, что зависит от сопоставления колонок. */
function onMappingChanged(fresh = false) {
  const { parsed, mapping } = state.csv;
  state.csv.stimuli = uniqueStimuli(parsed.rows, mapping);
  const stimuli = state.csv.stimuli;

  if (fresh || (state.params.selectedStimulus && state.params.selectedStimulus !== ALL_STIMULI
      && !stimuli.includes(state.params.selectedStimulus))) {
    const m = state.stim ? matchStimulus(stimuli, state.stim.name) : null;
    state.params.selectedStimulus = m || (stimuli.length === 1 ? stimuli[0] : '');
  }

  // Координаты в долях 0–1? Включаем автоматически при первом разборе
  if (fresh) {
    const b = getCoordsBounds(true);
    state.params.norm = !!b && b.maxX <= 1.0001 && b.maxY <= 1.0001 && b.minX >= -0.01 && b.minY >= -0.01;
    dom.norm.checked = state.params.norm;
  }

  renderColumnMapping();
  renderStimulusFilter();
  onFixationsChanged();
}

function onFixationsChanged() {
  autoFrame();
  renderCsvInfo();
  updateFrameHint();
  updateRunButton();
  renderBatchInfo();
}

function renderColumnMapping() {
  const { parsed, mapping } = state.csv;
  if (!parsed) return;
  const opts = (sel) => ['<option value="">—</option>']
    .concat(parsed.columns.map((c) => `<option value="${escapeAttr(c)}"${c === sel ? ' selected' : ''}>${escapeHtml(c)}</option>`))
    .join('');
  dom.colGrid.innerHTML = COLUMN_ROLES.map(([role, label]) => `
    <label>${escapeHtml(label)}
      <select data-role="${role}">${opts(mapping[role])}</select>
    </label>`).join('');
  dom.colGrid.querySelectorAll('select[data-role]').forEach((sel) => {
    sel.addEventListener('change', () => {
      state.csv.mapping[sel.dataset.role] = sel.value || null;
      onMappingChanged(false);
    });
  });
  dom.colSummary.textContent = `x = ${mapping.x || '?'} · y = ${mapping.y || '?'}`;
}

function renderCsvInfo() {
  const { parsed, mapping, fileName, stimuli } = state.csv;
  if (!parsed) {
    dom.csvInfo.hidden = true;
    return;
  }
  const fixs = currentFixations();
  const fixCount = fixs.length;
  const dup = fixs.duplicatesRemoved || 0;

  dom.csvInfo.hidden = false;
  dom.csvInfo.innerHTML = `
    <span class="upload-tag">CSV</span>
    <span class="upload-name">${escapeHtml(fileName)}</span>
    <span class="upload-meta">
      ${parsed.rows.length} строк · ${stimuli.length || '—'} стимул${pluralStim(stimuli.length)} ·
      ${fixCount} фиксаци${pluralFix(fixCount)}${dup ? ` · убрано повторов: ${dup}` : ''}
    </span>
    <button class="upload-replace" data-act="replace-csv" type="button">↻ заменить</button>
    <div class="upload-mapping">
      <strong>Распознано:</strong>
      x = <code>${escapeHtml(mapping.x || '?')}</code> ·
      y = <code>${escapeHtml(mapping.y || '?')}</code> ·
      type = <code>${escapeHtml(mapping.type || '—')}</code> ·
      duration = <code>${escapeHtml(mapping.duration || '—')}</code> ·
      participant = <code>${escapeHtml(mapping.participant || '—')}</code> ·
      stimulus = <code>${escapeHtml(mapping.stimulus || '—')}</code> ·
      № фиксации = <code>${escapeHtml(mapping.fixIndex || '—')}</code>
    </div>
  `;
  dom.csvInfo.querySelector('[data-act="replace-csv"]').addEventListener('click', () => {
    state.csv = { parsed: null, mapping: null, stimuli: [], fileName: '' };
    state.result = null;
    renderCsvInfo();
    renderStimulusFilter();
    hideResults();
    updateRunButton();
    renderBatchInfo();
    dom.csvFile.value = '';
  });
}

function renderStimulusFilter() {
  const list = state.csv.stimuli;
  if (!state.csv.parsed || !list.length) {
    dom.stimFilter.innerHTML = state.csv.parsed
      ? '<option value="">все фиксации (колонки стимула нет)</option>'
      : '<option value="">— нет данных —</option>';
    return;
  }
  const sel = state.params.selectedStimulus;
  let html = '';
  if (list.length > 1) {
    html += `<option value=""${!sel ? ' selected' : ''}>— выберите стимул —</option>`;
  }
  for (const s of list) {
    html += `<option value="${escapeAttr(s)}"${s === sel ? ' selected' : ''}>${escapeHtml(s)}</option>`;
  }
  if (list.length > 1) {
    html += `<option value="${ALL_STIMULI}"${sel === ALL_STIMULI ? ' selected' : ''}>все стимулы вместе (обычно ошибка)</option>`;
  }
  dom.stimFilter.innerHTML = html;
}

/** Нужен ли явный выбор стимула (в CSV несколько, а выбран не один). */
function stimulusChoiceMissing() {
  return state.csv.stimuli.length > 1 && !state.params.selectedStimulus;
}

/* ============================================================
   Фиксации и кадр
   ============================================================ */

/** Фиксации выбранного стимула (сырые координаты, с учётом долей 0–1). */
function currentFixations() {
  const sel = state.params.selectedStimulus;
  const stimulus = sel && sel !== ALL_STIMULI ? sel : null;
  return fixationsFor(stimulus, state.stim);
}

function fixationsFor(stimulus, img) {
  const { parsed, mapping } = state.csv;
  if (!parsed || !mapping || !mapping.x || !mapping.y) return Object.assign([], { duplicatesRemoved: 0 });
  const fixs = extractFixations(parsed.rows, mapping, { stimulus });
  if (state.params.norm) {
    const ref = normRef(img);
    if (ref) for (const f of fixs) { f.x *= ref.w; f.y *= ref.h; }
  }
  return fixs;
}

/** Опорный размер для координат в долях 0–1. */
function normRef(img) {
  if (state.params.frameMode === 'image') return img ? { w: img.origW, h: img.origH } : null;
  const { screenW, screenH } = state.params;
  return screenW && screenH ? { w: screenW, h: screenH } : null;
}

function countFixations() {
  return currentFixations().length;
}

/** Границы координат. raw=true — без пересчёта долей в пиксели. */
function getCoordsBounds(raw = false) {
  if (!state.csv.parsed) return null;
  let fixs;
  if (raw) {
    const { parsed, mapping } = state.csv;
    if (!mapping.x || !mapping.y) return null;
    fixs = extractFixations(parsed.rows, mapping, {});
  } else {
    fixs = currentFixations();
  }
  if (!fixs.length) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const f of fixs) {
    if (f.x < minX) minX = f.x;
    if (f.x > maxX) maxX = f.x;
    if (f.y < minY) minY = f.y;
    if (f.y > maxY) maxY = f.y;
  }
  return { minX, maxX, minY, maxY };
}

/**
 * Прямоугольник стимула в координатах айтрекера.
 * Возвращает {x0, y0, w, h} или null, если параметров не хватает.
 */
function frameFor(img) {
  if (!img) return null;
  const { frameMode, screenW, screenH, rect } = state.params;
  const iw = img.origW, ih = img.origH;
  if (frameMode === 'image') return { x0: 0, y0: 0, w: iw, h: ih };
  if (frameMode === 'manual') {
    return rect.w && rect.h ? { x0: rect.x0 || 0, y0: rect.y0 || 0, w: rect.w, h: rect.h } : null;
  }
  if (!screenW || !screenH) return null;
  if (frameMode === 'center') {
    return { x0: (screenW - iw) / 2, y0: (screenH - ih) / 2, w: iw, h: ih };
  }
  // fit
  const k = Math.min(screenW / iw, screenH / ih);
  const w = iw * k, h = ih * k;
  return { x0: (screenW - w) / 2, y0: (screenH - h) / 2, w, h };
}

/**
 * Автоматическая догадка о кадре — только пока пользователь сам
 * ничего не менял. Если координаты заметно выходят за размер
 * изображения, это почти наверняка координаты экрана: предлагаем
 * «стимул по центру экрана» с угаданным размером экрана.
 */
function autoFrame() {
  if (state.frameTouched || !state.csv.parsed) { renderFrameFields(); return; }
  const b = getCoordsBounds(true);
  if (!b) { renderFrameFields(); return; }
  if (!state.params.norm) {
    const guess = guessScreen(b);
    state.params.screenW = guess.w;
    state.params.screenH = guess.h;
  } else {
    if (!state.params.screenW) state.params.screenW = 1920;
    if (!state.params.screenH) state.params.screenH = 1080;
  }
  if (state.params.norm) {
    // Доли 0–1 обычно отсчитываются от экрана; по умолчанию считаем, что стимул на весь экран
    state.params.frameMode = 'fit';
  } else if (state.stim) {
    const over = b.maxX > state.stim.origW * 1.05 || b.maxY > state.stim.origH * 1.05;
    state.params.frameMode = over ? 'center' : 'image';
  }
  renderFrameFields();
}

function fillManualFromCurrent() {
  const f = frameFor(state.stim) || (state.stim ? { x0: 0, y0: 0, w: state.stim.origW, h: state.stim.origH } : null);
  if (!f) return;
  state.params.rect = { x0: Math.round(f.x0), y0: Math.round(f.y0), w: Math.round(f.w), h: Math.round(f.h) };
}

/** Распространённые разрешения экрана — в порядке распространённости. */
const SCREENS = [
  [1920, 1080], [1920, 1200], [2560, 1440], [1680, 1050], [1600, 900], [1440, 900],
  [1366, 768], [1280, 1024], [1280, 800], [1280, 720], [1024, 768], [3840, 2160],
  [2560, 1600], [3440, 1440], [800, 600],
];

/**
 * Угадать размер экрана. Кандидаты — стандартные разрешения, в которые
 * укладываются координаты. Если изображение уже загружено, выбирается
 * разрешение, при котором стимул по центру экрана накрывает больше всего
 * фиксаций (максимальная координата сама по себе ненадёжна: при стимуле
 * по центру взгляд до края экрана обычно не доходит).
 */
function guessScreen(b) {
  const fits = SCREENS.filter(([w, h]) => w >= b.maxX * 0.98 && h >= b.maxY * 0.98);
  if (!fits.length) return { w: Math.ceil(b.maxX / 10) * 10, h: Math.ceil(b.maxY / 10) * 10 };
  if (!state.stim) return { w: fits[0][0], h: fits[0][1] };
  const fixs = currentFixations();
  const iw = state.stim.origW, ih = state.stim.origH;
  let best = fits[0], bestShare = -1;
  for (const [w, h] of fits) {
    const x0 = (w - iw) / 2, y0 = (h - ih) / 2;
    let inside = 0;
    for (const f of fixs) if (f.x >= x0 && f.x < x0 + iw && f.y >= y0 && f.y < y0 + ih) inside++;
    const share = fixs.length ? inside / fixs.length : 0;
    if (share > bestShare + 0.01) { best = [w, h]; bestShare = share; }
  }
  return { w: best[0], h: best[1] };
}

function renderFrameFields() {
  const p = state.params;
  dom.frameMode.value = p.frameMode;
  dom.frameGroups.forEach((g) => {
    const modes = g.dataset.modes.split(' ');
    g.hidden = !(modes.includes(p.frameMode) || (p.norm && modes.includes('norm') && p.frameMode !== 'image'));
  });
  setVal(dom.screenW, p.screenW);
  setVal(dom.screenH, p.screenH);
  setVal(dom.rectX, p.rect.x0);
  setVal(dom.rectY, p.rect.y0);
  setVal(dom.rectW, p.rect.w);
  setVal(dom.rectH, p.rect.h);
  dom.norm.checked = p.norm;
}

function setVal(el, v) {
  if (document.activeElement === el) return;
  el.value = v == null ? '' : Math.round(v * 100) / 100;
}

/** Подсказка: сколько фиксаций попадает в прямоугольник стимула. */
function updateFrameHint() {
  if (!dom.frameHint) return;
  if (!state.csv.parsed) { dom.frameHint.textContent = ''; return; }
  const fixs = currentFixations();
  if (!fixs.length) { dom.frameHint.textContent = ''; return; }
  const frame = frameFor(state.stim);
  if (!state.stim) {
    const b = getCoordsBounds();
    dom.frameHint.className = 'frame-hint';
    dom.frameHint.innerHTML = b ? `координаты до <strong>${Math.round(b.maxX)} × ${Math.round(b.maxY)}</strong> · загрузите стимул` : '';
    return;
  }
  if (!frame) {
    dom.frameHint.className = 'frame-hint frame-hint-warn';
    dom.frameHint.textContent = '⚠ укажите размер экрана или прямоугольник стимула';
    return;
  }
  let inside = 0;
  for (const f of fixs) {
    const u = (f.x - frame.x0) / frame.w, v = (f.y - frame.y0) / frame.h;
    if (u >= 0 && u < 1 && v >= 0 && v < 1) inside++;
  }
  const share = inside / fixs.length;
  const rect = `стимул: x ${Math.round(frame.x0)}…${Math.round(frame.x0 + frame.w)}, y ${Math.round(frame.y0)}…${Math.round(frame.y0 + frame.h)}`;
  dom.frameHint.className = share < 0.8 ? 'frame-hint frame-hint-warn' : 'frame-hint frame-hint-ok';
  dom.frameHint.innerHTML = `${share < 0.8 ? '⚠ ' : ''}${rect} · в стимул попадает <strong>${inside} из ${fixs.length}</strong> фиксаций (${Math.round(share * 100)} %)`;
}

function renderParams() {
  dom.method.value = state.params.method;
  dom.sigma.value = state.params.sigmaPx;
  dom.sigmaVal.textContent = state.params.sigmaPx;
  dom.weighted.checked = state.params.weighted;
  renderFrameFields();
}

function updateRunButton() {
  const ready = !!state.stim && !!state.csv.parsed && !!state.csv.mapping?.x && !!state.csv.mapping?.y
    && !stimulusChoiceMissing();
  dom.runBtn.disabled = !ready;
  dom.runBtn.title = stimulusChoiceMissing() ? 'В CSV несколько стимулов — выберите, какой соответствует изображению' : '';
  dom.params.hidden = !state.csv.parsed;
}

/* ============================================================
   Главный расчёт
   ============================================================ */

/**
 * Все метрики для одного стимула.
 * img — загруженное изображение; fixations — фиксации этого стимула;
 * negUV — [{u, v}] фиксации на других стимулах (для sAUC) или null.
 */
function analyzeStimulus(img, fixations, negUV, withDetails = true) {
  const frame = frameFor(img);
  if (!frame) throw new Error('Не задано положение стимула: укажите размер экрана или прямоугольник.');
  const { method, sigmaPx, weighted } = state.params;

  const sal = computeSaliency(img.imageData, method);
  const gw = sal.width, gh = sal.height;
  const { points, outside } = mapFixations(fixations, frame, gw, gh, weighted);
  if (!points.length) {
    throw new Error(`Ни одна из ${fixations.length} фиксаций не попала в прямоугольник стимула. Проверьте положение стимула на экране.`);
  }

  const fix = buildFixationMap(points, gw, gh, frame, sigmaPx);
  const negatives = negUV && negUV.length
    ? negUV.map(({ u, v }) => Math.min(gh - 1, Math.floor(v * gh)) * gw + Math.min(gw - 1, Math.floor(u * gw)))
    : null;

  const prep = prepareMap(sal);
  const model = evaluateMap(prep, points, fix, negatives);
  const center = evaluateMap(prepareMap(centerBaseline(gw, gh)), points, fix, negatives);
  const ceiling = interObserverCeiling(points, gw, gh, frame, sigmaPx);
  const pp = withDetails ? perParticipant(prep, points, gw, gh, frame, sigmaPx) : null;

  return {
    sal, fixmap: fix.map, diff: withDetails ? differenceMap(sal, fix.map) : null,
    frame, points,
    nFixations: points.length,
    nOutside: outside,
    nParticipants: countParticipants(points),
    nNegatives: negatives ? negatives.length : 0,
    model, center, ceiling, pp,
  };
}

/** Фиксации других стимулов в относительных координатах текущего кадра (для sAUC). */
function negativesForSingle(frame) {
  const { stimuli } = state.csv;
  const sel = state.params.selectedStimulus;
  if (!state.csv.mapping.stimulus || stimuli.length < 2 || !sel || sel === ALL_STIMULI) return null;
  const out = [];
  for (const s of stimuli) {
    if (s === sel) continue;
    for (const f of fixationsFor(s, state.stim)) {
      const u = (f.x - frame.x0) / frame.w, v = (f.y - frame.y0) / frame.h;
      if (u >= 0 && u < 1 && v >= 0 && v < 1) out.push({ u, v });
    }
  }
  return out;
}

async function runComparison() {
  if (!state.stim || !state.csv.parsed) return;
  if (stimulusChoiceMissing()) {
    toastError('В CSV несколько стимулов — выберите нужный в поле «Стимул в CSV».');
    return;
  }

  dom.results.hidden = false;
  setBusy(true, 'Считаем салиентность и метрики…');
  await new Promise((r) => setTimeout(r, 30));

  try {
    const fixations = currentFixations();
    if (!fixations.length) {
      throw new Error('После фильтрации не осталось ни одной фиксации. Проверьте столбцы CSV и выбор стимула.');
    }
    const frame = frameFor(state.stim);
    if (!frame) throw new Error('Не задано положение стимула: укажите размер экрана или прямоугольник.');

    const res = analyzeStimulus(state.stim, fixations, negativesForSingle(frame), true);
    state.result = {
      ...res,
      method: state.params.method,
      sigma: state.params.sigmaPx,
      weighted: state.params.weighted,
      frameMode: state.params.frameMode,
      stimulusName: state.params.selectedStimulus && state.params.selectedStimulus !== ALL_STIMULI
        ? state.params.selectedStimulus : (state.csv.stimuli[0] || ''),
    };

    if (res.nOutside > 0) {
      toastInfo(`${res.nOutside} фиксаций вне стимула не учитывались.`, 6000);
    }
    renderResults();
    setBusy(false);
    toastSuccess(`Готово · ${res.nFixations} фиксаций · NSS = ${fmt(res.model.nss, 3)} · AUC = ${fmt(res.model.auc, 3)}`);
  } catch (err) {
    setBusy(false);
    if (!state.result) hideResults();
    toastError(err.message || String(err), 8000);
    console.error(err);
  }
}

function countParticipants(points) {
  const set = new Set();
  for (const p of points) if (p.participant != null && p.participant !== '') set.add(p.participant);
  return set.size;
}

/* ============================================================
   Рендер результатов
   ============================================================ */

function renderResults() {
  if (!state.result) return;
  dom.results.hidden = false;
  renderEvalMetrics();
  renderBenchTable();
  renderParticipants();
  renderStages();
}

function renderEvalMetrics() {
  const r = state.result;
  const m = r.model;
  const cards = [
    { label: 'CC (Pearson r)', value: fmt(m.cc, 3),  hint: interpretR(m.cc) },
    { label: 'NSS',            value: fmt(m.nss, 3), hint: interpretNSS(m.nss) },
    { label: 'AUC-Judd',       value: fmt(m.auc, 3), hint: interpretAUC(m.auc) },
    { label: 'sAUC',           value: fmt(m.sauc, 3),
      hint: isFinite(m.sauc) ? interpretSAUC(m.sauc) : 'нужны фиксации на других стимулах того же CSV' },
    { label: 'SIM',            value: fmt(m.sim, 3), hint: 'пересечение распределений, 0…1' },
    { label: 'KL',             value: fmt(m.kl, 3),  hint: 'расхождение, меньше — лучше' },
    {
      label: 'Фиксаций',
      value: String(r.nFixations),
      hint: (r.nParticipants > 0 ? `от ${r.nParticipants} участник${pluralPart(r.nParticipants)}` : 'учтено')
        + (r.nOutside ? ` · вне стимула ${r.nOutside}` : ''),
    },
  ];

  dom.metricsBox.innerHTML = cards.map((c) => `
    <div class="metric-card" title="${escapeAttr(c.hint)}">
      <div class="metric-label">${c.label}</div>
      <div class="metric-value">${c.value}</div>
      <div class="metric-key">${escapeHtml(c.hint)}</div>
    </div>
  `).join('');
}

function renderBenchTable() {
  const r = state.result;
  const rows = [
    ['Модель · ' + METHOD_LABELS[r.method], r.model, 'row-model'],
    ['Центральный baseline', r.center, ''],
    ['Согласованность участников (split-half)', r.ceiling, ''],
  ];
  let html = '<thead><tr><th></th>' + EVAL_KEYS.map(([, l]) => `<th>${l}</th>`).join('') + '</tr></thead><tbody>';
  for (const [label, m, cls] of rows) {
    html += `<tr class="${cls}"><td>${escapeHtml(label)}</td>`;
    html += EVAL_KEYS.map(([k]) => `<td class="num${m ? '' : ' dim'}">${m ? fmt(m[k], 3) : '—'}</td>`).join('');
    html += '</tr>';
  }
  html += '</tbody>';
  dom.benchTable.innerHTML = html;

  const notes = [];
  if (r.model.nss <= r.center.nss || r.model.auc <= r.center.auc) {
    notes.push('⚠ Модель не лучше простой гауссианы в центре кадра хотя бы по одной из метрик NSS/AUC — '
      + 'соответствие может объясняться центральным сдвигом взгляда, а не низкоуровневой заметностью.');
  }
  if (!r.ceiling) {
    notes.push('Верхний предел не посчитан: нужны идентификаторы как минимум двух участников.');
  } else if (r.ceiling.nParticipants < 6) {
    notes.push(`Верхний предел оценён по ${r.ceiling.nParticipants} участникам — оценка шумная.`);
  }
  if (!isFinite(r.model.sauc)) {
    notes.push('sAUC требует фиксаций на других стимулах: загрузите CSV со всеми стимулами эксперимента.');
  }
  notes.push('Центральный baseline — гауссиана с σ = ¼ ширины и высоты кадра. Split-half: участники 10 раз '
    + 'случайно делятся пополам, карта одной половины предсказывает фиксации другой. SIM и KL для предела '
    + 'пессимистичны: карта половины выборки разрежена, поэтому KL предела может оказаться хуже, чем у модели.');
  dom.benchNote.innerHTML = notes.map(escapeHtml).join('<br>');
}

function renderParticipants() {
  const pp = state.result.pp;
  if (!pp) {
    dom.ppBlock.hidden = true;
    return;
  }
  dom.ppBlock.hidden = false;
  let html = '<thead><tr><th>Участник</th><th>Фиксаций</th><th>NSS</th><th>AUC-Judd</th><th>CC</th></tr></thead><tbody>';
  for (const r of pp.rows) {
    html += `<tr><td>${escapeHtml(String(r.participant))}</td><td class="num">${r.n}</td>
      <td class="num">${fmt(r.nss, 3)}</td><td class="num">${fmt(r.auc, 3)}</td><td class="num">${fmt(r.cc, 3)}</td></tr>`;
  }
  const ci = (c) => `${fmt(c.mean, 3)} [${fmt(c.lo, 3)}; ${fmt(c.hi, 3)}]`;
  html += `<tr class="row-summary"><td>M [95 % ДИ], n = ${pp.rows.length}</td><td></td>
    <td class="num">${ci(pp.nss)}</td><td class="num">${ci(pp.auc)}</td><td class="num">${ci(pp.cc)}</td></tr>`;
  html += '</tbody>';
  dom.ppTable.innerHTML = html;
}

function interpretR(r) {
  if (!isFinite(r)) return '—';
  const a = Math.abs(r);
  if (a < 0.1) return 'нет связи';
  if (a < 0.3) return 'слабая';
  if (a < 0.5) return 'умеренная';
  if (a < 0.7) return 'заметная';
  return 'сильная';
}

function interpretNSS(n) {
  if (!isFinite(n)) return '—';
  if (n < 0.5) return 'модель ≈ случайной';
  if (n < 1.0) return 'слабое предсказание';
  if (n < 2.0) return 'уверенное предсказание';
  return 'высокое соответствие';
}

function interpretAUC(a) {
  if (!isFinite(a)) return '—';
  if (a < 0.55) return '≈ случайно';
  if (a < 0.65) return 'слабое';
  if (a < 0.75) return 'среднее';
  if (a < 0.85) return 'хорошее';
  return 'высокое';
}

function interpretSAUC(a) {
  if (a < 0.53) return '≈ не лучше общих привычек взгляда';
  if (a < 0.6) return 'слабое';
  if (a < 0.7) return 'среднее';
  return 'хорошее';
}

function renderStages() {
  const { sal, fixmap, diff, method, weighted } = state.result;
  const { origImage, origW, origH } = state.stim;

  const maxW = 460;
  const ratio = Math.min(1, maxW / origW);
  const dispW = Math.max(1, Math.round(origW * ratio));
  const dispH = Math.max(1, Math.round(origH * ratio));
  const alpha = 0.7;

  const stageA = renderOverlay(origImage, sal,    sal.width, sal.height, dispW, dispH, 'jet', alpha);
  const stageB = renderOverlay(origImage, fixmap, fixmap.width, fixmap.height, dispW, dispH, 'jet', alpha);
  drawFixationDots(stageB, state.result.points, sal.width, sal.height);
  const stageC = renderDiffStage(origImage, diff, dispW, dispH);

  dom.stageRow.innerHTML = '';
  dom.stageRow.appendChild(makeStage('Салиентность', `${METHOD_LABELS[method]}`, stageA));
  dom.stageRow.appendChild(makeStage('Айтрекинг', `KDE, σ = ${state.result.sigma} px${weighted ? ', вес = длительность' : ''}`, stageB));
  dom.stageRow.appendChild(makeStage('Разница', 'salience − fixation', stageC));
}

/** Точки фиксаций поверх карты — чтобы видеть, что координаты легли правильно. */
function drawFixationDots(canvas, points, gw, gh) {
  const ctx = canvas.getContext('2d');
  const kx = canvas.width / gw, ky = canvas.height / gh;
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.strokeStyle = 'rgba(0,0,0,0.8)';
  ctx.lineWidth = 1;
  for (const p of points) {
    ctx.beginPath();
    ctx.arc(p.u * gw * kx, p.v * gh * ky, 2.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

function makeStage(title, subtitle, canvas) {
  const wrap = document.createElement('div');
  wrap.className = 'stage-card';
  wrap.innerHTML = `
    <div class="stage-card-head">
      <div class="stage-card-title">${escapeHtml(title)}</div>
      <div class="stage-card-sub">${escapeHtml(subtitle)}</div>
    </div>
    <div class="stage-card-body"></div>
  `;
  wrap.querySelector('.stage-card-body').appendChild(canvas);
  return wrap;
}

/**
 * Разностная карта — diverging colormap blue→white→red.
 * Положительные значения (модель переоценила) — красные, отрицательные (недооценила) — синие.
 */
function renderDiffStage(srcImg, diff, dispW, dispH) {
  let maxAbs = 0;
  for (let i = 0; i < diff.length; i++) {
    const a = Math.abs(diff[i]);
    if (a > maxAbs) maxAbs = a;
  }
  if (maxAbs === 0) maxAbs = 1;

  const w = diff.width, h = diff.height;
  const small = document.createElement('canvas');
  small.width = w;
  small.height = h;
  const sctx = small.getContext('2d');
  const img = sctx.createImageData(w, h);
  for (let i = 0; i < diff.length; i++) {
    const v = diff[i] / maxAbs;
    const [r, g, b] = divergingColormap(v);
    const a = Math.round(Math.min(1, Math.abs(v) + 0.15) * 200);
    img.data[i * 4]     = r;
    img.data[i * 4 + 1] = g;
    img.data[i * 4 + 2] = b;
    img.data[i * 4 + 3] = a;
  }
  sctx.putImageData(img, 0, 0);

  const out = document.createElement('canvas');
  out.width = dispW;
  out.height = dispH;
  const octx = out.getContext('2d');
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(srcImg, 0, 0, dispW, dispH);
  octx.drawImage(small, 0, 0, dispW, dispH);
  return out;
}

/** Простая diverging colormap: −1 → синий, 0 → серый, +1 → красный. */
function divergingColormap(v) {
  const t = (v + 1) / 2;
  if (t < 0.5) {
    const k = t * 2;
    return [Math.round(60 + 195 * k), Math.round(60 + 195 * k), 220];
  }
  const k = (t - 0.5) * 2;
  return [220, Math.round(255 - 195 * k), Math.round(255 - 195 * k)];
}

/* ============================================================
   Пакетный расчёт
   ============================================================ */

async function handleBatchImages(files) {
  const { ok, errors } = await loadImageFiles(files);
  if (errors.length) toastError(`Не удалось загрузить ${errors.length} из ${files.length} файлов`);
  const byName = new Map(state.batch.images.map((im) => [im.name, im]));
  for (const im of ok) byName.set(im.name, im);
  state.batch.images = [...byName.values()];
  renderBatchInfo();
}

/** Пары (стимул CSV ↔ изображение). */
function batchPairs() {
  const pairs = [];
  for (const s of state.csv.stimuli) {
    const img = state.batch.images.find((im) => matchStimulus([s], im.name));
    if (img) pairs.push({ stimulus: s, img });
  }
  return pairs;
}

function renderBatchInfo() {
  const hasStimCol = !!state.csv.parsed && !!state.csv.mapping?.stimulus && state.csv.stimuli.length > 0;
  dom.batch.hidden = !hasStimCol;
  if (!hasStimCol) return;
  const pairs = batchPairs();
  const unmatched = state.csv.stimuli.length - pairs.length;
  dom.batchInfo.textContent = state.batch.images.length
    ? `изображений: ${state.batch.images.length} · сопоставлено стимулов: ${pairs.length} из ${state.csv.stimuli.length}`
      + (unmatched ? ` · без изображения: ${unmatched}` : '')
    : `в CSV стимулов: ${state.csv.stimuli.length}`;
  dom.batchRun.disabled = pairs.length === 0;
}

async function runBatch() {
  const pairs = batchPairs();
  if (!pairs.length) return;

  // Фиксации всех стимулов (сопоставленных) и их относительные координаты — для sAUC
  const all = [];
  for (const { stimulus, img } of pairs) {
    const fixations = fixationsFor(stimulus, img);
    const frame = frameFor(img);
    const uv = [];
    if (frame) {
      for (const f of fixations) {
        const u = (f.x - frame.x0) / frame.w, v = (f.y - frame.y0) / frame.h;
        if (u >= 0 && u < 1 && v >= 0 && v < 1) uv.push({ u, v });
      }
    }
    all.push({ stimulus, img, fixations, uv });
  }

  const rows = [];
  dom.batchRun.disabled = true;
  for (let i = 0; i < all.length; i++) {
    const cur = all[i];
    dom.batchInfo.textContent = `расчёт ${i + 1} / ${all.length}: ${cur.stimulus}`;
    await new Promise((r) => setTimeout(r, 0));
    const neg = all.filter((o) => o !== cur).flatMap((o) => o.uv);
    try {
      if (!cur.fixations.length) throw new Error('нет фиксаций');
      const res = analyzeStimulus(cur.img, cur.fixations, neg, false);
      const pp = perParticipantSummary(res);
      rows.push({ stimulus: cur.stimulus, image: cur.img.name, res, pp, error: null });
    } catch (err) {
      rows.push({ stimulus: cur.stimulus, image: cur.img.name, res: null, error: err.message || String(err) });
    }
  }
  state.batch.rows = rows;
  state.batch.summary = batchSummary(rows);
  renderBatchTable();
  renderBatchInfo();
  toastSuccess(`Пакет готов · ${rows.filter((r) => r.res).length} из ${rows.length} стимулов`);
}

/** Для пакета участников не показываем построчно — только среднее NSS по участникам. */
function perParticipantSummary(res) {
  const pp = perParticipant(prepareMap(res.sal), res.points, res.sal.width, res.sal.height, res.frame, state.params.sigmaPx);
  return pp ? pp.nss : null;
}

function batchSummary(rows) {
  const ok = rows.filter((r) => r.res);
  if (ok.length < 1) return null;
  const pick = (fn) => meanCI95(ok.map(fn).filter((v) => isFinite(v)));
  const out = {};
  for (const [k] of EVAL_KEYS) {
    out[`model_${k}`] = pick((r) => r.res.model[k]);
    out[`center_${k}`] = pick((r) => r.res.center[k]);
    out[`ceiling_${k}`] = pick((r) => (r.res.ceiling ? r.res.ceiling[k] : NaN));
  }
  return out;
}

function renderBatchTable() {
  const rows = state.batch.rows;
  dom.batchResults.hidden = !rows.length;
  const head = ['Стимул', 'Фикс.', 'Уч.', ...EVAL_KEYS.map(([, l]) => l), 'NSS центр', 'AUC центр', 'NSS предел', 'AUC предел'];
  let html = '<thead><tr>' + head.map((h) => `<th>${escapeHtml(h)}</th>`).join('') + '</tr></thead><tbody>';
  for (const r of rows) {
    if (!r.res) {
      html += `<tr><td>${escapeHtml(r.stimulus)}</td><td colspan="${head.length - 1}" class="dim">ошибка: ${escapeHtml(r.error)}</td></tr>`;
      continue;
    }
    const m = r.res.model;
    html += `<tr><td title="${escapeAttr(r.image)}">${escapeHtml(r.stimulus)}</td>
      <td class="num">${r.res.nFixations}</td><td class="num">${r.res.nParticipants}</td>
      ${EVAL_KEYS.map(([k]) => `<td class="num">${fmt(m[k], 3)}</td>`).join('')}
      <td class="num">${fmt(r.res.center.nss, 3)}</td><td class="num">${fmt(r.res.center.auc, 3)}</td>
      <td class="num">${r.res.ceiling ? fmt(r.res.ceiling.nss, 3) : '—'}</td>
      <td class="num">${r.res.ceiling ? fmt(r.res.ceiling.auc, 3) : '—'}</td></tr>`;
  }
  const s = state.batch.summary;
  if (s) {
    const c = (x) => (isFinite(x.mean) ? `${fmt(x.mean, 3)}${isFinite(x.lo) ? ` ±${fmt(x.hi - x.mean, 3)}` : ''}` : '—');
    html += `<tr class="row-summary"><td>M ± 95 % ДИ</td><td></td><td></td>
      ${EVAL_KEYS.map(([k]) => `<td class="num">${c(s[`model_${k}`])}</td>`).join('')}
      <td class="num">${c(s.center_nss)}</td><td class="num">${c(s.center_auc)}</td>
      <td class="num">${c(s.ceiling_nss)}</td><td class="num">${c(s.ceiling_auc)}</td></tr>`;
  }
  html += '</tbody>';
  dom.batchTable.innerHTML = html;
}

/* ============================================================
   Экспорт
   ============================================================ */

function paramRows() {
  const p = state.params;
  const frame = frameFor(state.stim);
  return [
    ['# method', p.method],
    ['# kde_sigma_px', p.sigmaPx],
    ['# duration_weighted', p.weighted ? 1 : 0],
    ['# frame_mode', p.frameMode],
    ['# screen', p.screenW ?? '', p.screenH ?? ''],
    ['# stimulus_rect_x0_y0_w_h', ...(frame ? [frame.x0, frame.y0, frame.w, frame.h].map((v) => +v.toFixed(2)) : [])],
    ['# coords_normalized', p.norm ? 1 : 0],
    ['# center_baseline', 'gaussian sigma = W/4, H/4'],
    ['# ceiling', 'split-half between participants, 10 random splits x 2 directions'],
  ];
}

function exportCsvReport() {
  if (!state.result) return;
  const r = state.result;
  const rows = [];
  rows.push(['# Saliency vs Eye-tracking · ' + new Date().toISOString()]);
  rows.push(['# stimulus_image', state.stim.name]);
  rows.push(['# stimulus_in_csv', r.stimulusName]);
  rows.push(['# fixation_csv', state.csv.fileName]);
  rows.push(...paramRows());
  rows.push(['# n_fixations', r.nFixations, 'outside_stimulus', r.nOutside, 'n_participants', r.nParticipants,
    'sauc_negatives', r.nNegatives]);
  rows.push([]);
  rows.push(['metric', 'model', 'center_baseline', 'ceiling_split_half', 'interpretation']);
  const interp = { cc: interpretR, nss: interpretNSS, auc: interpretAUC, sauc: (v) => (isFinite(v) ? interpretSAUC(v) : '') };
  for (const [k] of EVAL_KEYS) {
    rows.push([k, num(r.model[k]), num(r.center[k]), r.ceiling ? num(r.ceiling[k]) : '', interp[k] ? interp[k](r.model[k]) : '']);
  }
  if (r.pp) {
    rows.push([]);
    rows.push(['participant', 'n_fixations', 'nss', 'auc_judd', 'cc']);
    for (const p of r.pp.rows) rows.push([p.participant, p.n, num(p.nss), num(p.auc), num(p.cc)]);
    rows.push([]);
    rows.push(['by_participant', 'n', 'mean', 'sd', 'ci95_lo', 'ci95_hi']);
    for (const k of ['nss', 'auc', 'cc']) {
      const c = r.pp[k];
      rows.push([k, c.n, num(c.mean), num(c.sd), num(c.lo), num(c.hi)]);
    }
  }

  const fname = `${stripExt(state.stim.name)}_eyetracking_report.csv`;
  downloadCSV(rows, fname);
  toastSuccess(`Сохранено: ${fname}`);
}

function exportBatchCsv() {
  const rows = [];
  rows.push(['# Saliency vs Eye-tracking · batch · ' + new Date().toISOString()]);
  rows.push(['# fixation_csv', state.csv.fileName]);
  rows.push(...paramRows().filter((r) => r[0] !== '# stimulus_rect_x0_y0_w_h'));
  rows.push([]);
  const keys = EVAL_KEYS.map(([k]) => k);
  rows.push(['stimulus', 'image', 'n_fixations', 'n_outside', 'n_participants',
    ...keys.map((k) => `model_${k}`), ...keys.map((k) => `center_${k}`), ...keys.map((k) => `ceiling_${k}`),
    'pp_nss_mean', 'pp_nss_ci_lo', 'pp_nss_ci_hi', 'error']);
  for (const r of state.batch.rows) {
    if (!r.res) { rows.push([r.stimulus, r.image, '', '', '', ...keys.map(() => ''), ...keys.map(() => ''), ...keys.map(() => ''), '', '', '', r.error]); continue; }
    const s = r.res;
    rows.push([r.stimulus, r.image, s.nFixations, s.nOutside, s.nParticipants,
      ...keys.map((k) => num(s.model[k])), ...keys.map((k) => num(s.center[k])),
      ...keys.map((k) => (s.ceiling ? num(s.ceiling[k]) : '')),
      r.pp ? num(r.pp.mean) : '', r.pp ? num(r.pp.lo) : '', r.pp ? num(r.pp.hi) : '', '']);
  }
  const sm = state.batch.summary;
  if (sm) {
    rows.push([]);
    rows.push(['summary_over_stimuli', 'n', 'mean', 'sd', 'ci95_lo', 'ci95_hi']);
    for (const [k, v] of Object.entries(sm)) rows.push([k, v.n, num(v.mean), num(v.sd), num(v.lo), num(v.hi)]);
  }
  downloadCSV(rows, 'eyetracking_batch_report.csv');
  toastSuccess('Сохранено: eyetracking_batch_report.csv');
}

async function exportZipMaps() {
  if (!state.result) return;
  setBusy(true, 'Готовим PNG…');
  await new Promise((r) => setTimeout(r, 0));

  const { sal, fixmap } = state.result;
  const { origImage, origW, origH, name } = state.stim;
  const cm = 'jet', alpha = 0.7;

  const entries = [];
  const overlayA = renderOverlay(origImage, sal,    sal.width, sal.height, origW, origH, cm, alpha);
  const overlayB = renderOverlay(origImage, fixmap, fixmap.width, fixmap.height, origW, origH, cm, alpha);
  const heatA    = renderHeatmap(sal,    sal.width, sal.height, origW, origH, cm, alpha);
  const heatB    = renderHeatmap(fixmap, fixmap.width, fixmap.height, origW, origH, cm, alpha);

  const base = stripExt(name);
  for (const [c, label] of [
    [overlayA, '_saliency_overlay.png'],
    [overlayB, '_fixations_overlay.png'],
    [heatA,    '_saliency_map.png'],
    [heatB,    '_fixations_map.png'],
  ]) {
    const blob = await canvasToBlob(c, 'image/png');
    if (blob) entries.push({ name: base + label, blob });
  }

  await downloadZip(entries, `${base}_eyetracking_maps.zip`);
  setBusy(false);
  toastSuccess(`Сохранено: ${entries.length} карт в ZIP`);
}

/* ============================================================
   UI utilities
   ============================================================ */

function fmt(v, d = 3) {
  return v == null || !isFinite(v) ? '—' : v.toFixed(d);
}

function num(v) {
  return v == null || !isFinite(v) ? '' : +v.toFixed(4);
}

function setBusy(busy, msg = '') {
  state.busy = busy;
  if (!dom.busy) return;
  dom.busy.hidden = !busy;
  if (busy) {
    const t = dom.busy.querySelector('.busy-text');
    if (t) t.textContent = msg;
  }
}

function hideResults() {
  dom.results.hidden = true;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function escapeAttr(s) { return escapeHtml(s); }

function pluralStim(n) {
  const m = n % 10;
  if (n % 100 >= 11 && n % 100 <= 14) return 'ов';
  if (m === 1) return '';
  if (m >= 2 && m <= 4) return 'а';
  return 'ов';
}

function pluralFix(n) {
  const m = n % 10;
  if (n % 100 >= 11 && n % 100 <= 14) return 'й';
  if (m === 1) return 'я';
  if (m >= 2 && m <= 4) return 'и';
  return 'й';
}

function pluralPart(n) {
  const m = n % 10;
  if (n % 100 >= 11 && n % 100 <= 14) return 'ов';
  if (m === 1) return 'а';
  return 'ов';
}
