/* ============================================================
   util.js — общие утилиты для всех алгоритмов салиентности
   ============================================================ */

/** Верхний перцентиль для робастной нормировки (см. normalize). */
export const NORM_PERCENTILE = 0.999;

/**
 * Нормировать массив в [0, 1]. Возвращает новый Float32Array.
 *
 * Нормировка робастная: нижняя граница — минимум, верхняя — 99.9-й
 * перцентиль (значения выше обрезаются до 1). Классическая min–max
 * нормировка делает все метрики заложниками одного-единственного
 * пикселя-выброса: он «сжимает» остальную карту к нулю, и mean /
 * spread / entropy падают без всякой связи со стимулом.
 *
 * К массиву прикрепляются свойства:
 *   rawMin — минимум ДО нормировки;
 *   rawMax — истинный максимум ДО нормировки (для метрики peak);
 *   rawHi  — значение, принятое за 1.0 (99.9-й перцентиль).
 */
export function normalize(map) {
  const N = map.length;
  let min = Infinity, max = -Infinity, maxIdx = 0;
  for (let i = 0; i < N; i++) {
    const v = map[i];
    if (v < min) min = v;
    if (v > max) { max = v; maxIdx = i; }
  }
  let hi = max;
  if (N >= 1000) {
    const sorted = Float32Array.from(map).sort();
    hi = sorted[Math.min(N - 1, Math.floor(NORM_PERCENTILE * (N - 1)))];
    if (!(hi > min)) hi = max;   // карта почти плоская — откат к min–max
  }
  const out = new Float32Array(N);
  const range = hi - min;
  if (range > 0) {
    for (let i = 0; i < N; i++) {
      const v = (map[i] - min) / range;
      out[i] = v > 1 ? 1 : v;
    }
  }
  out.rawMin = min;
  out.rawMax = max;
  out.rawMaxIdx = maxIdx;
  out.rawHi = hi;
  return out;
}

/** Прикрепить к карте её размеры (карта = плоский массив w*h). */
export function withSize(map, width, height) {
  map.width = width;
  map.height = height;
  return map;
}

/**
 * Билинейный ресэмплинг карты srcW×srcH → dstW×dstH.
 * Координаты берутся по центрам пикселей (как у canvas).
 */
export function resampleMap(src, srcW, srcH, dstW, dstH) {
  const out = new Float32Array(dstW * dstH);
  const sx = srcW / dstW;
  const sy = srcH / dstH;
  for (let y = 0; y < dstH; y++) {
    let fy = (y + 0.5) * sy - 0.5;
    if (fy < 0) fy = 0;
    if (fy > srcH - 1) fy = srcH - 1;
    const y0 = Math.floor(fy);
    const y1 = y0 + 1 < srcH ? y0 + 1 : y0;
    const dy = fy - y0;
    for (let x = 0; x < dstW; x++) {
      let fx = (x + 0.5) * sx - 0.5;
      if (fx < 0) fx = 0;
      if (fx > srcW - 1) fx = srcW - 1;
      const x0 = Math.floor(fx);
      const x1 = x0 + 1 < srcW ? x0 + 1 : x0;
      const dx = fx - x0;
      const v0 = src[y0 * srcW + x0] * (1 - dx) + src[y0 * srcW + x1] * dx;
      const v1 = src[y1 * srcW + x0] * (1 - dx) + src[y1 * srcW + x1] * dx;
      out[y * dstW + x] = v0 * (1 - dy) + v1 * dy;
    }
  }
  return withSize(out, dstW, dstH);
}

/**
 * Вырезать прямоугольник [x0, x1) × [y0, y1) из карты width×height.
 * Значения НЕ перенормируются — регион остаётся в шкале исходной карты.
 * rawMin/rawMax пересчитываются в сырой шкале исходной карты.
 */
export function cropMap(map, width, x0, y0, x1, y1) {
  const w = x1 - x0;
  const h = y1 - y0;
  const out = new Float32Array(w * h);
  let maxV = -Infinity;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = map[(y0 + y) * width + (x0 + x)];
      out[y * w + x] = v;
      if (v > maxV) maxV = v;
    }
  }
  if (map.rawMin !== undefined) {
    const hi = map.rawHi ?? map.rawMax;
    const range = hi - map.rawMin;
    out.rawMin = map.rawMin;
    out.rawHi = hi;
    // Сырой максимум внутри региона: если глобальный пик попал в регион — он и есть;
    // иначе восстанавливаем из нормированного значения (обрезанное 1.0 → rawHi).
    let inside = false;
    if (map.rawMaxIdx !== undefined) {
      const px = map.rawMaxIdx % width;
      const py = Math.floor(map.rawMaxIdx / width);
      inside = px >= x0 && px < x1 && py >= y0 && py < y1;
    }
    out.rawMax = inside ? map.rawMax : map.rawMin + maxV * range;
  }
  return withSize(out, w, h);
}
