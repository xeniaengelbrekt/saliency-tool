/* ============================================================
   fixations-app.js — модуль сравнения карт айтрекинга
   и моделей салиентности.

   Точка входа отдельной страницы fixations.html.
   Использует общие алгоритмы салиентности из js/algorithms/.
   ============================================================ */

import { loadImageFile, TARGET_SIZE } from './loader.js';
import { computeSaliency, METHOD_LABELS } from './algorithms/index.js';
import { renderHeatmap, renderOverlay, canvasToBlob } from './render.js';
import { getColormap } from './colormap.js';
import { downloadCSV, downloadBlob, downloadZip, stripExt } from './export.js';
import { toastError, toastSuccess, toastInfo } from './toast.js';
import {
  parseCSV, detectColumns, extractFixations, uniqueStimuli,
} from './eyetracking/csv-parser.js';
import {
  buildFixationMap, pearsonR, computeNSS, computeAUCJudd, differenceMap, TARGET,
} from './eyetracking/fixmap.js';

/* ============================================================
   Состояние
   ============================================================ */

const state = {
  stim: null,           // {imageData, origImage, origW, origH, name, ...}
  csv: {
    raw: null,
    parsed: null,
    mapping: null,
    stimuli: [],
    fileName: '',
    coordsBounds: null,  // {minX, maxX, minY, maxY} по фиксациям
  },
  params: {
    method: 'ft',
    sigmaPx: 30,
    selectedStimulus: '',
    frameW: null,        // null → возьмём из размера изображения
    frameH: null,
  },
  result: null,         // {sal, fixmap, diff, metrics}
  busy: false,
};

const dom = {};

const METHOD_HINTS = {
  ft:    'цветовая салиентность через CIE Lab',
  dog:   'многомасштабный контраст яркости',
  local: 'быстрый локальный контраст',
  sr:    'спектральный остаток',
};

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
  dom.stimDz       = document.getElementById('stim-dropzone');
  dom.stimFile     = document.getElementById('stim-file');
  dom.stimPick     = document.getElementById('stim-pick');
  dom.stimInfo     = document.getElementById('stim-info');

  dom.csvDz        = document.getElementById('csv-dropzone');
  dom.csvFile      = document.getElementById('csv-file');
  dom.csvPick      = document.getElementById('csv-pick');
  dom.csvInfo      = document.getElementById('csv-info');

  dom.params       = document.getElementById('params');
  dom.method       = document.getElementById('param-method');
  dom.sigma        = document.getElementById('param-sigma');
  dom.sigmaVal     = document.getElementById('param-sigma-val');
  dom.stimFilter   = document.getElementById('param-stim-filter');
  dom.frameW       = document.getElementById('frame-w');
  dom.frameH       = document.getElementById('frame-h');
  dom.frameReset   = document.getElementById('frame-reset');
  dom.frameHint    = document.getElementById('frame-hint');
  dom.runBtn       = document.getElementById('run-btn');

  dom.results      = document.getElementById('results');
  dom.busy         = document.getElementById('busy');
  dom.metricsBox   = document.getElementById('eval-metrics');
  dom.stageRow     = document.getElementById('stage-row');
  dom.dlCsv        = document.getElementById('dl-csv');
  dom.dlZip        = document.getElementById('dl-zip');
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
  dom.method.addEventListener('change', () => {
    state.params.method = dom.method.value;
  });
  dom.sigma.addEventListener('input', () => {
    state.params.sigmaPx = +dom.sigma.value;
    dom.sigmaVal.textContent = state.params.sigmaPx;
  });
  dom.stimFilter.addEventListener('change', () => {
    state.params.selectedStimulus = dom.stimFilter.value;
    renderCsvInfo();
    updateFrameHint();
  });

  // ---- размер кадра ----
  dom.frameW.addEventListener('input', () => {
    const v = parseInt(dom.frameW.value, 10);
    state.params.frameW = isFinite(v) && v > 0 ? v : null;
    updateFrameHint();
  });
  dom.frameH.addEventListener('input', () => {
    const v = parseInt(dom.frameH.value, 10);
    state.params.frameH = isFinite(v) && v > 0 ? v : null;
    updateFrameHint();
  });
  dom.frameReset.addEventListener('click', () => {
    if (!state.stim) return;
    state.params.frameW = state.stim.origW;
    state.params.frameH = state.stim.origH;
    dom.frameW.value = state.stim.origW;
    dom.frameH.value = state.stim.origH;
    updateFrameHint();
  });

  // ---- кнопки ----
  dom.runBtn.addEventListener('click', runComparison);
  dom.dlCsv.addEventListener('click', exportCsvReport);
  dom.dlZip.addEventListener('click', exportZipMaps);
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
    // По умолчанию — размер кадра = размеру изображения. Пользователь может переопределить.
    if (state.params.frameW == null) state.params.frameW = state.stim.origW;
    if (state.params.frameH == null) state.params.frameH = state.stim.origH;
    if (dom.frameW) dom.frameW.value = state.params.frameW;
    if (dom.frameH) dom.frameH.value = state.params.frameH;
    renderStimInfo();
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
    if (file.size > 50 * 1024 * 1024) {
      toastError(
        `Файл ${file.name} слишком большой (${(file.size / 1024 / 1024).toFixed(1)} МБ). ` +
        `Ожидается CSV с фиксациями — обычно меньше 10 МБ. Возможно, это не тот файл.`
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

    const mapping = detectColumns(parsed.columns);

    if (!mapping.x || !mapping.y) {
      const sample = parsed.columns.slice(0, 12).join(', ');
      toastError(
        `В CSV не нашлись колонки координат (ожидаются x_px / y_px или x / y). ` +
        `Найдены колонки: ${sample}${parsed.columns.length > 12 ? '…' : ''}. ` +
        `Переименуйте нужные колонки в исходном файле и загрузите повторно.`,
        9000
      );
      return;
    }

    state.csv.raw = text;
    state.csv.parsed = parsed;
    state.csv.mapping = mapping;
    state.csv.stimuli = uniqueStimuli(parsed.rows, mapping);
    state.csv.fileName = file.name;
    state.params.selectedStimulus = state.csv.stimuli.length === 1
      ? state.csv.stimuli[0]
      : '';

    // Если изображение ещё не загружено — авто-предложить размер кадра по координатам
    if (!state.stim) {
      const bounds = getCoordsBounds();
      if (bounds) {
        const guessW = roundUpToCommon(Math.ceil(bounds.maxX));
        const guessH = roundUpToCommon(Math.ceil(bounds.maxY));
        if (state.params.frameW == null) {
          state.params.frameW = guessW;
          if (dom.frameW) dom.frameW.value = guessW;
        }
        if (state.params.frameH == null) {
          state.params.frameH = guessH;
          if (dom.frameH) dom.frameH.value = guessH;
        }
      }
    }

    const fixCount = countFixations();
    if (fixCount === 0) {
      toastInfo(
        `CSV распознан, но после фильтрации не осталось фиксаций. ` +
        `Проверьте: тип события (type=fixation) и/или выбор стимула в параметрах.`,
        7000
      );
    } else {
      toastSuccess(`CSV распознан · ${fixCount} фиксаций`);
    }

    renderCsvInfo();
    renderStimulusFilter();
    updateFrameHint();
    updateRunButton();
  } catch (err) {
    toastError(err.message || String(err));
  }
}

/** Подсказать «обычный» размер монитора по верхней координате. */
function roundUpToCommon(v) {
  const common = [800, 1024, 1280, 1366, 1440, 1600, 1680, 1920, 2048, 2560, 3840,
                  600, 720, 768, 800, 900, 1050, 1080, 1200, 1440, 1600, 2160];
  const sorted = common.filter((c) => c >= v).sort((a, b) => a - b);
  if (sorted.length) return sorted[0];
  return Math.ceil(v / 100) * 100;
}

function renderCsvInfo() {
  const { parsed, mapping, fileName, stimuli } = state.csv;
  if (!parsed) {
    dom.csvInfo.hidden = true;
    return;
  }

  // Сколько фиксаций при текущих настройках
  const fixCount = countFixations();

  dom.csvInfo.hidden = false;
  dom.csvInfo.innerHTML = `
    <span class="upload-tag">CSV</span>
    <span class="upload-name">${escapeHtml(fileName)}</span>
    <span class="upload-meta">
      ${parsed.rows.length} строк · ${stimuli.length || '—'} стимул${pluralStim(stimuli.length)} ·
      ${fixCount} фиксаци${pluralFix(fixCount)}
    </span>
    <button class="upload-replace" data-act="replace-csv" type="button">↻ заменить</button>
    <div class="upload-mapping">
      <strong>Распознано:</strong>
      x = <code>${escapeHtml(mapping.x || '?')}</code> ·
      y = <code>${escapeHtml(mapping.y || '?')}</code> ·
      type = <code>${escapeHtml(mapping.type || '—')}</code> ·
      duration = <code>${escapeHtml(mapping.duration || '—')}</code> ·
      participant = <code>${escapeHtml(mapping.participant || '—')}</code>
    </div>
  `;
  dom.csvInfo.querySelector('[data-act="replace-csv"]').addEventListener('click', () => {
    state.csv = { raw: null, parsed: null, mapping: null, stimuli: [], fileName: '' };
    state.result = null;
    renderCsvInfo();
    renderStimulusFilter();
    hideResults();
    updateRunButton();
    dom.csvFile.value = '';
  });
}

function renderStimulusFilter() {
  const list = state.csv.stimuli;
  if (!list.length) {
    dom.stimFilter.innerHTML = '<option value="">— нет данных —</option>';
    return;
  }
  let html = '';
  if (list.length > 1) html += '<option value="">все фиксации в файле</option>';
  for (const s of list) {
    const sel = s === state.params.selectedStimulus ? ' selected' : '';
    html += `<option value="${escapeAttr(s)}"${sel}>${escapeHtml(s)}</option>`;
  }
  dom.stimFilter.innerHTML = html;
}

function countFixations() {
  if (!state.csv.parsed || !state.csv.mapping) return 0;
  return extractFixations(
    state.csv.parsed.rows,
    state.csv.mapping,
    { stimulus: state.params.selectedStimulus || null }
  ).length;
}

/** Границы координат фиксаций — для подсказки про размер кадра. */
function getCoordsBounds() {
  if (!state.csv.parsed) return null;
  const fixs = extractFixations(
    state.csv.parsed.rows,
    state.csv.mapping,
    { stimulus: state.params.selectedStimulus || null }
  );
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

/** Подсказка под полями размера кадра — соотносит размер с координатами. */
function updateFrameHint() {
  if (!dom.frameHint) return;
  if (!state.csv.parsed) {
    dom.frameHint.textContent = '';
    return;
  }
  const bounds = getCoordsBounds();
  if (!bounds) { dom.frameHint.textContent = ''; return; }

  const fw = state.params.frameW;
  const fh = state.params.frameH;
  const maxX = Math.round(bounds.maxX);
  const maxY = Math.round(bounds.maxY);

  if (!fw || !fh) {
    dom.frameHint.innerHTML = `координаты до <strong>${maxX} × ${maxY}</strong>`;
    dom.frameHint.className = 'frame-hint';
    return;
  }

  const xOverflow = maxX > fw * 1.02;
  const yOverflow = maxY > fh * 1.02;
  if (xOverflow || yOverflow) {
    dom.frameHint.innerHTML = `⚠ координаты до <strong>${maxX} × ${maxY}</strong> — превышают кадр ${fw} × ${fh}`;
    dom.frameHint.className = 'frame-hint frame-hint-warn';
  } else {
    dom.frameHint.innerHTML = `координаты до <strong>${maxX} × ${maxY}</strong> — укладываются в кадр ${fw} × ${fh}`;
    dom.frameHint.className = 'frame-hint frame-hint-ok';
  }
}

function renderParams() {
  dom.method.value = state.params.method;
  dom.sigma.value = state.params.sigmaPx;
  dom.sigmaVal.textContent = state.params.sigmaPx;
}

function updateRunButton() {
  const ready = !!state.stim && !!state.csv.parsed;
  dom.runBtn.disabled = !ready;
  dom.params.hidden = !state.csv.parsed;
}

/* ============================================================
   Главный расчёт
   ============================================================ */

async function runComparison() {
  if (!state.stim || !state.csv.parsed) return;

  setBusy(true, 'Считаем салиентность…');
  await new Promise((r) => setTimeout(r, 0));

  try {
    const fixations = extractFixations(
      state.csv.parsed.rows,
      state.csv.mapping,
      { stimulus: state.params.selectedStimulus || null }
    );

    if (!fixations.length) {
      toastError('После фильтрации не осталось ни одной фиксации. Проверьте: правильно ли распознался тип события и фильтр по стимулу.');
      setBusy(false);
      return;
    }

    // Размер кадра, в котором регистрировались фиксации.
    // По умолчанию — размер изображения стимула; пользователь может переопределить.
    const frameW = state.params.frameW || state.stim.origW;
    const frameH = state.params.frameH || state.stim.origH;

    // Если координаты сильно выходят за пределы кадра — мягкое предупреждение
    const bounds = getCoordsBounds();
    if (bounds && (bounds.maxX > frameW * 1.05 || bounds.maxY > frameH * 1.05)) {
      toastInfo(
        `Координаты доходят до ${Math.round(bounds.maxX)} × ${Math.round(bounds.maxY)}, ` +
        `а указанный размер кадра ${frameW} × ${frameH}. ` +
        `Часть точек окажется за пределами кадра. ` +
        `Уточните размер кадра в параметрах.`,
        8000
      );
    }

    setBusy(true, 'Карта салиентности…');
    await new Promise((r) => setTimeout(r, 0));
    const sal = computeSaliency(state.stim.imageData, state.params.method);

    setBusy(true, 'Карта айтрекинга (KDE)…');
    await new Promise((r) => setTimeout(r, 0));
    const fixmap = buildFixationMap(fixations, frameW, frameH, state.params.sigmaPx);

    setBusy(true, 'Метрики…');
    await new Promise((r) => setTimeout(r, 0));
    const r  = pearsonR(sal, fixmap);
    const ns = computeNSS(fixations, sal, frameW, frameH);
    const auc = computeAUCJudd(fixations, sal, frameW, frameH);

    const diff = differenceMap(sal, fixmap);

    state.result = {
      sal, fixmap, diff,
      fixations,
      method: state.params.method,
      sigma: state.params.sigmaPx,
      stimulusName: state.params.selectedStimulus || state.csv.stimuli[0] || '',
      metrics: {
        pearson: r,
        nss: ns,
        auc: auc,
        nFixations: fixations.length,
        nParticipants: countParticipants(fixations),
      },
    };

    renderResults();
    setBusy(false);
    toastSuccess(`Готово · ${fixations.length} фиксаций · NSS = ${ns.toFixed(3)} · AUC = ${auc.toFixed(3)}`);
  } catch (err) {
    setBusy(false);
    toastError(err.message || String(err));
    console.error(err);
  }
}

function countParticipants(fixations) {
  const set = new Set();
  for (const f of fixations) if (f.participant != null) set.add(f.participant);
  return set.size;
}

/* ============================================================
   Рендер результатов
   ============================================================ */

function renderResults() {
  if (!state.result) return;
  dom.results.hidden = false;

  renderEvalMetrics();
  renderStages();
}

function renderEvalMetrics() {
  const m = state.result.metrics;
  const cards = [
    {
      key: 'pearson',
      label: 'Pearson r',
      value: m.pearson.toFixed(3),
      hint: interpretR(m.pearson),
    },
    {
      key: 'nss',
      label: 'NSS',
      value: m.nss.toFixed(3),
      hint: interpretNSS(m.nss),
    },
    {
      key: 'auc',
      label: 'AUC-Judd',
      value: m.auc.toFixed(3),
      hint: interpretAUC(m.auc),
    },
    {
      key: 'n',
      label: 'Фиксаций',
      value: String(m.nFixations),
      hint: m.nParticipants > 0
        ? `от ${m.nParticipants} участник${pluralPart(m.nParticipants)}`
        : 'обработано',
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

function interpretR(r) {
  const a = Math.abs(r);
  if (a < 0.1) return 'нет связи';
  if (a < 0.3) return 'слабая';
  if (a < 0.5) return 'умеренная';
  if (a < 0.7) return 'заметная';
  return 'сильная';
}

function interpretNSS(n) {
  if (n < 0.5) return 'модель ≈ случайной';
  if (n < 1.0) return 'слабое предсказание';
  if (n < 2.0) return 'уверенное предсказание';
  return 'высокое соответствие';
}

function interpretAUC(a) {
  if (a < 0.55) return '≈ случайно';
  if (a < 0.65) return 'слабое';
  if (a < 0.75) return 'среднее';
  if (a < 0.85) return 'хорошее';
  return 'высокое';
}

function renderStages() {
  const { sal, fixmap, diff, method } = state.result;
  const { origImage, origW, origH } = state.stim;

  // Ограничим размер по ширине
  const maxW = 460;
  const ratio = Math.min(1, maxW / origW);
  const dispW = Math.max(1, Math.round(origW * ratio));
  const dispH = Math.max(1, Math.round(origH * ratio));

  const alpha = 0.7;

  const stageA = renderOverlay(origImage, sal,    TARGET, TARGET, dispW, dispH, 'jet', alpha);
  const stageB = renderOverlay(origImage, fixmap, TARGET, TARGET, dispW, dispH, 'jet', alpha);
  const stageC = renderDiffStage(origImage, diff, dispW, dispH);

  dom.stageRow.innerHTML = '';
  dom.stageRow.appendChild(makeStage('Салиентность', `${METHOD_LABELS[method]}`, stageA));
  dom.stageRow.appendChild(makeStage('Айтрекинг', `KDE, σ = ${state.result.sigma} px`, stageB));
  dom.stageRow.appendChild(makeStage('Разница', 'salience − fixation', stageC));
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
  // Найдём максимальную абсолютную разницу для нормировки
  let maxAbs = 0;
  for (let i = 0; i < diff.length; i++) {
    const a = Math.abs(diff[i]);
    if (a > maxAbs) maxAbs = a;
  }
  if (maxAbs === 0) maxAbs = 1;

  // Создаём небольшой canvas с diverging cmap
  const small = document.createElement('canvas');
  small.width = TARGET;
  small.height = TARGET;
  const sctx = small.getContext('2d');
  const img = sctx.createImageData(TARGET, TARGET);
  for (let i = 0; i < diff.length; i++) {
    const v = diff[i] / maxAbs;       // в [-1, +1]
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
    // blue to gray
    const k = t * 2;
    return [Math.round(60 + 195 * k), Math.round(60 + 195 * k), 220];
  } else {
    const k = (t - 0.5) * 2;
    return [220, Math.round(255 - 195 * k), Math.round(255 - 195 * k)];
  }
}

/* ============================================================
   Экспорт
   ============================================================ */

function exportCsvReport() {
  if (!state.result) return;
  const r = state.result;
  const m = r.metrics;
  const rows = [];
  rows.push(['# Saliency vs Eye-tracking · ' + new Date().toISOString()]);
  rows.push(['# stimulus', state.stim.name]);
  rows.push(['# fixation_csv', state.csv.fileName]);
  rows.push(['# method', r.method]);
  rows.push(['# kde_sigma_px', r.sigma]);
  rows.push([]);
  rows.push(['metric', 'value', 'interpretation']);
  rows.push(['pearson_r', m.pearson.toFixed(4), interpretR(m.pearson)]);
  rows.push(['nss',       m.nss.toFixed(4),    interpretNSS(m.nss)]);
  rows.push(['auc_judd',  m.auc.toFixed(4),    interpretAUC(m.auc)]);
  rows.push(['n_fixations', m.nFixations, '']);
  rows.push(['n_participants', m.nParticipants, '']);

  const fname = `${stripExt(state.stim.name)}_eyetracking_report.csv`;
  downloadCSV(rows, fname);
  toastSuccess(`Сохранено: ${fname}`);
}

async function exportZipMaps() {
  if (!state.result) return;
  setBusy(true, 'Готовим PNG…');
  await new Promise((r) => setTimeout(r, 0));

  const { sal, fixmap } = state.result;
  const { origImage, origW, origH, name } = state.stim;
  const settings = { colormap: 'jet', alpha: 0.7 };

  const entries = [];
  const overlayA = renderOverlay(origImage, sal,    TARGET, TARGET, origW, origH, settings.colormap, settings.alpha);
  const overlayB = renderOverlay(origImage, fixmap, TARGET, TARGET, origW, origH, settings.colormap, settings.alpha);
  const heatA    = renderHeatmap(sal,    TARGET, TARGET, origW, origH, settings.colormap, settings.alpha);
  const heatB    = renderHeatmap(fixmap, TARGET, TARGET, origW, origH, settings.colormap, settings.alpha);

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
  if (m >= 2 && m <= 4) return 'ов';
  return 'ов';
}
