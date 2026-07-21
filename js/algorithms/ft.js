/* ============================================================
   ft.js — Frequency-Tuned Saliency (Achanta et al., 2009)
   ============================================================ */

import { rgbToLab } from './color.js';
import { gaussBlur1D } from './blur.js';
import { normalize } from './util.js';

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

  // Гауссово размытие каждого канала
  const sigma = 0.025 * Math.min(width, height);
  const Lb = gaussBlur1D(L, width, height, sigma);
  const Ab = gaussBlur1D(A, width, height, sigma);
  const Bb = gaussBlur1D(B, width, height, sigma);

  // Карта: квадрат расстояния от среднего до размытого
  const S = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const dL = muL - Lb[i];
    const dA = muA - Ab[i];
    const dB = muB - Bb[i];
    S[i] = dL * dL + dA * dA + dB * dB;
  }

  return normalize(S);
}
