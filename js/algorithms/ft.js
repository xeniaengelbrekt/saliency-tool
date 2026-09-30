/* ============================================================
   ft.js — Frequency-Tuned Saliency (Achanta et al., 2009)

   Как в оригинальной статье:
     S(x, y) = ‖ I_μ − I_ωhc(x, y) ‖
   где I_μ — средний Lab-вектор изображения, I_ωhc — изображение,
   размытое биномиальным ядром 5×5 ([1 4 6 4 1] / 16), а ‖·‖ —
   евклидова норма (НЕ её квадрат: квадрат искажает распределение
   значений и занижает mean / spread / entropy).
   ============================================================ */

import { rgbToLab } from './color.js';
import { normalize } from './util.js';

const BINOMIAL = [1 / 16, 4 / 16, 6 / 16, 4 / 16, 1 / 16];

export function ftSaliency(imageData) {
  const { L, A, B, width, height } = rgbToLab(imageData);
  const N = L.length;

  // Среднее по каждому каналу
  let sumL = 0, sumA = 0, sumB = 0;
  for (let i = 0; i < N; i++) {
    sumL += L[i];
    sumA += A[i];
    sumB += B[i];
  }
  const muL = sumL / N;
  const muA = sumA / N;
  const muB = sumB / N;

  // Биномиальное размытие 5×5 каждого канала
  const Lb = binomialBlur(L, width, height);
  const Ab = binomialBlur(A, width, height);
  const Bb = binomialBlur(B, width, height);

  // Карта: евклидово расстояние от среднего до размытого
  const S = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const dL = muL - Lb[i];
    const dA = muA - Ab[i];
    const dB = muB - Bb[i];
    S[i] = Math.sqrt(dL * dL + dA * dA + dB * dB);
  }

  return normalize(S);
}

/** Разделяемое биномиальное размытие 5×5, clamp-to-edge. */
function binomialBlur(src, width, height) {
  const tmp = new Float32Array(width * height);
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let k = -2; k <= 2; k++) {
        let xi = x + k;
        if (xi < 0) xi = 0; else if (xi >= width) xi = width - 1;
        acc += src[row + xi] * BINOMIAL[k + 2];
      }
      tmp[row + x] = acc;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let k = -2; k <= 2; k++) {
        let yi = y + k;
        if (yi < 0) yi = 0; else if (yi >= height) yi = height - 1;
        acc += tmp[yi * width + x] * BINOMIAL[k + 2];
      }
      out[y * width + x] = acc;
    }
  }
  return out;
}
