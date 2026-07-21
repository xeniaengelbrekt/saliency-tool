/* ============================================================
   dog.js — Difference-of-Gaussians (многомасштабный контраст яркости)
   ============================================================ */

import { rgbToGray } from './color.js';
import { gaussBlur1D } from './blur.js';
import { normalize } from './util.js';

const SCALE_PAIRS = [
  [1, 2],
  [2, 4],
  [4, 8],
  [8, 16],
];

export function dogSaliency(imageData) {
  const gray = rgbToGray(imageData);
  const { width, height } = imageData;
  const N = width * height;
  const S = new Float32Array(N);

  for (const [s1, s2] of SCALE_PAIRS) {
    const g1 = gaussBlur1D(gray, width, height, s1);
    const g2 = gaussBlur1D(gray, width, height, s2);
    for (let i = 0; i < N; i++) {
      S[i] += Math.abs(g1[i] - g2[i]);
    }
  }

  return normalize(S);
}
