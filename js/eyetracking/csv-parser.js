/* ============================================================
   csv-parser.js — универсальный парсер CSV/TSV
   Авто-определяет разделитель (`;`, `,` или `\t`), корректно
   разбирает кавычки (включая переносы строк внутри кавычек).
   Сопоставляет колонки с ролями по ЦЕЛЫМ словам названия
   (а не по подстроке: раньше колонка «Export date» могла
   распознаться как X, потому что в ней есть буква «x»).
   ============================================================ */

/**
 * Парсит CSV-текст. Возвращает {columns, rows, separator}.
 * rows — массив объектов {colName: value}.
 */
export function parseCSV(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

  // Разделитель — по первой строке (вне кавычек)
  const firstLineEnd = text.search(/\r?\n/);
  const first = firstLineEnd === -1 ? text : text.slice(0, firstLineEnd);
  const counts = { ';': 0, ',': 0, '\t': 0 };
  let q = false;
  for (const ch of first) {
    if (ch === '"') q = !q;
    else if (!q && ch in counts) counts[ch]++;
  }
  let sep = ',';
  let max = -1;
  for (const k of Object.keys(counts)) {
    if (counts[k] > max) { max = counts[k]; sep = k; }
  }

  const records = parseRecords(text, sep);
  if (!records.length) return { columns: [], rows: [], separator: sep };

  // Имена колонок: обрезаем пробелы, дубликаты делаем уникальными
  const seen = new Map();
  const columns = records[0].map((c) => {
    const name = (c || '').trim();
    const n = seen.get(name) || 0;
    seen.set(name, n + 1);
    return n ? `${name} (${n + 1})` : name;
  });

  const rows = [];
  for (let i = 1; i < records.length; i++) {
    const values = records[i];
    if (values.length === 1 && !values[0].trim()) continue;
    const obj = {};
    for (let j = 0; j < columns.length; j++) {
      obj[columns[j]] = values[j] != null ? values[j] : '';
    }
    rows.push(obj);
  }
  return { columns, rows, separator: sep };
}

/** Посимвольный разбор CSV с учётом кавычек и "" внутри кавычек. */
function parseRecords(text, sep) {
  const out = [];
  let row = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }
        else inQuote = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuote = true;
    } else if (ch === sep) {
      row.push(cur);
      cur = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur);
      out.push(row);
      row = [];
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur !== '' || row.length) {
    row.push(cur);
    out.push(row);
  }
  return out;
}

/* ============================================================
   Распознавание колонок
   ============================================================ */

/** Роли колонок и подписи для UI. */
export const COLUMN_ROLES = [
  ['x',           'X'],
  ['y',           'Y'],
  ['type',        'Тип события'],
  ['duration',    'Длительность'],
  ['participant', 'Участник'],
  ['stimulus',    'Стимул'],
  ['fixIndex',    'Номер фиксации'],
];

const tokens = (name) => (name || '').toLowerCase().split(/[^a-zа-яё0-9]+/i).filter(Boolean);
const squash = (name) => (name || '').toLowerCase().replace(/[^a-zа-яё0-9]+/gi, '');

/**
 * Правила: exact — полные имена (без пробелов/подчёркиваний, в нижнем
 * регистре); score(tokens) — оценка по словам названия (0 — не подходит).
 */
const RULES = {
  x: {
    exact: ['x', 'xpx', 'xpixel', 'fixx', 'fixationx', 'gazex', 'currentfixx', 'fpogx', 'posx',
            'fixationpointx', 'meanx', 'avgx', 'fixxpx'],
    score: (t) => {
      if (!t.includes('x') || t.includes('y')) return 0;
      let s = 40;
      if (t.some((w) => /^(fix|fixation|fpog|fixpoint)$/.test(w))) s += 25;
      if (t.includes('px') || t.includes('pixel') || t.includes('pixels')) s += 10;
      if (t.some((w) => /^(mcs|mcsnorm|dacs|mm|norm|dva|deg|velocity|size|resolution|screen|offset|origin|camera)$/.test(w))) s -= 35;
      return s;
    },
  },
  y: {
    exact: ['y', 'ypx', 'ypixel', 'fixy', 'fixationy', 'gazey', 'currentfixy', 'fpogy', 'posy',
            'fixationpointy', 'meany', 'avgy', 'fixypx'],
    score: (t) => {
      if (!t.includes('y') || t.includes('x')) return 0;
      let s = 40;
      if (t.some((w) => /^(fix|fixation|fpog|fixpoint)$/.test(w))) s += 25;
      if (t.includes('px') || t.includes('pixel') || t.includes('pixels')) s += 10;
      if (t.some((w) => /^(mcs|mcsnorm|dacs|mm|norm|dva|deg|velocity|size|resolution|screen|offset|origin|camera)$/.test(w))) s -= 35;
      return s;
    },
  },
  type: {
    exact: ['type', 'eventtype', 'event', 'eyemovementtype', 'categorybinocular', 'category',
            'categoryleft', 'categoryright'],
    score: (t) => {
      if (t.includes('index') || t.includes('id')) return 0;
      if (t.includes('movement') && t.includes('type')) return 70;
      if (t.includes('category')) return 55;
      if (t.includes('event') && t.includes('type')) return 60;
      if (t.includes('type') && !t.includes('trial') && !t.includes('media')) return 30;
      return 0;
    },
  },
  duration: {
    exact: ['dursec', 'durms', 'duration', 'fixdur', 'fixationduration', 'currentfixduration',
            'gazeeventduration', 'eventduration', 'eventdurationms', 'fpogd', 'dur'],
    score: (t) => {
      if (t.includes('duration') && (t.includes('fixation') || t.includes('fix') || t.includes('event'))) return 60;
      if (t.includes('duration') || t.includes('dur')) return 40;
      return 0;
    },
  },
  participant: {
    exact: ['resultname', 'participant', 'participantname', 'participantid', 'subject', 'subjectname',
            'subjectid', 'observer', 'user', 'recordingsessionlabel', 'recordingname', 'sessionlabel', 'pid'],
    score: (t) => {
      if (t.includes('participant') || t.includes('subject') || t.includes('observer')) return 60;
      if (t.includes('recording') && (t.includes('name') || t.includes('label'))) return 45;
      if (t.includes('session') && t.includes('label')) return 40;
      return 0;
    },
  },
  stimulus: {
    exact: ['stimulus', 'stimulusname', 'presentedstimulusname', 'stim', 'image', 'imagename',
            'filename', 'media', 'medianame', 'stimuli'],
    score: (t) => {
      if (t.includes('stimulus') || t.includes('stim') || t.includes('stimuli')) return 60;
      if (t.includes('media') && t.includes('name')) return 55;
      if (t.includes('image')) return 45;
      if (t.includes('media')) return 35;
      return 0;
    },
  },
  fixIndex: {
    exact: ['eyemovementtypeindex', 'fixationindex', 'fixindex', 'currentfixindex', 'fixationid',
            'fixid', 'fpogid', 'indexbinocular'],
    score: (t) => {
      const idx = t.includes('index') || t.includes('id') || t.includes('number') || t.includes('nr');
      if (!idx) return 0;
      if (t.includes('fixation') || t.includes('fix') || t.includes('fpog')) return 60;
      if (t.includes('movement') && t.includes('type')) return 55;
      return 0;
    },
  },
};

/**
 * Эвристическое сопоставление колонок CSV с ролями.
 * Возвращает {x, y, type, duration, participant, stimulus, fixIndex}
 * — реальные имена колонок (или null).
 */
export function detectColumns(columns) {
  const taken = new Set();
  const out = {};
  for (const [role] of COLUMN_ROLES) {
    const rule = RULES[role];
    let best = null, bestScore = 0;
    for (const col of columns) {
      if (taken.has(col)) continue;
      const sq = squash(col);
      let sc = rule.exact.includes(sq) ? 100 - rule.exact.indexOf(sq) * 0.01 : rule.score(tokens(col));
      if (sc > bestScore) { bestScore = sc; best = col; }
    }
    out[role] = bestScore >= 30 ? best : null;
    if (out[role]) taken.add(out[role]);
  }
  return out;
}

/* ============================================================
   Извлечение фиксаций
   ============================================================ */

/** Значение колонки типа события считается фиксацией? Пустое — да. */
function isFixationType(v) {
  const t = String(v ?? '').toLowerCase().trim();
  return !t || t.startsWith('fix') || t === 'f' || t.startsWith('фикс');
}

/**
 * Извлечь фиксации с числовыми координатами.
 *
 *  • Если есть колонка типа — оставляем только фиксации.
 *  • Если задан stimulus — фильтр по точному совпадению.
 *  • Выгрузки «по отсчётам» (Tobii Pro Lab, BeGaze raw) повторяют одну
 *    фиксацию во многих строках. Повторы убираются: по номеру фиксации
 *    (если колонка есть), иначе — подряд идущие строки с тем же
 *    участником, стимулом и теми же координатами.
 *
 * Возвращает массив {x, y, duration, participant, stimulus};
 * у массива есть свойство .duplicatesRemoved.
 */
export function extractFixations(rows, mapping, opts = {}) {
  const { stimulus = null } = opts;
  const out = [];
  const seenIdx = new Set();
  let prevKey = null;
  let dup = 0;

  for (const row of rows) {
    if (mapping.type && !isFixationType(row[mapping.type])) continue;
    const stim = mapping.stimulus ? row[mapping.stimulus] : null;
    if (stimulus && mapping.stimulus && stim !== stimulus) continue;

    const x = parseNum(row[mapping.x]);
    const y = parseNum(row[mapping.y]);
    if (!isFinite(x) || !isFinite(y)) { prevKey = null; continue; }

    const participant = mapping.participant ? row[mapping.participant] : null;

    if (mapping.fixIndex) {
      const idx = row[mapping.fixIndex];
      if (idx !== '' && idx != null) {
        const key = `${participant}\u0001${stim}\u0001${idx}`;
        if (seenIdx.has(key)) { dup++; continue; }
        seenIdx.add(key);
      }
    } else {
      const key = `${participant}\u0001${stim}\u0001${x}\u0001${y}`;
      if (key === prevKey) { dup++; continue; }
      prevKey = key;
    }

    let duration = 1;
    if (mapping.duration) {
      const d = parseNum(row[mapping.duration]);
      if (isFinite(d) && d > 0) duration = d;
    }

    out.push({ x, y, duration, participant, stimulus: stim });
  }

  out.duplicatesRemoved = dup;
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

/** Нормализованное имя для сопоставления стимула и файла изображения. */
export function stimulusKey(name) {
  const base = String(name || '').split(/[\\/]/).pop();
  return base.replace(/\.[a-z0-9]{2,5}$/i, '').trim().toLowerCase();
}

/** Найти в списке стимулов CSV тот, что соответствует файлу изображения. */
export function matchStimulus(stimuli, fileName) {
  const key = stimulusKey(fileName);
  return stimuli.find((s) => stimulusKey(s) === key) || null;
}

export function parseNum(v) {
  if (v == null) return NaN;
  const s = String(v).trim();
  if (!s) return NaN;
  return parseFloat(s.replace(',', '.'));
}
