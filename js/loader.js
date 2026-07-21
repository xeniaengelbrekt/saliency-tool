/* ============================================================
   loader.js — загрузка изображений
   File → ImageData 256×256 (фиксированный размер для скорости)
   + сохранение оригинала для рендера в исходном разрешении.
   ============================================================ */

export const TARGET_SIZE = 256;

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

        const canvas = document.createElement('canvas');
        canvas.width = TARGET_SIZE;
        canvas.height = TARGET_SIZE;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, TARGET_SIZE, TARGET_SIZE);

        const imageData = ctx.getImageData(0, 0, TARGET_SIZE, TARGET_SIZE);
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
 * Извлечь ImageData 256×256 из произвольной области HTMLImageElement
 * (для режима составного стимула).
 */
export function cropToImageData(srcImage, sx, sy, sw, sh) {
  const canvas = document.createElement('canvas');
  canvas.width = TARGET_SIZE;
  canvas.height = TARGET_SIZE;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(srcImage, sx, sy, sw, sh, 0, 0, TARGET_SIZE, TARGET_SIZE);
  return {
    imageData: ctx.getImageData(0, 0, TARGET_SIZE, TARGET_SIZE),
    thumb: canvas.toDataURL('image/jpeg', 0.85),
  };
}
