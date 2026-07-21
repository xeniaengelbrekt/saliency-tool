/* ============================================================
   fixmap.js — построение fixation map через KDE
   и метрики соответствия с моделью салиентности.

   Карта строится на сетке 256×256 (TARGET) — той же, на которой
   считается и салиентность. Это обеспечивает прямую сравнимость.

   σ в исходных пикселях кадра масштабируется в σ для сетки 256.
   ============================================================ */

import { gaussBlur1D } from '../algorithms/blur.js';
import { normalize } from '../algorithms/util.js';

export const TARGET = 256;

/**
 * Анизотропная гауссова свёртка: разные σ по осям.
 * Делает раздельные проходы — горизонтальный с σx, вертикальный с σy.
 * Это нужно когда исходное изображение неквадратное и мы маппим
 * пиксели в единый размер 256×256 — на сетке σ становится разным
 * по X и Y, чтобы соответствовать ИЗОТРОПНОМУ ядру в исходном пространстве.
 */
function gaussBlur2DAniso(src, w, h, sigmaX, sigmaY) {
  // Горизонтальный проход с σx
  const tmp = sigmaX > 0 ? gaussBlur1D_axis(src, w, h, sigmaX, true)  : new Float32Array(src);
  // Вертикальный проход с σy
  const out = sigmaY > 0 ? gaussBlur1D_axis(tmp, w, h, sigmaY, false) : tmp;
  return out;
}

/**
 * Однопроходное размытие по одной оси (true — по X, false — по Y).
 * Реализация дублирует логику gaussBlur1D, но с управляемой осью.
 */
function gaussBlur1D_axis(src, w, h, sigma, horizontal) {
  if (sigma <= 0) return new Float32Array(src);
  const k = Math.max(3, 2 * Math.ceil(3 * sigma) + 1);
  const half = (k - 1) >> 1;
  const kernel = new Float32Array(k);
  const s2 = 2 * sigma * sigma;
  let sum = 0;
  for (let i = 0; i < k; i++) {
    const x = i - half;
    const v = Math.exp(-(x * x) / s2);
    kernel[i] = v;
    sum += v;
  }
  for (let i = 0; i < k; i++) kernel[i] /= sum;

  const out = new Float32Array(w * h);
  if (horizontal) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let acc = 0;
        for (let m = 0; m < k; m++) {
          let xi = x + m - half;
          if (xi < 0) xi = 0; else if (xi >= w) xi = w - 1;
          acc += src[row + xi] * kernel[m];
        }
        out[row + x] = acc;
      }
    }
  } else {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let acc = 0;
        for (let m = 0; m < k; m++) {
          let yi = y + m - half;
          if (yi < 0) yi = 0; else if (yi >= h) yi = h - 1;
          acc += src[yi * w + x] * kernel[m];
        }
        out[row + x] = acc;
      }
    }
  }
  return out;
}

/**
 * Построить fixation map по списку фиксаций.
 *
 * Алгоритм:
 *   1. Создаём сетку 256×256.
 *   2. Каждая фиксация — точка с весом = duration (или 1) в соответствующем пикселе сетки.
 *   3. Размываем АНИЗОТРОПНЫМ гауссовым ядром: σx = σ_src · (TARGET/srcW), σy = σ_src · (TARGET/srcH).
 *      Это эквивалентно изотропному размытию с σ_src в пикселях исходного кадра.
 *   4. Нормируем в [0, 1].
 *
 * @param {Array<{x:number,y:number,duration:number}>} fixations
 *        координаты в пикселях исходного кадра, x в [0, srcW), y в [0, srcH)
 * @param {number} srcW — ширина исходного кадра (= ширина стимула в px на экране)
 * @param {number} srcH — высота
 * @param {number} sigmaSrc — σ ядра KDE в пикселях исходного кадра
 *        (стандартно ≈ 1° угла зрения, что даёт ≈ 30 px при типичных условиях)
 *
 * @returns {Float32Array} TARGET·TARGET значений в [0, 1], нормированных,
 *          с прикреплёнными свойствами rawMin/rawMax.
 */
export function buildFixationMap(fixations, srcW, srcH, sigmaSrc = 30) {
  const map = new Float32Array(TARGET * TARGET);
  if (srcW <= 0 || srcH <= 0) return normalize(map);

  const sx = TARGET / srcW;
  const sy = TARGET / srcH;

  for (const f of fixations) {
    const xi = Math.round(f.x * sx);
    const yi = Math.round(f.y * sy);
    if (xi < 0 || xi >= TARGET || yi < 0 || yi >= TARGET) continue;
    map[yi * TARGET + xi] += f.duration > 0 ? f.duration : 1;
  }

  // Анизотропное σ: на сетке 256×256 ширина и высота имеют разный масштаб
  // относительно исходного кадра, поэтому σ должно быть разным по осям —
  // тогда размытие соответствует ИЗОТРОПНОМУ ядру в пиксельных координатах эксперимента.
  const sigmaX = Math.max(0.5, sigmaSrc * sx);
  const sigmaY = Math.max(0.5, sigmaSrc * sy);
  const blurred = gaussBlur2DAniso(map, TARGET, TARGET, sigmaX, sigmaY);
  return normalize(blurred);
}

/* ============================================================
   Метрики соответствия моделей салиентности и фиксаций
   ============================================================ */

/**
 * Pearson r между двумя картами одинаковой длины.
 * Линейная корреляция; диапазон [−1, +1].
 */
export function pearsonR(A, B) {
  const N = A.length;
  let sumA = 0, sumB = 0;
  for (let i = 0; i < N; i++) { sumA += A[i]; sumB += B[i]; }
  const muA = sumA / N, muB = sumB / N;
  let num = 0, denA = 0, denB = 0;
  for (let i = 0; i < N; i++) {
    const da = A[i] - muA;
    const db = B[i] - muB;
    num  += da * db;
    denA += da * da;
    denB += db * db;
  }
  const den = Math.sqrt(denA * denB);
  return den === 0 ? 0 : num / den;
}

/**
 * NSS (Normalized Scanpath Saliency).
 *
 * 1) z-нормировать карту салиентности по всему изображению;
 * 2) для каждой точки фиксации взять z-значение в её координате;
 * 3) усреднить.
 *
 * NSS = 0  — модель не отличается от случайного предсказания.
 * NSS > 0  — фиксации систематически попадают в зоны выше среднего.
 * NSS > 1  — уверенное предсказание.
 *
 * @param {Array} fixations — координаты в пикселях исходного кадра
 * @param {Float32Array} sal — карта салиентности TARGET×TARGET
 * @param {number} srcW, srcH — размер исходного кадра
 */
export function computeNSS(fixations, sal, srcW, srcH) {
  const N = sal.length;
  // среднее и стандартное отклонение карты
  let sum = 0;
  for (let i = 0; i < N; i++) sum += sal[i];
  const mean = sum / N;
  let varSum = 0;
  for (let i = 0; i < N; i++) {
    const d = sal[i] - mean;
    varSum += d * d;
  }
  const stdev = Math.sqrt(varSum / N);
  if (stdev === 0) return 0;

  const sx = TARGET / srcW;
  const sy = TARGET / srcH;
  let total = 0, count = 0;
  for (const f of fixations) {
    const xi = Math.round(f.x * sx);
    const yi = Math.round(f.y * sy);
    if (xi < 0 || xi >= TARGET || yi < 0 || yi >= TARGET) continue;
    const z = (sal[yi * TARGET + xi] - mean) / stdev;
    total += z;
    count++;
  }
  return count > 0 ? total / count : 0;
}

/**
 * AUC-Judd: salience рассматривается как бинарный классификатор фиксаций.
 * Каждый порог t в карте даёт TPR (доля фиксаций попавших в зону выше t)
 * и FPR (доля остальных пикселей выше t). Площадь под ROC-кривой и есть AUC.
 *
 * 0.5 — модель не лучше случайной.
 * 0.7–0.8 — типичный диапазон классических моделей салиентности.
 * 0.9+ — высокое соответствие (обычно требуется обучение под фиксации).
 */
export function computeAUCJudd(fixations, sal, srcW, srcH) {
  const N = sal.length;

  const isFix = new Uint8Array(N);
  const sx = TARGET / srcW;
  const sy = TARGET / srcH;
  let nFix = 0;
  for (const f of fixations) {
    const xi = Math.round(f.x * sx);
    const yi = Math.round(f.y * sy);
    if (xi < 0 || xi >= TARGET || yi < 0 || yi >= TARGET) continue;
    const idx = yi * TARGET + xi;
    if (!isFix[idx]) { isFix[idx] = 1; nFix++; }
  }
  if (nFix === 0 || nFix === N) return 0.5;

  // Сортируем индексы по убыванию saliency.
  // Tie-break: при равных значениях сначала идут пиксели-фиксации.
  // Без этого AUC систематически занижается на картах с плоскими участками
  // (например, у Local Contrast — много нулевых значений).
  const idxs = new Int32Array(N);
  for (let i = 0; i < N; i++) idxs[i] = i;
  // Int32Array.sort стабильна в современных движках, но сравнитель
  // должен явно повышать isFix-пиксели при равенстве значений.
  const arr = Array.from(idxs);
  arr.sort((a, b) => (sal[b] - sal[a]) || (isFix[b] - isFix[a]));
  for (let i = 0; i < N; i++) idxs[i] = arr[i];

  const totalNeg = N - nFix;
  let tp = 0, fp = 0;
  let prevTPR = 0, prevFPR = 0;
  let auc = 0;

  for (let i = 0; i < N; i++) {
    const k = idxs[i];
    if (isFix[k]) tp++; else fp++;
    const tpr = tp / nFix;
    const fpr = fp / totalNeg;
    // трапеция
    auc += (fpr - prevFPR) * (tpr + prevTPR) * 0.5;
    prevTPR = tpr;
    prevFPR = fpr;
  }
  return auc;
}

/**
 * Разностная карта (для визуализации) — где модель «промахивается».
 * Возвращает Float32Array TARGET·TARGET со значениями в [-1, +1]:
 * положительные — салиентность переоценена, отрицательные — недооценена.
 */
export function differenceMap(salience, fixmap) {
  const N = salience.length;
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    out[i] = salience[i] - fixmap[i];
  }
  return out;
}
