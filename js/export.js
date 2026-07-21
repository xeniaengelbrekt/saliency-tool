/* ============================================================
   export.js — CSV / PNG / ZIP экспорт
   ============================================================ */

import { canvasToBlob } from './render.js';

const BOM = '﻿';

/* ----------------------- CSV ----------------------- */

function escapeCell(v) {
  if (v == null) return '""';
  const s = String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * Сериализует rows (массив массивов) в CSV-строку с UTF-8 BOM.
 * Числа форматируются с десятичной точкой, разделитель — запятая.
 */
export function toCSV(rows) {
  const lines = rows.map((row) => row.map(escapeCell).join(','));
  return BOM + lines.join('\r\n');
}

/** Триггерит скачивание текстового CSV под именем filename. */
export function downloadCSV(rows, filename) {
  const csv = toCSV(rows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  downloadBlob(blob, filename);
}

/* ----------------------- Blob download ----------------------- */

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 0);
}

/* ----------------------- PNG ----------------------- */

export async function downloadCanvasPNG(canvas, filename) {
  const blob = await canvasToBlob(canvas, 'image/png');
  if (blob) downloadBlob(blob, filename);
}

/* ----------------------- ZIP (через JSZip) ----------------------- */

/** Возвращает true, если JSZip доступен (через CDN, см. index.html). */
export function jsZipAvailable() {
  return typeof window !== 'undefined' && typeof window.JSZip === 'function';
}

/**
 * Собирает ZIP-архив из массива {name, blob} и скачивает его.
 * Если JSZip недоступен — последовательно скачивает файлы по одному.
 */
export async function downloadZip(entries, zipName) {
  if (jsZipAvailable()) {
    const zip = new window.JSZip();
    for (const e of entries) {
      zip.file(e.name, e.blob);
    }
    const blob = await zip.generateAsync({ type: 'blob' });
    downloadBlob(blob, zipName);
    return;
  }

  // Fallback: по одному, с небольшой задержкой между файлами
  for (let i = 0; i < entries.length; i++) {
    const { name, blob } = entries[i];
    downloadBlob(blob, name);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Безопасное имя файла без расширения. */
export function stripExt(filename) {
  return filename.replace(/\.[^.]+$/, '');
}
