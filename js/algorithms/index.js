/* ============================================================
   algorithms/index.js — диспетчер методов салиентности
   ============================================================ */

import { ftSaliency } from './ft.js';
import { dogSaliency } from './dog.js';
import { localContrastSaliency } from './local.js';
import { spectralResidualSaliency } from './sr.js';

const METHODS = {
  ft:    ftSaliency,
  dog:   dogSaliency,
  local: localContrastSaliency,
  sr:    spectralResidualSaliency,
};

export function computeSaliency(imageData, method) {
  const fn = METHODS[method];
  if (!fn) throw new Error(`Неизвестный метод: ${method}`);
  return fn(imageData);
}

export const METHOD_LABELS = {
  ft:    'FT — Frequency-Tuned',
  dog:   'DoG — Difference-of-Gaussians',
  local: 'Local Contrast',
  sr:    'SR — Spectral Residual',
};
