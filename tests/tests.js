/* ============================================================
   tests.js — автоматические тесты вычислительного ядра.

   Запуск:
     • в браузере:  start.bat → http://localhost:8765/tests/
     • в Node ≥ 18: node tests/run-node.js   (то же выполняет CI на GitHub)

   Тесты делятся на три вида:
     1. Точные — известный ответ (AUC плоской карты = 0.5, ANOVA с
        известным F, цвет белого в CIE Lab = (100, 0, 0) и т.п.).
     2. Независимые реализации — алгоритм пересчитывается «в лоб»
        (наивные циклы, свёртка без разделения осей) и сравнивается
        с рабочим кодом.
     3. Свойства — симметрия (зеркальное отражение изображения
        зеркалит карту), независимость от пропорций, границы значений.
   Плюс «регрессионный» блок: эталонные числа на фиксированной
   синтетической сцене — ловит случайные изменения формул.
   ============================================================ */

import { meanOf, sdOf, meanCI95, oneWayAnova, fCdf, tCdf, tCritical, formatP } from '../js/stats.js';
import { normalize, withSize, resampleMap, cropMap } from '../js/algorithms/util.js';
import { rgbToLab, rgbToGray } from '../js/algorithms/color.js';
import { fft1d, fft2d } from '../js/algorithms/fft.js';
import { gaussBlur1D } from '../js/algorithms/blur.js';
import { computeSaliency } from '../js/algorithms/index.js';
import { computeMetrics, pearsonR, formatMetric } from '../js/metrics.js';
import { workSize, TARGET_SIZE } from '../js/loader.js';
import {
  parseCSV, detectColumns, extractFixations, matchStimulus, parseNum,
} from '../js/eyetracking/csv-parser.js';
import {
  mapFixations, buildFixationMap, centerBaseline, prepareMap, evaluateMap, computeNSS,
  computeAUCJudd, computeSAUC, computeSIM, computeKL, interObserverCeiling, perParticipant,
} from '../js/eyetracking/fixmap.js';

/* ---------------- мини-фреймворк ---------------- */

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const fail = (msg) => { throw new Error(msg); };
const ok = (cond, msg = 'условие не выполнено') => { if (!cond) fail(msg); };
const eq = (a, b, msg = '') => { if (a !== b) fail(`${msg} ожидалось ${b}, получено ${a}`); };
const near = (a, b, tol = 1e-6, msg = '') => {
  if (!(Math.abs(a - b) <= tol)) fail(`${msg} ожидалось ${b} ± ${tol}, получено ${a}`);
};
const finiteAll = (arr, msg = 'есть NaN/Infinity') => {
  for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i])) fail(`${msg} (индекс ${i})`);
};

/** Детерминированный ГПСЧ (mulberry32). */
function rng(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Искусственное изображение: fn(x, y) → [r, g, b]. */
function makeImage(w, h, fn) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fn(x, y);
      const i = (y * w + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

/** Серый фон с цветным квадратом. */
function sceneWithSquare(w, h, sx, sy, size, color = [200, 30, 30], bg = [128, 128, 128]) {
  return makeImage(w, h, (x, y) => (x >= sx && x < sx + size && y >= sy && y < sy + size ? color : bg));
}

function flipX(img) {
  const { width: w, height: h, data } = img;
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4, d = (y * w + (w - 1 - x)) * 4;
      out[d] = data[s]; out[d + 1] = data[s + 1]; out[d + 2] = data[s + 2]; out[d + 3] = 255;
    }
  }
  return { data: out, width: w, height: h };
}

function flipMapX(m, w, h) {
  const out = new Float32Array(m.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + (w - 1 - x)] = m[y * w + x];
  return out;
}

const argmax = (m) => { let k = 0; for (let i = 1; i < m.length; i++) if (m[i] > m[k]) k = i; return k; };
const map2d = (w, h, fn) => { const m = new Float32Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) m[y * w + x] = fn(x, y); return withSize(m, w, h); };

/* ============================================================
   stats.js
   ============================================================ */

test('stats: однофакторный ANOVA с известным ответом (F = 3, p = 0.125)', () => {
  const a = oneWayAnova([[1, 2, 3], [2, 3, 4], [3, 4, 5]]);
  near(a.F, 3, 1e-9, 'F');
  eq(a.df1, 2); eq(a.df2, 6);
  near(a.p, 0.125, 1e-6, 'p');
  near(a.eta2, 0.5, 1e-9, 'η²');
});

test('stats: ANOVA — одинаковые группы дают F = 0, p = 1; мало данных — null', () => {
  const a = oneWayAnova([[1, 2, 3], [1, 2, 3]]);
  near(a.F, 0, 1e-12); near(a.p, 1, 1e-9);
  eq(oneWayAnova([[1], [2]]), null);
  eq(oneWayAnova([[1, 2, 3]]), null);
});

test('stats: квантили и функции распределений (табличные значения)', () => {
  near(tCritical(0.975, 10), 2.2281, 1e-3, 't(10)');
  near(tCritical(0.975, 1), 12.7062, 1e-2, 't(1)');
  near(tCritical(0.975, 1000), 1.9623, 1e-3, 't(1000)');
  near(tCdf(0, 5), 0.5, 1e-9, 'tCdf(0)');
  near(fCdf(1, 1, 1), 0.5, 1e-6, 'fCdf(1;1,1)');
  near(fCdf(4.2565, 2, 9), 0.95, 2e-3, 'fCdf 95-й процентиль F(2,9)');
});

test('stats: доверительный интервал среднего', () => {
  const c = meanCI95([1, 2, 3, 4, 5]);
  near(c.mean, 3, 1e-12); near(c.sd, Math.sqrt(2.5), 1e-12);
  near(c.lo, 1.0368, 1e-3); near(c.hi, 4.9632, 1e-3);
  ok(Number.isNaN(meanCI95([1]).lo), 'при n = 1 границ нет');
  near(meanOf([2, 4]), 3); ok(Number.isNaN(sdOf([5])));
});

test('stats: formatP', () => {
  eq(formatP(0.0004), '< .001'); eq(formatP(0.125), '.125'); eq(formatP(NaN), '—');
});

/* ============================================================
   util.js — нормировка, ресэмплинг, вырезание
   ============================================================ */

test('normalize: результат в [0, 1], минимум = 0, сырой диапазон сохранён', () => {
  const r = rng(1); const m = new Float32Array(5000).map(() => 10 + 90 * r());
  const n = normalize(m);
  let lo = Infinity, hi = -Infinity;
  for (const v of n) { if (v < lo) lo = v; if (v > hi) hi = v; }
  near(lo, 0, 1e-9); near(hi, 1, 1e-9);
  ok(n.rawMax >= 99 && n.rawMin <= 11, 'rawMin/rawMax');
  ok(n.rawHi <= n.rawMax);
});

test('normalize: один выброс не сжимает остальную карту (робастность)', () => {
  const N = 10000; const m = new Float32Array(N);
  for (let i = 0; i < N; i++) m[i] = i / N;      // равномерно 0…1
  m[N - 1] = 1000;                                // выброс
  const n = normalize(m);
  let s = 0; for (let i = 0; i < N - 1; i++) s += n[i];
  ok(s / (N - 1) > 0.45, `среднее без выброса ${(s / (N - 1)).toFixed(3)} должно остаться ≈ 0.5`);
  eq(n[N - 1], 1, 'выброс обрезается до 1');
  eq(n.rawMax, 1000, 'истинный максимум сохранён для peak');
});

test('normalize: плоская карта → нули, без NaN', () => {
  const n = normalize(new Float32Array(2000).fill(7));
  finiteAll(n); ok(n.every((v) => v === 0));
});

test('resampleMap: тот же размер — идентичность; константа остаётся константой', () => {
  const m = map2d(7, 5, (x, y) => x * 3 + y);
  const same = resampleMap(m, 7, 5, 7, 5);
  for (let i = 0; i < m.length; i++) near(same[i], m[i], 1e-5);
  const c = resampleMap(withSize(new Float32Array(12).fill(0.4), 4, 3), 4, 3, 9, 13);
  for (const v of c) near(v, 0.4, 1e-6);
  eq(c.width, 9); eq(c.height, 13);
});

test('cropMap: вырезает без перенормировки; rawMax внутри/вне региона', () => {
  const W = 10, H = 10;
  const base = map2d(W, H, (x, y) => (x === 2 && y === 2 ? 1 : 0.25));
  base.rawMin = 0; base.rawHi = 8; base.rawMax = 20; base.rawMaxIdx = 2 * W + 2;
  const inside = cropMap(base, W, 0, 0, 5, 5);
  eq(inside.width, 5); eq(inside.height, 5); eq(inside[2 * 5 + 2], 1);
  eq(inside.rawMax, 20, 'глобальный пик внутри региона');
  const outside = cropMap(base, W, 5, 5, 10, 10);
  near(outside.rawMax, 0.25 * 8, 1e-5, 'вне региона — из нормированного значения');
  for (const v of outside) eq(v, 0.25);
});

/* ============================================================
   color, fft, blur
   ============================================================ */

test('CIE Lab: белый, чёрный, красный (табличные значения, D65)', () => {
  const lab = (rgb) => { const l = rgbToLab(makeImage(1, 1, () => rgb)); return [l.L[0], l.A[0], l.B[0]]; };
  const w = lab([255, 255, 255]); near(w[0], 100, 0.05); near(w[1], 0, 0.05); near(w[2], 0, 0.05);
  const k = lab([0, 0, 0]); near(k[0], 0, 0.01);
  const r = lab([255, 0, 0]); near(r[0], 53.24, 0.2); near(r[1], 80.09, 0.4); near(r[2], 67.20, 0.4);
  const g = lab([128, 128, 128]); near(g[0], 53.59, 0.2); near(g[1], 0, 0.05);
});

test('rgbToGray: коэффициенты Rec.601', () => {
  near(rgbToGray(makeImage(1, 1, () => [255, 0, 0]))[0], 0.299 * 255, 1e-3);
  near(rgbToGray(makeImage(1, 1, () => [0, 255, 0]))[0], 0.587 * 255, 1e-3);
});

test('FFT: совпадает с наивным ДПФ, прямое+обратное возвращает сигнал', () => {
  const n = 16; const r = rng(5);
  const xr = Float32Array.from({ length: n }, () => r() * 2 - 1);
  const xi = Float32Array.from({ length: n }, () => r() * 2 - 1);
  const re = Float32Array.from(xr), im = Float32Array.from(xi);
  fft1d(re, im, n, false);
  for (let k = 0; k < n; k++) {
    let sr = 0, si = 0;
    for (let t = 0; t < n; t++) {
      const a = -2 * Math.PI * k * t / n;
      sr += xr[t] * Math.cos(a) - xi[t] * Math.sin(a);
      si += xr[t] * Math.sin(a) + xi[t] * Math.cos(a);
    }
    near(re[k], sr, 1e-4, `Re[${k}]`); near(im[k], si, 1e-4, `Im[${k}]`);
  }
  fft1d(re, im, n, true);
  for (let t = 0; t < n; t++) { near(re[t], xr[t], 1e-5); near(im[t], xi[t], 1e-5); }
});

test('FFT 2D: прямое+обратное возвращает изображение', () => {
  const w = 8, h = 8; const r = rng(9);
  const src = Float32Array.from({ length: w * h }, () => r());
  const re = Float32Array.from(src), im = new Float32Array(w * h);
  fft2d(re, im, w, h, false); fft2d(re, im, w, h, true);
  for (let i = 0; i < w * h; i++) near(re[i], src[i], 1e-5);
});

test('Гауссово размытие = наивная двумерная свёртка с clamp-to-edge (независимая реализация)', () => {
  const w = 20, h = 15, sigma = 1.5; const r = rng(11);
  const src = Float32Array.from({ length: w * h }, () => r() * 255);
  const fast = gaussBlur1D(src, w, h, sigma);
  const half = Math.ceil(3 * sigma);
  const k1 = []; for (let i = -half; i <= half; i++) k1.push(Math.exp(-(i * i) / (2 * sigma * sigma)));
  const s = k1.reduce((a, b) => a + b, 0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let j = -half; j <= half; j++) {
        for (let i = -half; i <= half; i++) {
          const xx = Math.min(w - 1, Math.max(0, x + i)), yy = Math.min(h - 1, Math.max(0, y + j));
          acc += src[yy * w + xx] * (k1[i + half] / s) * (k1[j + half] / s);
        }
      }
      near(fast[y * w + x], acc, 0.02, `(${x},${y})`);
    }
  }
});

/* ============================================================
   алгоритмы салиентности
   ============================================================ */

const METHODS = ['ft', 'dog', 'local', 'sr'];

test('алгоритмы: размер карты = размеру входа, значения в [0, 1], нет NaN (все методы, неквадратные кадры)', () => {
  for (const method of METHODS) {
    for (const [w, h] of [[64, 48], [48, 64], [90, 30]]) {
      const img = sceneWithSquare(w, h, Math.floor(w * 0.6), Math.floor(h * 0.3), 8);
      const s = computeSaliency(img, method);
      eq(s.length, w * h, `${method} ${w}×${h} длина`);
      eq(s.width, w); eq(s.height, h);
      finiteAll(s, `${method} ${w}×${h}: NaN`);
      ok(s.every((v) => v >= 0 && v <= 1), `${method}: вне [0,1]`);
    }
  }
});

test('алгоритмы: яркий цветной квадрат на сером фоне — максимум карты на квадрате (FT, Local, DoG)', () => {
  const w = 96, h = 64, sx = 60, sy = 20, size = 12;
  const img = sceneWithSquare(w, h, sx, sy, size);
  for (const method of ['ft', 'local', 'dog']) {
    const s = computeSaliency(img, method);
    const k = argmax(s); const x = k % w, y = Math.floor(k / w);
    ok(x >= sx - 3 && x < sx + size + 3 && y >= sy - 3 && y < sy + size + 3,
      `${method}: максимум в (${x}, ${y}), квадрат (${sx}…${sx + size}, ${sy}…${sy + size})`);
  }
});

test('алгоритмы: плоское изображение — нулевая карта (FT, DoG, Local), SR — без NaN', () => {
  const flat = makeImage(40, 30, () => [100, 120, 140]);
  for (const method of ['ft', 'dog', 'local']) {
    const s = computeSaliency(flat, method);
    finiteAll(s); ok(s.every((v) => v === 0), `${method}: карта плоского изображения должна быть нулевой`);
  }
  finiteAll(computeSaliency(flat, 'sr'));
});

test('алгоритмы: зеркальное отражение изображения зеркалит карту (FT, DoG, Local)', () => {
  const w = 72, h = 48;
  const r = rng(21);
  const noise = makeImage(w, h, () => [100 + r() * 60, 100 + r() * 60, 100 + r() * 60]);
  // добавим несимметричный объект
  for (let y = 10; y < 22; y++) for (let x = 50; x < 64; x++) { const i = (y * w + x) * 4; noise.data[i] = 220; noise.data[i + 1] = 40; noise.data[i + 2] = 40; }
  const flipped = flipX(noise);
  for (const method of ['ft', 'dog', 'local']) {
    const a = computeSaliency(noise, method);
    const b = flipMapX(computeSaliency(flipped, method), w, h);
    ok(pearsonR(a, b) > 0.999, `${method}: корреляция карты и отражённой карты ${pearsonR(a, b).toFixed(5)}`);
  }
});

test('FT сверяется с независимой реализацией (наивные циклы, свёртка 5×5, формулы Lab из литературы)', () => {
  const w = 40, h = 30; const r = rng(33);
  const img = makeImage(w, h, (x, y) => [60 + (x * 4) % 150 + r() * 20, 80 + (y * 6) % 120, 100 + r() * 50]);
  const lin = (c) => { c /= 255; return c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92; };
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const lab = (i) => {
    const R = lin(img.data[i]), G = lin(img.data[i + 1]), B = lin(img.data[i + 2]);
    const X = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
    const Y = 0.2126729 * R + 0.7151522 * G + 0.0721750 * B;
    const Z = (0.0193339 * R + 0.1191920 * G + 0.9503041 * B) / 1.08883;
    return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
  };
  const L = []; for (let i = 0; i < w * h; i++) L.push(lab(i * 4));
  const mu = [0, 1, 2].map((c) => L.reduce((s, v) => s + v[c], 0) / L.length);
  const kk = [1, 4, 6, 4, 1]; const raw = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const blur = [0, 0, 0];
      for (let j = -2; j <= 2; j++) {
        for (let i = -2; i <= 2; i++) {
          const xx = Math.min(w - 1, Math.max(0, x + i)), yy = Math.min(h - 1, Math.max(0, y + j));
          const wt = kk[i + 2] * kk[j + 2] / 256;
          for (let c = 0; c < 3; c++) blur[c] += wt * L[yy * w + xx][c];
        }
      }
      raw[y * w + x] = Math.hypot(mu[0] - blur[0], mu[1] - blur[1], mu[2] - blur[2]);
    }
  }
  const expected = normalize(raw);
  const got = computeSaliency(img, 'ft');
  ok(pearsonR(expected, got) > 0.9999, `корреляция с независимой реализацией ${pearsonR(expected, got).toFixed(6)}`);
  near(got.rawMax, expected.rawMax, 0.05 * expected.rawMax / 100 + 0.2, 'rawMax (peak)');
});

test('SR: сжатие до 64×64 по площади — карта не зависит от кратного увеличения изображения', () => {
  // исходная сцена 128×96 и она же, увеличенная в 2 раза повторением пикселей (256×192):
  // после усреднения по площади до 64×64 получается один и тот же сигнал
  const r = rng(77);
  const small = makeImage(128, 96, (x, y) => { const v = 90 + 50 * Math.sin(x / 11) * Math.cos(y / 9) + r() * 25; return [v, v * 0.9, v * 1.1]; });
  for (let y = 40; y < 56; y++) for (let x = 70; x < 92; x++) { const i = (y * 128 + x) * 4; small.data[i] = 230; small.data[i + 1] = 40; small.data[i + 2] = 40; }
  const big = makeImage(256, 192, (x, y) => { const i = ((y >> 1) * 128 + (x >> 1)) * 4; return [small.data[i], small.data[i + 1], small.data[i + 2]]; });
  const a = computeSaliency(small, 'sr'), b = computeSaliency(big, 'sr');
  near(a.rawMax, b.rawMax, 1e-4 * a.rawMax, 'rawMax');
  ok(pearsonR(a, b) > 0.99999, `корреляция ${pearsonR(a, b).toFixed(6)}`);
});

test('SR: нецелое отношение размеров (171 → 64) не ломает карту — нет NaN, пик на объекте', () => {
  const img = sceneWithSquare(171, 256, 100, 40, 20);
  const s = computeSaliency(img, 'sr');
  finiteAll(s); eq(s.width, 171); eq(s.height, 256);
  const k = argmax(s); const x = k % 171, y = Math.floor(k / 171);
  ok(x > 60 && x < 140 && y > 10 && y < 100, `пик SR в (${x}, ${y})`);
});

test('Local Contrast: σ задаётся по длинной стороне (карта не зависит от поворота кадра)', () => {
  const a = computeSaliency(sceneWithSquare(96, 48, 70, 12, 8), 'local');
  // транспонированная сцена: квадрат в (12, 70) на 48×96
  const b = computeSaliency(sceneWithSquare(48, 96, 12, 70, 8), 'local');
  near(a.rawMax, b.rawMax, 0.02 * a.rawMax, 'rawMax');
});

/* ============================================================
   метрики карты
   ============================================================ */

test('метрики: дельта-карта на неквадратном кадре (mean, spread, peak_x/y — по центру пикселя)', () => {
  const w = 40, h = 20; const m = withSize(new Float32Array(w * h), w, h);
  m[10 * w + 20] = 1; m.rawMax = 1;
  const r = computeMetrics(m);
  near(r.mean, 1 / 800, 1e-4); eq(r.spread_pct, 0.13, 'единственный пиксель 1.0 > 0.5 = 1/800 ≈ 0.13 %');
  near(r.peak_x, 51.25, 0.01); near(r.peak_y, 52.5, 0.01);
  eq(r.peak, 1);
});

test('метрики: энтропия равномерного распределения по 64 бинам = 6 бит', () => {
  const N = 6400; const m = withSize(new Float32Array(N), 80, 80);
  for (let i = 0; i < N; i++) m[i] = ((i % 64) + 0.5) / 64;
  near(computeMetrics(m).entropy, 6, 0.01);
});

test('метрики: spread_pct — доля пикселей > 0.5', () => {
  const m = withSize(new Float32Array(1000).map((_, i) => (i < 250 ? 0.9 : 0.1)), 50, 20);
  eq(computeMetrics(m).spread_pct, 25);
});

test('метрики: center_bias не зависит от пропорций кадра (эллипс повторяет форму кадра)', () => {
  const radial = (w, h) => map2d(w, h, (x, y) => {
    const dx = (x + 0.5 - w / 2) / (w / 2), dy = (y + 0.5 - h / 2) / (h / 2);
    return Math.exp(-(dx * dx + dy * dy) / 0.3);
  });
  const sq = computeMetrics(radial(100, 100)).center_bias;
  const wide = computeMetrics(radial(200, 50)).center_bias;
  ok(sq > 1.5, `центрированная карта должна давать center_bias > 1.5, получено ${sq}`);
  near(sq, wide, 0.08, 'квадрат и широкий кадр');
  const uniform = computeMetrics(withSize(new Float32Array(200 * 50).fill(0.3), 200, 50)).center_bias;
  near(uniform, 1, 1e-9, 'равномерная карта');
});

test('метрики: peak берётся из сырой карты, формат значений', () => {
  const n = normalize(Float32Array.from({ length: 3000 }, (_, i) => i % 97));
  withSize(n, 60, 50);
  eq(computeMetrics(n).peak, 96);
  eq(formatMetric('spread_pct', 12.5), '12.5%');
  eq(formatMetric('mean', null), '—');
});

test('pearsonR: ±1, константа → 0, карты разных размеров сравниваются в относительных координатах', () => {
  const a = map2d(20, 20, (x, y) => x + 2 * y);
  near(pearsonR(a, a), 1, 1e-9);
  near(pearsonR(a, a.map((v) => -v)), -1, 1e-6);
  eq(pearsonR(a, withSize(new Float32Array(400).fill(3), 20, 20)), 0);
  const p1 = map2d(40, 40, (x, y) => Math.exp(-(((x - 28) / 40) ** 2 + ((y - 12) / 40) ** 2) * 20));
  const p2 = map2d(80, 20, (x, y) => Math.exp(-(((x - 56) / 80) ** 2 + ((y - 6) / 20) ** 2) * 20));
  ok(pearsonR(p1, p2) > 0.99, `тот же относительный рисунок в другом формате: ${pearsonR(p1, p2).toFixed(4)}`);
  // одинаковое число пикселей, но разная форма (портрет и альбом) — тоже приводятся к общей сетке
  eq(p1.length, p2.length);
  const land = map2d(64, 36, (x, y) => Math.exp(-(((x - 45) / 64) ** 2 + ((y - 10) / 36) ** 2) * 20));
  const port = map2d(36, 64, (x, y) => Math.exp(-(((x - 25) / 36) ** 2 + ((y - 19) / 64) ** 2) * 20));
  eq(land.length, port.length);
  ok(pearsonR(land, port) > 0.99, `альбом/портрет с одинаковым числом пикселей: ${pearsonR(land, port).toFixed(4)}`);
});

test('loader.workSize: длинная сторона = 256, пропорции сохранены, минимум 8 px', () => {
  eq(TARGET_SIZE, 256);
  let s = workSize(1920, 1080); eq(s.width, 256); eq(s.height, 144);
  s = workSize(100, 1000); eq(s.height, 256); eq(s.width, 26);
  s = workSize(1000, 2); eq(s.width, 256); eq(s.height, 8);
});

/* ============================================================
   айтрекинг: координаты, карта фиксаций, метрики
   ============================================================ */

test('mapFixations: край кадра не теряется, вне кадра — отбрасывается, веса', () => {
  const frame = { x0: 0, y0: 0, w: 1000, h: 500 };
  const fx = [
    { x: 999.9, y: 499.9, duration: 0.3 }, { x: 1000, y: 250, duration: 1 },
    { x: -1, y: 10, duration: 1 }, { x: 0, y: 0, duration: 2 },
  ];
  const r = mapFixations(fx, frame, 256, 128, true);
  eq(r.points.length, 2); eq(r.outside, 2);
  eq(r.points[0].gx, 255); eq(r.points[0].gy, 127);
  eq(r.points[0].w, 0.3); eq(r.points[1].w, 2);
  eq(mapFixations(fx, frame, 256, 128, false).points[1].w, 1);
  const shifted = mapFixations([{ x: 600, y: 300 }], { x0: 500, y0: 250, w: 200, h: 100 }, 100, 50);
  eq(shifted.points[0].gx, 50); eq(shifted.points[0].gy, 25);
});

const randomPoints = (n, gw, gh, seed) => {
  const r = rng(seed); const pts = [];
  for (let i = 0; i < n; i++) {
    const gx = Math.floor(r() * gw), gy = Math.floor(r() * gh);
    pts.push({ gx, gy, idx: gy * gw + gx, u: gx / gw, v: gy / gh, w: 1, participant: `p${i % 6}` });
  }
  return pts;
};

test('AUC-Judd: постоянная карта = 0.5 (раньше давала 1.0)', () => {
  const gw = 64, gh = 48; const flat = withSize(new Float32Array(gw * gh), gw, gh);
  near(computeAUCJudd(prepareMap(flat), randomPoints(100, gw, gh, 1)), 0.5, 1e-12);
});

test('AUC-Judd: идеальное разделение = 1, случайная карта ≈ 0.5, фиксации считаются по отдельности', () => {
  const gw = 64, gh = 48; const pts = randomPoints(60, gw, gh, 2);
  const perfect = withSize(new Float32Array(gw * gh), gw, gh);
  for (const p of pts) perfect[p.idx] = 1;
  near(computeAUCJudd(prepareMap(perfect), pts), 1, 1e-12, 'идеал');
  const r = rng(3); const rand = map2d(gw, gh, () => r());
  near(computeAUCJudd(prepareMap(rand), randomPoints(400, gw, gh, 4)), 0.5, 0.06, 'случайная карта');
  // две фиксации в одном пикселе: значение в AUC не должно «схлопнуться» в одну точку
  const two = [pts[0], { ...pts[0] }];
  ok(Number.isFinite(computeAUCJudd(prepareMap(perfect), two)));
});

test('AUC-Judd: карта, построенная по самим фиксациям, предсказывает их хорошо', () => {
  const gw = 128, gh = 72; const frame = { x0: 0, y0: 0, w: 1280, h: 720 };
  const r = rng(6); const pts = [];
  for (let i = 0; i < 150; i++) {
    const x = Math.min(1279, Math.max(0, 800 + (r() + r() + r() - 1.5) * 200));
    const y = Math.min(719, Math.max(0, 300 + (r() + r() + r() - 1.5) * 200));
    pts.push(...mapFixations([{ x, y, duration: 1 }], frame, gw, gh).points);
  }
  const fix = buildFixationMap(pts, gw, gh, frame, 40);
  const auc = computeAUCJudd(prepareMap(fix.map), pts);
  ok(auc > 0.85, `AUC ${auc.toFixed(3)}`);
});

test('NSS: известный ответ; плоская карта → 0', () => {
  const gw = 10, gh = 10; const m = withSize(new Float32Array(100), gw, gh);
  for (let i = 0; i < 50; i++) m[i] = 1;             // среднее 0.5, σ 0.5
  const mk = (idx) => ({ gx: idx % gw, gy: Math.floor(idx / gw), idx, w: 1 });
  near(computeNSS(prepareMap(m), [mk(3), mk(10)]), 1, 1e-6, 'на «горячих» пикселях z = +1');
  near(computeNSS(prepareMap(m), [mk(60), mk(70)]), -1, 1e-6, 'на «холодных» z = −1');
  near(computeNSS(prepareMap(m), [mk(3), mk(60)]), 0, 1e-6);
  eq(computeNSS(prepareMap(withSize(new Float32Array(100).fill(2), gw, gh)), [mk(5)]), 0);
});

test('sAUC: равные распределения = 0.5, позитивы выше негативов = 1', () => {
  const gw = 20, gh = 20; const m = map2d(gw, gh, (x) => x / gw);
  const prep = prepareMap(m);
  const pos = [{ idx: 19 }, { idx: 39 }, { idx: 59 }];
  const negLow = Array.from({ length: 20 }, (_, i) => i * 20);      // колонка x = 0 (20 строк)
  near(computeSAUC(prep, pos, negLow), 1, 1e-12);
  const same = Array.from({ length: 20 }, (_, i) => i * 20 + 19);   // колонка x = 19, как у позитивов
  near(computeSAUC(prep, pos, same), 0.5, 1e-12);
  ok(Number.isNaN(computeSAUC(prep, pos, [1, 2, 3])), 'мало негативов → NaN');
});

test('SIM и KL: тождество, непересечение, положительность', () => {
  const gw = 16, gh = 16;
  const a = map2d(gw, gh, (x, y) => Math.exp(-((x - 4) ** 2 + (y - 4) ** 2) / 8));
  const b = map2d(gw, gh, (x, y) => Math.exp(-((x - 12) ** 2 + (y - 12) ** 2) / 8));
  const dist = (m) => { const s = m.reduce((q, v) => q + v, 0); return m.map((v) => v / s); };
  const pa = prepareMap(a);
  near(computeSIM(pa, dist(a)), 1, 1e-6); near(computeKL(pa, dist(a)), 0, 1e-6);
  const sim = computeSIM(pa, dist(b)); ok(sim < 0.3, `SIM разнесённых пятен ${sim}`);
  ok(computeKL(pa, dist(b)) > 1, 'KL разнесённых пятен велика');
});

test('карта фиксаций: сумма плотности = 1, максимум у фиксации, центральный baseline — в центре', () => {
  const gw = 64, gh = 48; const frame = { x0: 0, y0: 0, w: 640, h: 480 };
  const pts = mapFixations([{ x: 100, y: 80 }, { x: 105, y: 82 }, { x: 98, y: 78 }], frame, gw, gh).points;
  const fix = buildFixationMap(pts, gw, gh, frame, 30);
  near(fix.density.reduce((s, v) => s + v, 0), 1, 1e-4, 'сумма плотности');
  const k = argmax(fix.map); near(k % gw, 10, 2); near(Math.floor(k / gw), 8, 2);
  const c = centerBaseline(gw, gh);
  ok(c[(gh / 2) * gw + gw / 2] > 0.99, 'в центре ≈ 1');
  ok(c[0] < 0.2 && c[gw - 1] < 0.2 && c[(gh - 1) * gw] < 0.2, 'по углам мало');
});

test('верхний предел (split-half): null при одном участнике, детерминирован, высок при согласованных участниках', () => {
  const gw = 64, gh = 36; const frame = { x0: 0, y0: 0, w: 640, h: 360 }; const r = rng(8);
  const fx = [];
  for (let p = 0; p < 8; p++) for (let i = 0; i < 12; i++) {
    fx.push({ x: 450 + (r() - 0.5) * 80, y: 120 + (r() - 0.5) * 80, duration: 1, participant: `P${p}` });
  }
  const pts = mapFixations(fx, frame, gw, gh).points;
  const one = pts.filter((p) => p.participant === 'P0');
  eq(interObserverCeiling(one, gw, gh, frame, 20), null);
  const c1 = interObserverCeiling(pts, gw, gh, frame, 20);
  const c2 = interObserverCeiling(pts, gw, gh, frame, 20);
  eq(c1.nss, c2.nss, 'детерминированность');
  ok(c1.cc > 0.5 && c1.auc > 0.7, `cc=${c1.cc.toFixed(2)} auc=${c1.auc.toFixed(2)}`);
  eq(c1.nParticipants, 8);
});

test('метрики по участникам: строки, ДИ; один участник → null', () => {
  const gw = 64, gh = 36; const frame = { x0: 0, y0: 0, w: 640, h: 360 };
  const fixes = [];
  for (let p = 0; p < 5; p++) for (let i = 0; i < 10; i++) fixes.push({ x: 200 + i * 10 + p * 37, y: 100 + p * 20, participant: `P${p}` });
  const pts = mapFixations(fixes, frame, gw, gh).points;
  const sal = map2d(gw, gh, (x) => x / gw);
  const pp = perParticipant(prepareMap(sal), pts, gw, gh, frame, 20);
  eq(pp.rows.length, 5); ok(pp.nss.lo < pp.nss.mean && pp.nss.mean < pp.nss.hi);
  eq(perParticipant(prepareMap(sal), pts.filter((p) => p.participant === 'P0'), gw, gh, frame, 20), null);
});

test('evaluateMap: возвращает все метрики', () => {
  const gw = 32, gh = 24; const frame = { x0: 0, y0: 0, w: 320, h: 240 };
  const pts = mapFixations([{ x: 100, y: 100, participant: 'a' }, { x: 120, y: 90, participant: 'b' }], frame, gw, gh).points;
  const fix = buildFixationMap(pts, gw, gh, frame, 20);
  const res = evaluateMap(prepareMap(centerBaseline(gw, gh)), pts, fix, null);
  for (const k of ['cc', 'nss', 'auc', 'sauc', 'sim', 'kl']) ok(k in res, `нет ${k}`);
  ok(Number.isNaN(res.sauc), 'без негативов sAUC не считается');
});

/* ============================================================
   CSV
   ============================================================ */

test('parseCSV: разделители ; , табуляция, BOM, кавычки с переносом строки', () => {
  eq(parseCSV('a;b;c\r\n1;2;3\r\n').separator, ';');
  eq(parseCSV('a,b,c\n1,2,3').separator, ',');
  eq(parseCSV('a\tb\n1\t2').separator, '\t');
  const p = parseCSV('\uFEFFname;note\n"A; B";"line1\nline2"\nC;""""\n');
  eq(p.columns[0], 'name'); eq(p.rows.length, 2);
  eq(p.rows[0].name, 'A; B'); eq(p.rows[0].note, 'line1\nline2'); eq(p.rows[1].note, '"');
  const d = parseCSV('x,x,y\n1,2,3');
  eq(d.columns.length, 3); ok(new Set(d.columns).size === 3, 'дубли имён колонок различаются');
});

test('detectColumns: Tobii Pro Lab — «Export date» не становится X', () => {
  const c = detectColumns(['Export date', 'Participant name', 'Presented Stimulus name', 'Eye movement type',
    'Eye movement type index', 'Gaze event duration', 'Fixation point X', 'Fixation point Y']);
  eq(c.x, 'Fixation point X'); eq(c.y, 'Fixation point Y'); eq(c.type, 'Eye movement type');
  eq(c.fixIndex, 'Eye movement type index'); eq(c.duration, 'Gaze event duration');
  eq(c.participant, 'Participant name'); eq(c.stimulus, 'Presented Stimulus name');
});

test('detectColumns: GazePoint, EyeLink Data Viewer, простой формат, отсутствие координат', () => {
  let c = detectColumns(['MEDIA_NAME', 'USER', 'FPOGX', 'FPOGY', 'FPOGD', 'FPOGID', 'FPOGV']);
  eq(c.x, 'FPOGX'); eq(c.y, 'FPOGY'); eq(c.duration, 'FPOGD'); eq(c.fixIndex, 'FPOGID');
  eq(c.stimulus, 'MEDIA_NAME'); eq(c.participant, 'USER');
  c = detectColumns(['RECORDING_SESSION_LABEL', 'CURRENT_FIX_X', 'CURRENT_FIX_Y', 'CURRENT_FIX_DURATION', 'CURRENT_FIX_INDEX']);
  eq(c.x, 'CURRENT_FIX_X'); eq(c.y, 'CURRENT_FIX_Y'); eq(c.duration, 'CURRENT_FIX_DURATION');
  eq(c.fixIndex, 'CURRENT_FIX_INDEX'); eq(c.participant, 'RECORDING_SESSION_LABEL');
  c = detectColumns(['x_px', 'y_px', 'type', 'dur_sec', 'result_name', 'stimulus']);
  eq(c.x, 'x_px'); eq(c.y, 'y_px'); eq(c.type, 'type'); eq(c.duration, 'dur_sec');
  eq(c.participant, 'result_name'); eq(c.stimulus, 'stimulus');
  c = detectColumns(['Timestamp', 'Max', 'Notes']);
  eq(c.x, null); eq(c.y, null);
});

test('extractFixations: фильтр типа и стимула, десятичная запятая, удаление повторов', () => {
  const map = { x: 'X', y: 'Y', type: 'T', duration: 'D', participant: 'P', stimulus: 'S', fixIndex: null };
  const rows = [
    { X: '10,5', Y: '20', T: 'Fixation', D: '0,2', P: 'a', S: 's1' },
    { X: '10,5', Y: '20', T: 'Fixation', D: '0,2', P: 'a', S: 's1' },   // повтор подряд
    { X: '30', Y: '40', T: 'Saccade', D: '0,05', P: 'a', S: 's1' },
    { X: '50', Y: '60', T: '', D: '', P: 'a', S: 's1' },                 // пустой тип — считаем фиксацией
    { X: '70', Y: '80', T: 'Fixation', D: '0,3', P: 'a', S: 's2' },
    { X: 'abc', Y: '80', T: 'Fixation', D: '0,3', P: 'a', S: 's1' },    // нечисловая координата
  ];
  const all = extractFixations(rows, map);
  eq(all.length, 3); eq(all.duplicatesRemoved, 1);
  eq(all[0].x, 10.5); eq(all[0].duration, 0.2); eq(all[2].duration, 0.3);
  eq(extractFixations(rows, map, { stimulus: 's1' }).length, 2);
  // по номеру фиксации
  const map2 = { ...map, fixIndex: 'I' };
  const rows2 = [
    { X: '1', Y: '1', T: 'Fixation', P: 'a', S: 's', I: '1' }, { X: '1.2', Y: '1', T: 'Fixation', P: 'a', S: 's', I: '1' },
    { X: '5', Y: '5', T: 'Fixation', P: 'a', S: 's', I: '2' }, { X: '1', Y: '1', T: 'Fixation', P: 'b', S: 's', I: '1' },
  ];
  const f2 = extractFixations(rows2, map2);
  eq(f2.length, 3, 'одинаковый номер у разных участников — разные фиксации'); eq(f2.duplicatesRemoved, 1);
});

test('сопоставление стимула и файла по имени; parseNum', () => {
  eq(matchStimulus(['scene_a.png', 'scene_b'], 'C:\\data\\Scene_A.jpg'), 'scene_a.png');
  eq(matchStimulus(['scene_a'], 'other.png'), null);
  eq(parseNum('1,5'), 1.5); ok(Number.isNaN(parseNum(''))); ok(Number.isNaN(parseNum(null)));
});

/* ============================================================
   Регрессионный блок: эталоны на фиксированной сцене.
   Если эти числа изменились — изменилась формула. Это должно быть
   осознанным решением (и записью в CHANGELOG), а не побочным эффектом.
   ============================================================ */

function referenceScene() {
  const r = rng(2024); const w = 80, h = 50;
  return makeImage(w, h, (x, y) => {
    let c = [110 + 30 * Math.sin(x / 9) + r() * 10, 120 + 25 * Math.cos(y / 7) + r() * 10, 130 + r() * 10];
    if (x >= 52 && x < 66 && y >= 12 && y < 26) c = [210, 50, 40];
    if (x >= 10 && x < 20 && y >= 30 && y < 44) c = [240, 240, 240];
    return c;
  });
}

const REGRESSION = {
  ft:    { mean: 0.2427, peak: 75.23,    entropy: 4.73, center_bias: 1.46, spread_pct: 6.78,  peak_x: 73.75, peak_y: 38 },
  dog:   { mean: 0.1387, peak: 103.8,    entropy: 4.26, center_bias: 1.17, spread_pct: 3.78,  peak_x: 19.62, peak_y: 66.2 },
  local: { mean: 0.0561, peak: 0.3417,   entropy: 1.98, center_bias: 1.63, spread_pct: 4.13,  peak_x: 19.88, peak_y: 61.4 },
  sr:    { mean: 0.2225, peak: 0.001253, entropy: 5.01, center_bias: 0.73, spread_pct: 17.33, peak_x: 18.38, peak_y: 64.2 },
};

test('регрессия: эталонные метрики четырёх методов на фиксированной сцене', () => {
  const img = referenceScene();
  for (const method of METHODS) {
    const s = computeSaliency(img, method);
    const m = computeMetrics(s);
    const exp = REGRESSION[method];
    for (const key of Object.keys(exp)) {
      const tol = key === 'peak' ? Math.abs(exp[key]) * 1e-3 + 1e-9 : 1e-3 + Math.abs(exp[key]) * 1e-3;
      near(m[key], exp[key], tol, `${method}.${key}`);
    }
  }
});

/* ============================================================ */

/** Выполнить все тесты. Возвращает { passed, failed, results:[{name, ok, error?, ms}] }. */
export async function runAll(onResult) {
  const results = [];
  for (const t of tests) {
    const t0 = Date.now();
    let res;
    try {
      await t.fn();
      res = { name: t.name, ok: true, ms: Date.now() - t0 };
    } catch (e) {
      res = { name: t.name, ok: false, error: e && e.message ? e.message : String(e), ms: Date.now() - t0 };
    }
    results.push(res);
    if (onResult) onResult(res);
  }
  const failed = results.filter((r) => !r.ok).length;
  return { passed: results.length - failed, failed, results };
}

export const __internal = { referenceScene, computeSaliency, computeMetrics };
