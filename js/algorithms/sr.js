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
     8. Билинейный апскейл до 256×256, нормировка в [0, 1].

   Размер 64×64 фиксированный — степень двойки, нужен для radix-2 FFT.
   На малом размере SR обычно работает лучше, чем на большом, и это
   соответствует оригинальной публикации.
   ============================================================ */

import { rgbToGray } from './color.js';
import { gaussBlur1D } from './blur.js';
import { fft2d } from './fft.js';
import { normalize } from './util.js';

const SR_SIZE = 64;        // FFT работает на 64×64
const FINAL_SIZE = 256;    // Для согласованности с другими методами
const SR_LOG_SIGMA = 8;    // σ финального гауссова размытия (на 64×64)
const LOG_KERNEL = 3;      // окно усреднения лог-спектра (3×3 по оригиналу)
const EPS = 1e-10;         // защита логарифма от нуля

export function spectralResidualSaliency(imageData) {
  const { width: srcW, height: srcH } = imageData;

  // Шаг 1: яркость + downsample 64×64 box-усреднением
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

  // Шаг 9: апскейл до 256×256, чтобы метрики и render были согласованы
  const upscaled = upscaleBilinear(blurred, SR_SIZE, SR_SIZE, FINAL_SIZE, FINAL_SIZE);

  // Шаг 10: нормировка [0, 1]
  return normalize(upscaled);
}

/* ============================================================
   Вспомогательные процедуры
   ============================================================ */

/** Box-усреднение при downsampling в произвольной кратности. */
function downsample(src, srcW, srcH, dstW, dstH) {
  const out = new Float32Array(dstW * dstH);
  const sx = srcW / dstW;
  const sy = srcH / dstH;
  for (let y = 0; y < dstH; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < dstW; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let sum = 0, cnt = 0;
      for (let yi = y0; yi < y1 && yi < srcH; yi++) {
        for (let xi = x0; xi < x1 && xi < srcW; xi++) {
          sum += src[yi * srcW + xi];
          cnt++;
        }
      }
      out[y * dstW + x] = cnt > 0 ? sum / cnt : 0;
    }
  }
  return out;
}

/** Билинейная интерполяция при upscaling. */
function upscaleBilinear(src, srcW, srcH, dstW, dstH) {
  const out = new Float32Array(dstW * dstH);
  const sx = (srcW - 1) / (dstW - 1);
  const sy = (srcH - 1) / (dstH - 1);
  for (let y = 0; y < dstH; y++) {
    const fy = y * sy;
    const y0 = Math.floor(fy);
    const y1 = y0 + 1 < srcH ? y0 + 1 : y0;
    const dy = fy - y0;
    for (let x = 0; x < dstW; x++) {
      const fx = x * sx;
      const x0 = Math.floor(fx);
      const x1 = x0 + 1 < srcW ? x0 + 1 : x0;
      const dx = fx - x0;
      const v00 = src[y0 * srcW + x0];
      const v01 = src[y0 * srcW + x1];
      const v10 = src[y1 * srcW + x0];
      const v11 = src[y1 * srcW + x1];
      const v0 = v00 * (1 - dx) + v01 * dx;
      const v1 = v10 * (1 - dx) + v11 * dx;
      out[y * dstW + x] = v0 * (1 - dy) + v1 * dy;
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
