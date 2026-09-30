/* ============================================================
   fixmap.js — карта фиксаций (KDE) и метрики соответствия
   модели салиентности реальным фиксациям.

   Все карты строятся на сетке карты салиентности (gw × gh:
   длинная сторона 256 px, пропорции стимула сохранены).

   Координаты фиксаций переводятся в координаты стимула через
   прямоугольник frame = {x0, y0, w, h}: где на экране (в единицах
   айтрекера) находился стимул. Фиксации вне стимула отбрасываются
   и считаются отдельно.

   Метрики — по определениям MIT/Tuebingen Saliency Benchmark
   (Bylinskii et al., 2019, IEEE TPAMI): CC, NSS, AUC-Judd,
   shuffled AUC, SIM, KL-divergence.
   ============================================================ */

import { normalize, withSize } from '../algorithms/util.js';
import { pearsonR } from '../metrics.js';
import { meanCI95 } from '../stats.js';

const EPS = 2.2204e-16;   // как в эталонном коде MIT benchmark

/* ============================================================
   Координаты
   ============================================================ */

/**
 * Перевести фиксации в ячейки сетки gw×gh.
 * Возвращает { points: [{gx, gy, idx, u, v, w, participant}], outside }.
 * u, v — относительные координаты внутри стимула (0…1).
 */
export function mapFixations(fixations, frame, gw, gh, weighted = false) {
  const points = [];
  let outside = 0;
  for (const f of fixations) {
    const u = (f.x - frame.x0) / frame.w;
    const v = (f.y - frame.y0) / frame.h;
    if (!(u >= 0 && u < 1 && v >= 0 && v < 1)) { outside++; continue; }
    const gx = Math.min(gw - 1, Math.floor(u * gw));
    const gy = Math.min(gh - 1, Math.floor(v * gh));
    points.push({
      gx, gy, idx: gy * gw + gx, u, v,
      w: weighted && f.duration > 0 ? f.duration : 1,
      participant: f.participant,
    });
  }
  return { points, outside };
}

/* ============================================================
   KDE-карта фиксаций
   ============================================================ */

/**
 * Карта фиксаций: точки → гауссово ядро.
 * sigmaPx — σ в единицах координат айтрекера (обычно px экрана);
 * на сетке σ пересчитывается отдельно по осям.
 * Края — нулевое дополнение (масса ядра за краем кадра теряется,
 * а не «прилипает» к границе).
 *
 * Возвращает { map, density }:
 *   map     — нормирована в [0, 1] (для показа и CC),
 *   density — сумма = 1 (распределение для SIM и KL).
 */
export function buildFixationMap(points, gw, gh, frame, sigmaPx) {
  const raw = new Float32Array(gw * gh);
  for (const p of points) raw[p.idx] += p.w;
  const sx = Math.max(0.5, sigmaPx * gw / frame.w);
  const sy = Math.max(0.5, sigmaPx * gh / frame.h);
  const blurred = gaussBlur2DAniso(raw, gw, gh, sx, sy);
  return {
    map: withSize(normalize(blurred), gw, gh),
    density: withSize(toDistribution(blurred), gw, gh),
  };
}

/**
 * Центральный baseline: гауссиана в центре кадра, σ = ¼ ширины
 * и ¼ высоты. Нужен как точка отсчёта: многие «хорошие» NSS/AUC
 * объясняются просто центральным сдвигом взгляда.
 */
export function centerBaseline(gw, gh) {
  const out = new Float32Array(gw * gh);
  const cx = gw / 2, cy = gh / 2;
  const sx = gw / 4, sy = gh / 4;
  for (let y = 0; y < gh; y++) {
    const dy = (y + 0.5 - cy) / sy;
    for (let x = 0; x < gw; x++) {
      const dx = (x + 0.5 - cx) / sx;
      out[y * gw + x] = Math.exp(-0.5 * (dx * dx + dy * dy));
    }
  }
  return withSize(normalize(out), gw, gh);
}

/* ============================================================
   Метрики
   ============================================================ */

/**
 * Подготовка карты салиентности к многократной оценке:
 * среднее/σ для NSS, отсортированные значения для AUC,
 * распределение для SIM/KL.
 */
export function prepareMap(sal) {
  const N = sal.length;
  let sum = 0;
  for (let i = 0; i < N; i++) sum += sal[i];
  const mean = sum / N;
  let v = 0;
  for (let i = 0; i < N; i++) { const d = sal[i] - mean; v += d * d; }
  const std = Math.sqrt(v / N);
  const sorted = Float32Array.from(sal).sort();   // по возрастанию
  return { sal, mean, std, sorted, dist: toDistribution(sal) };
}

/** NSS: среднее z-значение салиентности в точках фиксаций (взвешенное при p.w ≠ 1). */
export function computeNSS(prep, points) {
  if (!points.length || prep.std === 0) return points.length ? 0 : NaN;
  let total = 0, wsum = 0;
  for (const p of points) {
    total += p.w * (prep.sal[p.idx] - prep.mean) / prep.std;
    wsum += p.w;
  }
  return total / wsum;
}

/**
 * AUC-Judd. Пороги — значения салиентности в точках фиксаций.
 * Для порога t:  TPR = доля фиксаций с S ≥ t,
 *                FPR = доля НЕфиксированных пикселей с S ≥ t.
 * Пиксели с одинаковым значением попадают под порог одновременно,
 * поэтому плоская карта даёт ровно 0.5 (раньше порядок среди
 * одинаковых значений искусственно ставил фиксации первыми, и
 * постоянная карта получала AUC = 1.0).
 * Каждая фиксация учитывается отдельно, даже если несколько
 * попали в один пиксель.
 */
export function computeAUCJudd(prep, points) {
  const N = prep.sal.length;
  const nFix = points.length;
  if (!nFix) return NaN;

  const fixPix = new Map();          // пиксель → значение (уникальные фиксированные пиксели)
  const fixVals = new Float64Array(nFix);
  for (let i = 0; i < nFix; i++) {
    const v = prep.sal[points[i].idx];
    fixVals[i] = v;
    fixPix.set(points[i].idx, v);
  }
  const nFixPix = fixPix.size;
  const nNeg = N - nFixPix;
  if (nNeg <= 0) return NaN;
  const fixPixVals = Float64Array.from(fixPix.values()).sort();
  fixVals.sort();

  // Уникальные пороги по убыванию
  const thresholds = [];
  for (let i = nFix - 1; i >= 0; i--) {
    if (!thresholds.length || fixVals[i] !== thresholds[thresholds.length - 1]) thresholds.push(fixVals[i]);
  }

  let auc = 0, prevTP = 0, prevFP = 0;
  for (const t of thresholds) {
    const tp = countGE(fixVals, t) / nFix;
    const fp = Math.max(0, countGE(prep.sorted, t) - countGE(fixPixVals, t)) / nNeg;
    auc += (fp - prevFP) * (tp + prevTP) / 2;
    prevTP = tp; prevFP = fp;
  }
  auc += (1 - prevFP) * (1 + prevTP) / 2;
  return auc;
}

/**
 * Shuffled AUC (sAUC): негативы — не случайные пиксели, а места
 * фиксаций на ДРУГИХ стимулах. Так центральный сдвиг и общие
 * привычки просмотра перестают «помогать» модели: 0.5 — модель
 * не предсказывает ничего сверх общих закономерностей.
 * Считается точно, через статистику Манна — Уитни (равные значения — ½).
 * negatives — массив индексов пикселей.
 */
export function computeSAUC(prep, points, negatives) {
  if (!points.length || !negatives || negatives.length < 10) return NaN;
  const pos = Float64Array.from(points, (p) => prep.sal[p.idx]).sort();
  const neg = Float64Array.from(negatives, (i) => prep.sal[i]).sort();
  let greater = 0, equal = 0;
  let lo = 0, hi = 0;           // lo: число neg < v; hi: число neg ≤ v
  for (let i = 0; i < pos.length; i++) {
    const v = pos[i];
    while (lo < neg.length && neg[lo] < v) lo++;
    if (hi < lo) hi = lo;
    while (hi < neg.length && neg[hi] <= v) hi++;
    greater += lo;
    equal += hi - lo;
  }
  return (greater + 0.5 * equal) / (pos.length * neg.length);
}

/** SIM: сумма поэлементных минимумов двух распределений (0 — нет пересечения, 1 — совпадают). */
export function computeSIM(prep, fixDensity) {
  const P = prep.dist, Q = fixDensity;
  let s = 0;
  for (let i = 0; i < P.length; i++) s += P[i] < Q[i] ? P[i] : Q[i];
  return s;
}

/** KL-дивергенция KL(фиксации ‖ модель): 0 — совпадение, больше — хуже. */
export function computeKL(prep, fixDensity) {
  const P = prep.dist, Q = fixDensity;
  let s = 0;
  for (let i = 0; i < P.length; i++) {
    if (Q[i] > 0) s += Q[i] * Math.log(EPS + Q[i] / (P[i] + EPS));
  }
  return s;
}

/** Полный набор метрик для одной карты. */
export function evaluateMap(prep, points, fix, negatives) {
  return {
    cc:   pearsonR(prep.sal, fix.density),
    nss:  computeNSS(prep, points),
    auc:  computeAUCJudd(prep, points),
    sauc: computeSAUC(prep, points, negatives),
    sim:  computeSIM(prep, fix.density),
    kl:   computeKL(prep, fix.density),
  };
}

/* ============================================================
   Верхний предел: согласованность между участниками
   ============================================================ */

/**
 * Split-half: участники случайно делятся пополам; карта одной
 * половины «предсказывает» фиксации другой. Повторяется `reps` раз
 * (и в обе стороны), результаты усредняются.
 * Это оценка того, насколько вообще предсказуемы фиксации на этом
 * стимуле: модель салиентности редко может быть лучше этого предела.
 * Замечание: половина выборки даёт более шумную карту, чем вся
 * выборка, поэтому предел слегка занижен.
 * Нужно ≥ 2 участников; для устойчивой оценки — от 6–8.
 */
export function interObserverCeiling(points, gw, gh, frame, sigmaPx, reps = 10, seed = 12345) {
  const byP = groupByParticipant(points);
  const ids = [...byP.keys()];
  if (ids.length < 2) return null;
  const rnd = mulberry32(seed);
  const acc = { cc: [], nss: [], auc: [], sim: [], kl: [] };

  for (let r = 0; r < reps; r++) {
    const order = ids.slice();
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const half = Math.floor(order.length / 2);
    const A = order.slice(0, half).flatMap((id) => byP.get(id));
    const B = order.slice(half).flatMap((id) => byP.get(id));
    for (const [pred, target] of [[A, B], [B, A]]) {
      const predMap = buildFixationMap(pred, gw, gh, frame, sigmaPx);
      const targetMap = buildFixationMap(target, gw, gh, frame, sigmaPx);
      const prep = prepareMap(predMap.map);
      acc.cc.push(pearsonR(predMap.density, targetMap.density));
      acc.nss.push(computeNSS(prep, target));
      acc.auc.push(computeAUCJudd(prep, target));
      acc.sim.push(computeSIM(prep, targetMap.density));
      acc.kl.push(computeKL(prep, targetMap.density));
    }
  }
  const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  return {
    cc: avg(acc.cc), nss: avg(acc.nss), auc: avg(acc.auc), sauc: NaN,
    sim: avg(acc.sim), kl: avg(acc.kl),
    nParticipants: ids.length, reps,
  };
}

/* ============================================================
   Метрики по участникам
   ============================================================ */

/**
 * NSS, AUC-Judd и CC отдельно для каждого участника + среднее
 * и 95 % доверительный интервал по участникам. Именно участник —
 * правильная единица наблюдения для статистики, а не фиксация.
 */
export function perParticipant(prep, points, gw, gh, frame, sigmaPx) {
  const byP = groupByParticipant(points);
  if (byP.size < 2) return null;
  const rows = [];
  for (const [id, pts] of byP) {
    const fix = buildFixationMap(pts, gw, gh, frame, sigmaPx);
    rows.push({
      participant: id,
      n: pts.length,
      nss: computeNSS(prep, pts),
      auc: computeAUCJudd(prep, pts),
      cc: pearsonR(prep.sal, fix.density),
    });
  }
  rows.sort((a, b) => String(a.participant).localeCompare(String(b.participant), 'ru', { numeric: true }));
  return {
    rows,
    nss: meanCI95(rows.map((r) => r.nss)),
    auc: meanCI95(rows.map((r) => r.auc)),
    cc:  meanCI95(rows.map((r) => r.cc)),
  };
}

/* ============================================================
   Разностная карта
   ============================================================ */

/**
 * Разность нормированных карт (для визуализации) — где модель «промахивается».
 * Положительные — салиентность переоценена, отрицательные — недооценена.
 */
export function differenceMap(salience, fixmap) {
  const N = salience.length;
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) out[i] = salience[i] - fixmap[i];
  return withSize(out, salience.width, salience.height);
}

/* ============================================================
   Вспомогательное
   ============================================================ */

function groupByParticipant(points) {
  const m = new Map();
  for (const p of points) {
    const id = p.participant == null || p.participant === '' ? '(без ID)' : p.participant;
    if (!m.has(id)) m.set(id, []);
    m.get(id).push(p);
  }
  return m;
}

/** Число элементов отсортированного по возрастанию массива, ≥ t. */
function countGE(sorted, t) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < t) lo = mid + 1; else hi = mid;
  }
  return sorted.length - lo;
}

function toDistribution(map) {
  let s = 0;
  for (let i = 0; i < map.length; i++) s += map[i];
  const out = new Float32Array(map.length);
  if (s > 0) for (let i = 0; i < map.length; i++) out[i] = map[i] / s;
  return out;
}

/** Детерминированный ГПСЧ — чтобы split-half давал одинаковый результат при повторе. */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Анизотропная гауссова свёртка (разные σ по осям), нулевое дополнение на краях. */
function gaussBlur2DAniso(src, w, h, sigmaX, sigmaY) {
  const tmp = gaussBlurAxis(src, w, h, sigmaX, true);
  return gaussBlurAxis(tmp, w, h, sigmaY, false);
}

function gaussBlurAxis(src, w, h, sigma, horizontal) {
  if (sigma <= 0) return new Float32Array(src);
  const k = Math.max(3, 2 * Math.ceil(3 * sigma) + 1);
  const half = (k - 1) >> 1;
  const kernel = new Float32Array(k);
  const s2 = 2 * sigma * sigma;
  let sum = 0;
  for (let i = 0; i < k; i++) {
    const x = i - half;
    kernel[i] = Math.exp(-(x * x) / s2);
    sum += kernel[i];
  }
  for (let i = 0; i < k; i++) kernel[i] /= sum;

  const out = new Float32Array(w * h);
  if (horizontal) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let acc = 0;
        const m0 = Math.max(0, half - x), m1 = Math.min(k, w - x + half);
        for (let m = m0; m < m1; m++) acc += src[row + x + m - half] * kernel[m];
        out[row + x] = acc;
      }
    }
  } else {
    for (let y = 0; y < h; y++) {
      const m0 = Math.max(0, half - y), m1 = Math.min(k, h - y + half);
      for (let x = 0; x < w; x++) {
        let acc = 0;
        for (let m = m0; m < m1; m++) acc += src[(y + m - half) * w + x] * kernel[m];
        out[y * w + x] = acc;
      }
    }
  }
  return out;
}
