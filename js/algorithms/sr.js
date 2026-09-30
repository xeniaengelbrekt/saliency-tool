/* ============================================================
   sr.js — Spectral Residual Saliency (Hou & Zhang, 2007).

   Логика:
     1. Перевод в grayscale, ресайз до 64×64 (стандарт SR).
     2. 2D FFT → амплитуда A, фаза P, лог-амплитуда L = log(A).
     3. Сглаженный лог-спектр Q = mean3x3(L).
     4. Спектральный остаток R = L − Q.
     5. Реконструкция: inverse FFT( exp(R) · e^{iP} ).
     6. Карта = |reconstructed|².
     7. Гауссово размытие (σ = 8 для 64×64).
     8. Билинейное увеличение (по центрам пикселей) до размера рабочей
        копии изображения (пропорции сохранены), нормировка в [0, 1].

   Размер 64×64 фиксированный — степень двойки, нужен для radix-2 FFT.
   На малом размере SR обычно работает лучше, чем на большом, и это
   соответствует оригинальной публикации.
   ============================================================ */

import { rgbToGray } from './color.js';
import { gaussBlur1D } from './blur.js';
import { fft2d } from './fft.js';
import { normalize, resampleMap } from './util.js';

const SR_SIZE = 64;        // FFT работает на 64×64
const SR_LOG_SIGMA = 8;    // σ финального гауссова размытия (на 64×64)
const LOG_KERNEL = 3;      // окно усреднения лог-спектра (3×3 по оригиналу)
const EPS = 1e-10;         // защита логарифма от нуля

export function spectralResidualSaliency(imageData) {
  const { width: srcW, height: srcH } = imageData;

  // Шаг 1: яркость + сжатие до 64×64 усреднением по площади (вес пикселя = доля покрытия)
  const gray = rgbToGray(imageData);
  const small = downsample(gray, srcW, srcH, SR_SIZE, SR_SIZE);

  const N = SR_SIZE * SR_SIZE;
  const real = new Float32Array(N);
  const imag = new Float32Array(N);
  for (let i = 0; i < N; i++) real[i] = small[i];

  // Шаг 2: прямое 2D FFT
  fft2d(real, imag, SR_SIZE, SR_SIZE, false);

  // Шаг 3: лог-амплитуда L и фаза P
  const logAmp = new Float32Array(N);
  const phase  = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const A = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]);
    logAmp[i] = Math.log(A < EPS ? EPS : A);
    phase[i]  = Math.atan2(imag[i], real[i]);
  }

  // Шаг 4: сглаженный лог-спектр Q = box(L, 3×3)
  const Q = boxFilter(logAmp, SR_SIZE, SR_SIZE, LOG_KERNEL);

  // Шаг 5: остаток R = L − Q; собираем комплексный сигнал exp(R)·e^{iP}
  for (let i = 0; i < N; i++) {
    const r = logAmp[i] - Q[i];
    const expR = Math.exp(r);
    real[i] = expR * Math.cos(phase[i]);
    imag[i] = expR * Math.sin(phase[i]);
  }

  // Шаг 6: обратное 2D FFT
  fft2d(real, imag, SR_SIZE, SR_SIZE, true);

  // Шаг 7: карта = квадрат модуля
  const sal = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    sal[i] = real[i] * real[i] + imag[i] * imag[i];
  }

  // Шаг 8: финальное гауссово размытие
  const blurred = gaussBlur1D(sal, SR_SIZE, SR_SIZE, SR_LOG_SIGMA);

  // Шаг 9: апскейл до размера рабочей копии — чтобы карта совпадала с другими методами
  const upscaled = resampleMap(blurred, SR_SIZE, SR_SIZE, srcW, srcH);   // билинейно, по центрам пикселей

  // Шаг 10: нормировка [0, 1]
  return normalize(upscaled);
}

/* ============================================================
   Вспомогательные процедуры
   ============================================================ */

/**
 * Веса усреднения по площади для одной оси: для каждой ячейки результата —
 * индексы исходных пикселей и доли их покрытия (сумма весов = 1). Работает при любом
 * соотношении размеров, в том числе нецелом (например, 171 → 64).
 */
function axisWeights(srcN, dstN) {
  const s = srcN / dstN;
  const out = [];
  for (let d = 0; d < dstN; d++) {
    const a = d * s, b = (d + 1) * s;
    const idx = [], wt = [];
    for (let i = Math.floor(a); i < Math.min(srcN, Math.ceil(b)); i++) {
      const lo = Math.max(a, i), hi = Math.min(b, i + 1);
      if (hi > lo) { idx.push(i); wt.push((hi - lo) / s); }
    }
    out.push({ idx, wt });
  }
  return out;
}

/** Усреднение по площади (эквивалент cv2.INTER_AREA): блоки с дробными границами. */
function downsample(src, srcW, srcH, dstW, dstH) {
  const wx = axisWeights(srcW, dstW);
  const wy = axisWeights(srcH, dstH);
  const out = new Float32Array(dstW * dstH);
  for (let y = 0; y < dstH; y++) {
    const { idx: iy, wt: ty } = wy[y];
    for (let x = 0; x < dstW; x++) {
      const { idx: ix, wt: tx } = wx[x];
      let acc = 0;
      for (let j = 0; j < iy.length; j++) {
        let row = 0;
        const base = iy[j] * srcW;
        for (let i = 0; i < ix.length; i++) row += src[base + ix[i]] * tx[i];
        acc += row * ty[j];
      }
      out[y * dstW + x] = acc;
    }
  }
  return out;
}

/** Простой box-фильтр k×k с граничным условием clamp-to-edge. */
function boxFilter(src, w, h, k) {
  const half = (k - 1) >> 1;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0, cnt = 0;
      for (let dy = -half; dy <= half; dy++) {
        let yi = y + dy;
        if (yi < 0) yi = 0;
        else if (yi >= h) yi = h - 1;
        for (let dx = -half; dx <= half; dx++) {
          let xi = x + dx;
          if (xi < 0) xi = 0;
          else if (xi >= w) xi = w - 1;
          sum += src[yi * w + xi];
          cnt++;
        }
      }
      out[y * w + x] = sum / cnt;
    }
  }
  return out;
}
