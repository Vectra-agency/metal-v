// Изображения чертежей для моделей со зрением (только браузер): страница PDF позиции → JPEG
// не больше 1600 px по длинной стороне и 900 КБ. Сначала сканы (по ним нет текста и геометрии),
// затем позиции с расхождением массы и с предупреждениями, потом остальные; одна страница — один раз.

import { AI_LIMITS, type AiImageRef } from '../core/ai.ts';
import type { OrderPosition } from '../order.ts';
import { pdfCheck, renderPageFit } from '../pdfImport.ts';

const isScan = (p: OrderPosition) => !!p.pdf && (p.pdf.meta.scaleWhy === 'скан' || (!p.pdf.geometryFromPdf && p.geom.netArea === 0));

/** Порядок важности: 0 — скан, 1 — масса не сходится, 2 — есть предупреждения, 3 — остальные */
export function imagePriority(p: OrderPosition): number {
  if (isScan(p)) return 0;
  const chk = pdfCheck(p);
  if (chk && (chk.status === 'bad' || chk.status === 'warn')) return 1;
  if (p.warnings.length) return 2;
  return 3;
}

/** Какие позиции показать модели: по одной на страницу PDF, по важности, не больше max */
export function pickImagePositions(positions: OrderPosition[], max: number = AI_LIMITS.images): OrderPosition[] {
  const seen = new Set<string>();
  const cand = positions
    .map((p, i) => ({ p, i, prio: imagePriority(p) }))
    .filter(({ p }) => p.pdf && !p.disabled)
    .sort((a, b) => a.prio - b.prio || a.i - b.i);
  const out: OrderPosition[] = [];
  for (const { p } of cand) {
    const key = `${p.pdf!.fileKey}#${p.pdf!.meta.page}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
    if (out.length >= max) break;
  }
  return out;
}

const toBlob = (c: HTMLCanvasElement, q: number) => new Promise<Blob | null>((res) => c.toBlob(res, 'image/jpeg', q));

/** JPEG не больше limit: сначала снижаем качество, потом размер */
async function jpegUnder(canvas: HTMLCanvasElement, limit: number): Promise<Blob | null> {
  let src = canvas;
  for (let shrink = 0; shrink < 3; shrink++) {
    for (const q of [0.7, 0.55, 0.4]) {
      const b = await toBlob(src, q);
      if (b && b.size <= limit) return b;
    }
    // уменьшаем на четверть
    const next = document.createElement('canvas');
    next.width = Math.max(1, Math.round(src.width * 0.75));
    next.height = Math.max(1, Math.round(src.height * 0.75));
    const ctx = next.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, next.width, next.height);
    ctx.drawImage(src, 0, 0, next.width, next.height);
    if (src !== canvas) src.width = src.height = 0;
    src = next;
  }
  return null;
}

/** Изображения страниц чертежей для анализа; refs — для AiContext.images, blobs — в том же порядке */
export async function drawingImages(positions: OrderPosition[], max: number = AI_LIMITS.images): Promise<{ refs: AiImageRef[]; blobs: Blob[] }> {
  const refs: AiImageRef[] = [];
  const blobs: Blob[] = [];
  for (const p of pickImagePositions(positions, max)) {
    const canvas = document.createElement('canvas');
    try {
      const size = await renderPageFit(p.pdf!.fileKey, p.pdf!.meta.page, canvas, AI_LIMITS.imageMaxSidePx);
      if (!size) continue; // файла нет в IndexedDB (заказ из другого браузера)
      const blob = await jpegUnder(canvas, AI_LIMITS.imageBytes);
      if (!blob) continue;
      refs.push({ index: refs.length, positionId: p.id, caption: `${p.name}, стр. ${p.pdf!.meta.page + 1}${isScan(p) ? ' (скан)' : ''}` });
      blobs.push(blob);
    } catch {
      /* страница не отрисовалась — без неё */
    } finally {
      canvas.width = canvas.height = 0;
    }
  }
  return { refs, blobs };
}
