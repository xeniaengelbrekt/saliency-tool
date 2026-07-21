/* ============================================================
   fft.js — Cooley-Tukey radix-2 FFT (1D и разделяемое 2D).
   Используется только методом Spectral Residual.

   Размер должен быть степенью двойки. Spectral Residual работает
   на 64×64 — для этого размера cost FFT пренебрежимо мал.
   ============================================================ */

/**
 * In-place 1D FFT (Cooley-Tukey radix-2).
 * @param {Float32Array} real — вещественная часть (n элементов)
 * @param {Float32Array} imag — мнимая часть (n элементов)
 * @param {number} n — длина (должна быть степенью двойки)
 * @param {boolean} inverse — true для обратного преобразования
 */
export function fft1d(real, imag, n, inverse = false) {
  // Бит-реверсная перестановка
  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
    if (i < j) {
      let t = real[i]; real[i] = real[j]; real[j] = t;
      t = imag[i]; imag[i] = imag[j]; imag[j] = t;
    }
  }

  // Бабочки Cooley-Tukey
  for (let len = 2; len <= n; len <<= 1) {
    const halfLen = len >> 1;
    const angle = (inverse ? 2 : -2) * Math.PI / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < halfLen; k++) {
        const idx0 = i + k;
        const idx1 = i + k + halfLen;
        const evenRe = real[idx0];
        const evenIm = imag[idx0];
        const oddRe = real[idx1] * curRe - imag[idx1] * curIm;
        const oddIm = real[idx1] * curIm + imag[idx1] * curRe;
        real[idx0] = evenRe + oddRe;
        imag[idx0] = evenIm + oddIm;
        real[idx1] = evenRe - oddRe;
        imag[idx1] = evenIm - oddIm;
        const tRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = tRe;
      }
    }
  }

  // Нормировка для обратного преобразования
  if (inverse) {
    for (let i = 0; i < n; i++) {
      real[i] /= n;
      imag[i] /= n;
    }
  }
}

/**
 * 2D FFT через раздельные 1D-преобразования по строкам и столбцам.
 * Изменяет real и imag in-place. Размер width и height — степени двойки.
 */
export function fft2d(real, imag, width, height, inverse = false) {
  // По строкам
  const rowRe = new Float32Array(width);
  const rowIm = new Float32Array(width);
  for (let y = 0; y < height; y++) {
    const off = y * width;
    for (let x = 0; x < width; x++) {
      rowRe[x] = real[off + x];
      rowIm[x] = imag[off + x];
    }
    fft1d(rowRe, rowIm, width, inverse);
    for (let x = 0; x < width; x++) {
      real[off + x] = rowRe[x];
      imag[off + x] = rowIm[x];
    }
  }

  // По столбцам
  const colRe = new Float32Array(height);
  const colIm = new Float32Array(height);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      colRe[y] = real[y * width + x];
      colIm[y] = imag[y * width + x];
    }
    fft1d(colRe, colIm, height, inverse);
    for (let y = 0; y < height; y++) {
      real[y * width + x] = colRe[y];
      imag[y * width + x] = colIm[y];
    }
  }
}
