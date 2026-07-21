/* ============================================================
   local.js — Local Color Contrast (быстрый скрининговый метод)
   ============================================================ */

import { rgbChannels } from './color.js';
import { gaussBlur1D } from './blur.js';
import { normalize } from './util.js';

export function localContrastSaliency(imageData) {
  const { R, G, B, width, height } = rgbChannels(imageData);
  const N = R.length;

  const sigma = 0.08 * Math.min(width, height);
  const Rb = gaussBlur1D(R, width, height, sigma);
  const Gb = gaussBlur1D(G, width, height, sigma);
  const Bb = gaussBlur1D(B, width, height, sigma);

  const S = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const dR = R[i] - Rb[i];
    const dG = G[i] - Gb[i];
    const dB = B[i] - Bb[i];
    S[i] = dR * dR + dG * dG + dB * dB;
  }

  return normalize(S);
}
