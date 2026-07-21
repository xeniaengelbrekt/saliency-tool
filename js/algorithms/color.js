/* ============================================================
   color.js — преобразования цветовых пространств
   sRGB → CIE Lab (через линеаризацию и XYZ, белая точка D65),
   а также извлечение grayscale и нормированных RGB-каналов.
   ============================================================ */

const T = 0.008856;
const F_OFFSET = 16 / 116; // ≈ 0.137931034

/**
 * sRGB → CIE Lab.
 * Возвращает три Float32Array (L*, a*, b*) длины width*height.
 */
export function rgbToLab(imageData) {
  const { data, width, height } = imageData;
  const N = width * height;
  const L = new Float32Array(N);
  const A = new Float32Array(N);
  const B = new Float32Array(N);

  for (let i = 0; i < N; i++) {
    const idx = i * 4;
    const rn = data[idx]     / 255;
    const gn = data[idx + 1] / 255;
    const bn = data[idx + 2] / 255;

    // sRGB linearize
    const R  = rn > 0.04045 ? Math.pow((rn + 0.055) / 1.055, 2.4) : rn / 12.92;
    const G  = gn > 0.04045 ? Math.pow((gn + 0.055) / 1.055, 2.4) : gn / 12.92;
    const Bl = bn > 0.04045 ? Math.pow((bn + 0.055) / 1.055, 2.4) : bn / 12.92;

    // Linear RGB → XYZ (D65), уже отмасштабированный к референсной белой точке
    const X = (R * 0.4124 + G * 0.3576 + Bl * 0.1805) / 0.95047;
    const Y =  R * 0.2126 + G * 0.7152 + Bl * 0.0722;
    const Z = (R * 0.0193 + G * 0.1192 + Bl * 0.9505) / 1.08883;

    const fX = X > T ? Math.cbrt(X) : 7.787 * X + F_OFFSET;
    const fY = Y > T ? Math.cbrt(Y) : 7.787 * Y + F_OFFSET;
    const fZ = Z > T ? Math.cbrt(Z) : 7.787 * Z + F_OFFSET;

    L[i] = 116 * fY - 16;
    A[i] = 500 * (fX - fY);
    B[i] = 200 * (fY - fZ);
  }

  return { L, A, B, width, height };
}

/** Извлечь яркость (Float32Array) по формуле Rec.601. */
export function rgbToGray(imageData) {
  const { data, width, height } = imageData;
  const N = width * height;
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const idx = i * 4;
    out[i] = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
  }
  return out;
}

/** Извлечь R, G, B как Float32Array в [0, 1]. */
export function rgbChannels(imageData) {
  const { data, width, height } = imageData;
  const N = width * height;
  const R = new Float32Array(N);
  const G = new Float32Array(N);
  const B = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const idx = i * 4;
    R[i] = data[idx]     / 255;
    G[i] = data[idx + 1] / 255;
    B[i] = data[idx + 2] / 255;
  }
  return { R, G, B, width, height };
}
