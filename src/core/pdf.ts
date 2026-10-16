// Чтение векторного PDF-чертежа через pdf.js: линии (с толщиной) и текст
// в миллиметрах листа, ось Y вверх — как в DXF. Модуль pdf.js передаётся
// снаружи, чтобы ядро работало и в браузере, и в Node.

import type { Vec } from './dxf.ts';

export interface PdfPath {
  pts: Vec[];
  closed: boolean;
  width: number; // толщина линии, мм
  length: number; // мм на листе
}

export interface PdfText {
  str: string;
  x: number; // левый нижний угол, мм
  y: number;
  w: number;
  h: number; // высота шрифта, мм
  angle: number; // градусы
}

export interface PdfPageData {
  index: number;
  width: number; // мм
  height: number;
  paths: PdfPath[];
  texts: PdfText[];
  images: number; // растровые картинки (скан)
}

// минимальный интерфейс pdf.js, который нам нужен
export interface PdfJsLike {
  getDocument(src: { data: Uint8Array; isEvalSupported?: boolean; disableFontFace?: boolean }): { promise: Promise<any> };
  OPS: Record<string, number>;
}

const PT = 25.4 / 72;

type M = [number, number, number, number, number, number];
const mul = (a: M, b: M): M => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];
const ap = (m: M, x: number, y: number): Vec => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });

function bezier(p0: Vec, p1: Vec, p2: Vec, p3: Vec): Vec[] {
  const size = Math.hypot(p3.x - p0.x, p3.y - p0.y) + Math.hypot(p1.x - p0.x, p1.y - p0.y) + Math.hypot(p3.x - p2.x, p3.y - p2.y);
  const n = Math.min(32, Math.max(4, Math.ceil(size / 2)));
  const out: Vec[] = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push({
      x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
    });
  }
  return out;
}

export async function readPdf(pdfjs: PdfJsLike, buf: ArrayBuffer, maxPages = 60): Promise<PdfPageData[]> {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf.slice(0)), isEvalSupported: false, disableFontFace: true }).promise;
  const O = pdfjs.OPS;
  const pages: PdfPageData[] = [];
  const n = Math.min(doc.numPages, maxPages);
  for (let pi = 1; pi <= n; pi++) {
    const page = await doc.getPage(pi);
    const vp = page.getViewport({ scale: 1 });
    // в мм с осью Y вверх: учитывает и смещение, и поворот страницы
    const toMm: M = [PT, 0, 0, -PT, 0, vp.height * PT];
    const base: M = mul(toMm, vp.transform as M);
    const ops = await page.getOperatorList();
    const paths: PdfPath[] = [];
    let images = 0;
    let ctm: M = [1, 0, 0, 1, 0, 0];
    let lw = 1;
    const stack: { ctm: M; lw: number }[] = [];
    const scaleOf = (m: M) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));

    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i];
      const args = ops.argsArray[i];
      if (fn === O.save) stack.push({ ctm, lw });
      else if (fn === O.restore) {
        const s = stack.pop();
        if (s) ({ ctm, lw } = s);
      } else if (fn === O.transform) ctm = mul(ctm, args as M);
      else if (fn === O.setLineWidth) lw = args[0];
      else if (fn === O.setGState) {
        for (const [k, v] of args[0] ?? []) if (k === 'LW') lw = v;
      } else if (fn === O.paintFormXObjectBegin) {
        stack.push({ ctm, lw });
        if (Array.isArray(args[0]) || ArrayBuffer.isView(args[0])) ctm = mul(ctm, Array.from(args[0] as ArrayLike<number>) as M);
      } else if (fn === O.paintFormXObjectEnd) {
        const s = stack.pop();
        if (s) ({ ctm, lw } = s);
      } else if (fn === O.paintImageXObject || fn === O.paintInlineImageXObject || fn === O.paintImageXObjectRepeat) {
        images++;
      } else if (fn === O.constructPath) {
        const paintOp = args[0];
        // берём только обводку: заливки — это стрелки, шрифт, штриховка
        if (paintOp !== O.stroke && paintOp !== O.closeStroke) continue;
        const data: ArrayLike<number> | undefined = args[1]?.[0];
        if (!data) continue;
        const M2 = mul(base, ctm);
        const width = Math.max(0, lw * scaleOf(ctm)) * PT;
        let cur: Vec[] = [];
        let start: Vec | null = null;
        const flush = (closed: boolean) => {
          if (cur.length > 1) {
            let len = 0;
            for (let k = 1; k < cur.length; k++) len += Math.hypot(cur[k].x - cur[k - 1].x, cur[k].y - cur[k - 1].y);
            if (closed && start) len += Math.hypot(cur[0].x - cur[cur.length - 1].x, cur[0].y - cur[cur.length - 1].y);
            // КОМПАС закрывает даже одиночные отрезки (m l h S) — замкнутым считаем только от 3 точек
            paths.push({ pts: cur, closed: (closed || paintOp === O.closeStroke) && cur.length > 2, width, length: len });
          }
          cur = [];
        };
        let k = 0;
        while (k < data.length) {
          const code = data[k++];
          if (code === 0) {
            flush(false);
            start = ap(M2, data[k], data[k + 1]);
            cur = [start];
            k += 2;
          } else if (code === 1) {
            cur.push(ap(M2, data[k], data[k + 1]));
            k += 2;
          } else if (code === 2) {
            const p0 = cur[cur.length - 1] ?? ap(M2, data[k], data[k + 1]);
            cur.push(...bezier(p0, ap(M2, data[k], data[k + 1]), ap(M2, data[k + 2], data[k + 3]), ap(M2, data[k + 4], data[k + 5])));
            k += 6;
          } else if (code === 3) {
            const p0 = cur[cur.length - 1] ?? ap(M2, data[k], data[k + 1]);
            const q1 = ap(M2, data[k], data[k + 1]);
            const q2 = ap(M2, data[k + 2], data[k + 3]);
            // квадратичная → кубическая
            const c1 = { x: p0.x + (2 / 3) * (q1.x - p0.x), y: p0.y + (2 / 3) * (q1.y - p0.y) };
            const c2 = { x: q2.x + (2 / 3) * (q1.x - q2.x), y: q2.y + (2 / 3) * (q1.y - q2.y) };
            cur.push(...bezier(p0, c1, c2, q2));
            k += 4;
          } else if (code === 4) {
            flush(true);
            if (start) cur = [start];
          } else break; // неизвестный код — прекращаем разбор этого пути
        }
        flush(false);
      }
    }

    const tc = await page.getTextContent();
    const texts: PdfText[] = [];
    for (const it of tc.items as any[]) {
      if (!it.str || !it.str.trim()) continue;
      const t = mul(base, it.transform as M);
      const h = Math.hypot(t[2], t[3]);
      texts.push({
        // типографские тире и минус (Word, 1С) → обычный дефис, иначе не найдём обозначение
        str: it.str.replace(/[\u2010-\u2015\u2212]/g, '-').trim(),
        x: t[4],
        y: t[5],
        w: (it.width ?? 0) * PT,
        h,
        angle: (Math.atan2(t[1], t[0]) * 180) / Math.PI,
      });
    }
    pages.push({ index: pi - 1, width: vp.width * PT, height: vp.height * PT, paths, texts, images });
    page.cleanup?.();
  }
  await doc.destroy?.();
  return pages;
}
