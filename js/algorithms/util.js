/* ============================================================
   util.js — общие утилиты для всех алгоритмов салиентности
   ============================================================ */

/**
 * Нормировать массив в [0, 1]. Возвращает новый Float32Array.
 *
 * Дополнительно прикрепляет к возвращаемому массиву свойства
 * `rawMin` и `rawMax` — минимум и максимум ДО нормализации.
 * Это нужно метрике `peak`: после нормализации max(S) всегда = 1.0,
 * поэтому информативная пиковая салиентность — это max сырой карты.
 */
export function normalize(map) {
  const N = map.length;
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < N; i++) {
    const v = map[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const out = new Float32Array(N);
  const range = max - min;
  if (range !== 0) {
    for (let i = 0; i < N; i++) {
      out[i] = (map[i] - min) / range;
    }
  }
  // Сохраняем сырой диапазон как свойства массива
  out.rawMin = min;
  out.rawMax = max;
  return out;
}
