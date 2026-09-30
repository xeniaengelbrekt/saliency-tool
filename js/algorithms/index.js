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

/**
 * Считает карту салиентности. Карта имеет размер рабочей копии
 * изображения (длинная сторона 256 px, пропорции сохранены);
 * размеры прикреплены к массиву как sal.width / sal.height.
 */
export function computeSaliency(imageData, method) {
  const fn = METHODS[method];
  if (!fn) throw new Error(`Неизвестный метод: ${method}`);
  const sal = fn(imageData);
  sal.width = imageData.width;
  sal.height = imageData.height;
  return sal;
}

export const METHOD_LABELS = {
  ft:    'FT — Frequency-Tuned',
  dog:   'DoG — Difference-of-Gaussians',
  local: 'Local Contrast',
  sr:    'SR — Spectral Residual',
};
