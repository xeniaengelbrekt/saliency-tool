/* ============================================================
   blur.js — разделяемое гауссово размытие (O(N·k))
   Два прохода: горизонтальный → вертикальный, clamp-to-edge.
   ============================================================ */

/**
 * Размывает одноканальный массив (Float32Array, размер width*height)
 * с заданным sigma. Возвращает новый Float32Array.
 */
export function gaussBlur1D(src, width, height, sigma) {
  if (sigma <= 0) return new Float32Array(src);

  const kernelSize = Math.max(3, 2 * Math.ceil(3 * sigma) + 1);
  const half = (kernelSize - 1) >> 1;

  // Веса ядра, нормированные к сумме = 1
  const kernel = new Float32Array(kernelSize);
  const s2 = 2 * sigma * sigma;
  let sum = 0;
  for (let i = 0; i < kernelSize; i++) {
    const x = i - half;
    const v = Math.exp(-(x * x) / s2);
    kernel[i] = v;
    sum += v;
  }
  for (let i = 0; i < kernelSize; i++) kernel[i] /= sum;

  const temp = new Float32Array(width * height);

  // Горизонтальный проход: src → temp
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let k = 0; k < kernelSize; k++) {
        let xi = x + k - half;
        if (xi < 0) xi = 0;
        else if (xi >= width) xi = width - 1;
        acc += src[row + xi] * kernel[k];
      }
      temp[row + x] = acc;
    }
  }

  // Вертикальный проход: temp → out
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let k = 0; k < kernelSize; k++) {
        let yi = y + k - half;
        if (yi < 0) yi = 0;
        else if (yi >= height) yi = height - 1;
        acc += temp[yi * width + x] * kernel[k];
      }
      out[row + x] = acc;
    }
  }

  return out;
}
