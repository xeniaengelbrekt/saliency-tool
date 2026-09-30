/* ============================================================
   loader.js — загрузка изображений
   File → рабочая копия ImageData (длинная сторона 256 px,
   ПРОПОРЦИИ СОХРАНЕНЫ) + оригинал для рендера в исходном разрешении.

   Раньше изображение сжималось в квадрат 256×256, из-за чего
   широкие и высокие кадры искажались: размытие становилось
   анизотропным, а центр/периферия и корреляции между картами
   считались по деформированному изображению.
   ============================================================ */

/** Длина длинной стороны рабочей копии, px. */
export const TARGET_SIZE = 256;
const MIN_SIDE = 8;

/** Размер рабочей копии для исходного w×h (длинная сторона = TARGET_SIZE). */
export function workSize(w, h) {
  const k = TARGET_SIZE / Math.max(w, h);
  return {
    width:  Math.max(MIN_SIDE, Math.round(w * k)),
    height: Math.max(MIN_SIDE, Math.round(h * k)),
  };
}

const ALLOWED = /\.(jpe?g|png|webp|bmp)$/i;

/**
 * Загружает один File → объект с ImageData 256×256, превью-data-URL,
 * оригинальным разрешением и оригинальным <img>.
 */
export function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    if (!ALLOWED.test(file.name)) {
      reject(new Error(`Неподдерживаемый формат: ${file.name}`));
      return;
    }

    const url = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      try {
        const origW = img.naturalWidth;
        const origH = img.naturalHeight;

        const { width: ww, height: wh } = workSize(origW, origH);
        const canvas = document.createElement('canvas');
        canvas.width = ww;
        canvas.height = wh;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, ww, wh);

        const imageData = ctx.getImageData(0, 0, ww, wh);
        const thumb = canvas.toDataURL('image/jpeg', 0.85);

        resolve({
          imageData,
          thumb,
          origW,
          origH,
          origImage: img,
          name: file.name,
          file,
        });
      } catch (err) {
        URL.revokeObjectURL(url);
        reject(err);
      }
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Не удалось загрузить ${file.name}`));
    };

    img.src = url;
  });
}

/**
 * Параллельная загрузка нескольких файлов. Возвращает {ok: [...], errors: [...]}.
 */
export async function loadImageFiles(files) {
  const results = await Promise.allSettled([...files].map(loadImageFile));
  const ok = [];
  const errors = [];
  for (const r of results) {
    if (r.status === 'fulfilled') ok.push(r.value);
    else errors.push(r.reason);
  }
  return { ok, errors };
}

/**
 * Извлечь рабочую копию ImageData (пропорции сохранены) из произвольной
 * области HTMLImageElement (превью регионов составного стимула).
 */
export function cropToImageData(srcImage, sx, sy, sw, sh) {
  const { width: ww, height: wh } = workSize(sw, sh);
  const canvas = document.createElement('canvas');
  canvas.width = ww;
  canvas.height = wh;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(srcImage, sx, sy, sw, sh, 0, 0, ww, wh);
  return {
    imageData: ctx.getImageData(0, 0, ww, wh),
    thumb: canvas.toDataURL('image/jpeg', 0.85),
  };
}
