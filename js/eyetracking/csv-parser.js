/* ============================================================
   csv-parser.js — универсальный парсер CSV/TSV
   Авто-определяет разделитель (`;` или `,` или `\t`).
   Предлагает соответствие колонок по нечёткому совпадению.
   ============================================================ */

/**
 * Парсит CSV-текст. Возвращает {columns, rows, separator}.
 * rows — массив объектов {colName: value}.
 */
export function parseCSV(text) {
  // BOM
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

  const lines = text.split(/\r?\n/);
  if (!lines.length) return { columns: [], rows: [], separator: ',' };

  // Определяем разделитель по первой строке
  const first = lines[0] || '';
  const counts = {
    ';': (first.match(/;/g) || []).length,
    ',': (first.match(/,/g) || []).length,
    '\t': (first.match(/\t/g) || []).length,
  };
  let sep = ',';
  let max = -1;
  for (const k of Object.keys(counts)) {
    if (counts[k] > max) { max = counts[k]; sep = k; }
  }

  const columns = parseLine(lines[0], sep);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const ln = lines[i];
    if (!ln || !ln.trim()) continue;
    const values = parseLine(ln, sep);
    const obj = {};
    for (let j = 0; j < columns.length; j++) {
      obj[columns[j]] = values[j] != null ? values[j] : '';
    }
    rows.push(obj);
  }
  return { columns, rows, separator: sep };
}

/** Парсинг одной строки CSV с учётом кавычек. */
function parseLine(line, sep) {
  const out = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuote = !inQuote;
    } else if (ch === sep && !inQuote) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/**
 * Эвристическое сопоставление колонок CSV с ожидаемыми ролями.
 * Возвращает {x, y, type, duration, participant, stimulus}
 * где значения — реальные имена колонок из CSV (или null).
 */
export function detectColumns(columns) {
  const lower = columns.map((c) => (c || '').toLowerCase().trim());

  const find = (...patterns) => {
    // exact match first
    for (const p of patterns) {
      const i = lower.indexOf(p);
      if (i !== -1) return columns[i];
    }
    // includes match
    for (const p of patterns) {
      const i = lower.findIndex((c) => c.includes(p));
      if (i !== -1) return columns[i];
    }
    return null;
  };

  return {
    x:           find('x_px', 'x_pixel', 'gaze_x', 'fix_x', 'x'),
    y:           find('y_px', 'y_pixel', 'gaze_y', 'fix_y', 'y'),
    type:        find('type', 'event', 'event_type', 'category'),
    duration:    find('dur_sec', 'duration', 'fix_dur', 'dur', 'fixation_duration'),
    participant: find('result_name', 'participant', 'subject', 'user', 'observer', 'id'),
    stimulus:    find('stimulus', 'image', 'filename', 'media', 'stim'),
  };
}

/**
 * Извлечь фиксации с числовыми координатами и опциональной длительностью.
 * Если в CSV есть колонка `type` — фильтруем по 'fixation' / 'fix'.
 * Если опция stimulus задана — фильтруем по точному совпадению имени.
 */
export function extractFixations(rows, mapping, opts = {}) {
  const { stimulus = null } = opts;
  const out = [];

  for (const row of rows) {
    if (mapping.type) {
      const t = String(row[mapping.type] || '').toLowerCase().trim();
      if (t && t !== 'fixation' && t !== 'fix') continue;
    }
    if (stimulus && mapping.stimulus) {
      if (row[mapping.stimulus] !== stimulus) continue;
    }

    const x = parseNum(row[mapping.x]);
    const y = parseNum(row[mapping.y]);
    if (!isFinite(x) || !isFinite(y)) continue;

    let duration = 1;
    if (mapping.duration) {
      const d = parseNum(row[mapping.duration]);
      if (isFinite(d) && d > 0) duration = d;
    }

    const participant = mapping.participant ? row[mapping.participant] : null;
    out.push({ x, y, duration, participant });
  }

  return out;
}

/** Найти все уникальные имена стимулов в CSV. */
export function uniqueStimuli(rows, mapping) {
  if (!mapping.stimulus) return [];
  const set = new Set();
  for (const row of rows) {
    const s = row[mapping.stimulus];
    if (s) set.add(s);
  }
  return [...set];
}

function parseNum(v) {
  if (v == null) return NaN;
  return parseFloat(String(v).replace(',', '.'));
}
