/* ============================================================
   colormap.js — цветовые карты Jet / Hot / Gray
   Каждая функция: s ∈ [0, 1] → [R, G, B] в [0, 255].
   ============================================================ */

const clamp255 = (v) => v < 0 ? 0 : v > 255 ? 255 : v;

export function jet(s) {
  const r = clamp255(255 * (1.5 - Math.abs(4 * s - 3)));
  const g = clamp255(255 * (1.5 - Math.abs(4 * s - 2)));
  const b = clamp255(255 * (1.5 - Math.abs(4 * s - 1)));
  return [r | 0, g | 0, b | 0];
}

export function hot(s) {
  const r = clamp255(s * 3 * 255);
  const g = clamp255((s * 3 - 1) * 255);
  const b = clamp255((s * 3 - 2) * 255);
  return [r | 0, g | 0, b | 0];
}

export function gray(s) {
  const v = clamp255(s * 255) | 0;
  return [v, v, v];
}

const REGISTRY = { jet, hot, gray };

export function getColormap(name) {
  return REGISTRY[name] || jet;
}

/** Сгенерировать data URL легенды (горизонтальный градиент) для UI. */
export function colormapLegendDataURL(name, width = 200, height = 12) {
  const cmap = getColormap(name);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(width, height);
  for (let x = 0; x < width; x++) {
    const s = x / (width - 1);
    const [r, g, b] = cmap(s);
    for (let y = 0; y < height; y++) {
      const idx = (y * width + x) * 4;
      img.data[idx]     = r;
      img.data[idx + 1] = g;
      img.data[idx + 2] = b;
      img.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL();
}
