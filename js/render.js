/* ============================================================
   render.js — рендеринг тепловых карт на canvas
   ============================================================ */

import { getColormap } from './colormap.js';

/**
 * Рисует карту салиентности sal (Float32Array, размер srcW*srcH, в [0,1])
 * на canvas размером dstW*dstH с цветовой картой и прозрачностью.
 * Если размеры совпадают — рендер напрямую; иначе — через промежуточный
 * canvas + drawImage с билинейной интерполяцией.
 *
 * @param {Float32Array} sal
 * @param {number} srcW
 * @param {number} srcH
 * @param {number} dstW
 * @param {number} dstH
 * @param {string} colormap
 * @param {number} alpha     — 0..1
 * @returns {HTMLCanvasElement}
 */
export function renderHeatmap(sal, srcW, srcH, dstW, dstH, colormap, alpha) {
  const cmap = getColormap(colormap);

  // Сначала всегда рендерим в нативном разрешении карты
  const small = document.createElement('canvas');
  small.width = srcW;
  small.height = srcH;
  const sctx = small.getContext('2d');
  const img = sctx.createImageData(srcW, srcH);
  const data = img.data;

  for (let i = 0; i < sal.length; i++) {
    const s = sal[i];
    const [r, g, b] = cmap(s);
    const a = Math.round(s * alpha * 255);
    const idx = i * 4;
    data[idx]     = r;
    data[idx + 1] = g;
    data[idx + 2] = b;
    data[idx + 3] = a;
  }
  sctx.putImageData(img, 0, 0);

  if (dstW === srcW && dstH === srcH) return small;

  // Апскейл с билинейной интерполяцией
  const out = document.createElement('canvas');
  out.width = dstW;
  out.height = dstH;
  const octx = out.getContext('2d');
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(small, 0, 0, dstW, dstH);
  return out;
}

/**
 * Рисует оверлей: оригинал + тепловая карта поверх.
 * srcImg — HTMLImageElement | HTMLCanvasElement (исходник).
 */
export function renderOverlay(srcImg, sal, srcW, srcH, dstW, dstH, colormap, alpha) {
  const canvas = document.createElement('canvas');
  canvas.width = dstW;
  canvas.height = dstH;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(srcImg, 0, 0, dstW, dstH);
  const heat = renderHeatmap(sal, srcW, srcH, dstW, dstH, colormap, alpha);
  ctx.drawImage(heat, 0, 0);
  return canvas;
}

/** Промис для canvas.toBlob — для удобства в async-коде. */
export function canvasToBlob(canvas, type = 'image/png', quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}
