// Импорт PDF-чертежей в браузере: pdf.js грузится только при первом PDF,
// исходный файл сохраняется в IndexedDB, чтобы чертёж можно было открыть позже.

import type { Vec } from './core/dxf.ts';
import { getMaterial, kgPerM2, parseFileName } from './core/materials.ts';
import { readPdf, type PdfJsLike, type PdfPageData } from './core/pdf.ts';
import {
  analyzePdf,
  buildGeometry,
  findDesignation,
  groupDrawings,
  keyDesig,
  metaFor,
  pickFor,
  readQtyList,
  type PdfAnalysis,
  type PdfMeta,
  type QtyLine,
} from './core/pdfAnalyze.ts';
import { getFile, putFile } from './idb.ts';
import { flat, newId, type ImportDefaults, type OrderPosition, type Preview } from './order.ts';

type PdfLib = PdfJsLike & { GlobalWorkerOptions: { workerSrc: string } };
let lib: Promise<PdfLib> | null = null;

export function pdfjs(): Promise<PdfLib> {
  if (!lib) {
    lib = (async () => {
      const m = (await import('pdfjs-dist')) as unknown as PdfLib;
      const worker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
      m.GlobalWorkerOptions.workerSrc = worker;
      return m;
    })();
  }
  return lib;
}

const PT = 25.4 / 72;

export interface PdfImportResult {
  positions: OrderPosition[];
  qty: QtyLine[];
  notes: string[];
}

/** Ключ обозначения для сопоставления DXF, PDF и заявки */
export const desigKey = (name: string) => keyDesig(findDesignation(name) ?? name);

function previewOf(g: ReturnType<typeof buildGeometry>): Preview {
  const tol = Math.max(0.05, Math.hypot(g.width, g.height) / 2500);
  return {
    outer: [flat(g.outer, tol, true)],
    holes: g.holes.map((h) => flat(h, tol, true)),
    bends: g.bends.map((l) => flat(l, 0, false)),
    ignored: [],
    bbox: [0, 0, g.width, g.height],
  };
}

/** Геометрия позиции из распознанного PDF */
export function geometryPatch(meta: PdfMeta, prev?: OrderPosition): Partial<OrderPosition> {
  const g = buildGeometry(meta);
  const bendsDetected = g.bends.length;
  // число гибов меняем, только если пользователь его не правил
  const keepBends = prev && prev.bends !== prev.detectedBends;
  return {
    geom: { width: g.width, height: g.height, netArea: g.netArea, bboxArea: g.bboxArea, cutLength: g.cutLength, pierces: g.pierces, count: 1 },
    preview: previewOf(g),
    bends: keepBends ? prev!.bends : bendsDetected,
    detectedBends: bendsDetected,
    bendLength: bendsDetected ? Math.round(g.bendMax) : Math.round(Math.max(g.width, g.height)),
  };
}

export interface PdfCheck {
  calc: number; // масса по контуру, кг
  drawing: number | null; // масса по чертежу (штамп или таблица)
  ratio: number | null;
  status: 'ok' | 'warn' | 'bad' | 'unknown';
  densityNote: string;
}

/** Сверка массы по контуру с массой на чертеже — главный признак, что вид и масштаб верны */
export function pdfCheck(p: OrderPosition): PdfCheck | null {
  if (!p.pdf) return null;
  const meta = p.pdf.meta;
  const mat = getMaterial(p.materialId);
  const area = p.geom.netArea / 1e6;
  const variants = [
    { m: area * kgPerM2(mat, p.thickness), note: '' },
    { m: area * ((mat.density * p.thickness) / 1000), note: 'без рифления' },
    { m: area * 7.85 * p.thickness, note: 'в чертеже масса посчитана как для стали' },
  ];
  const row = meta.table && meta.row >= 0 ? meta.table.rows[meta.row] : null;
  const drawing = row?.values.mass ?? meta.title.mass ?? null;
  if (!drawing || !area) return { calc: variants[0].m, drawing: null, ratio: null, status: 'unknown', densityNote: '' };
  let best = variants[0];
  for (const v of variants) if (Math.abs(Math.log(v.m / drawing)) < Math.abs(Math.log(best.m / drawing))) best = v;
  const ratio = best.m / drawing;
  const dev = Math.abs(ratio - 1);
  return { calc: variants[0].m, drawing, ratio, status: dev <= 0.06 ? 'ok' : dev <= 0.15 ? 'warn' : 'bad', densityNote: best === variants[0] ? '' : best.note };
}

function scanPosition(file: File, fileKey: string, defs: ImportDefaults, pages: number): OrderPosition {
  const pn = parseFileName(file.name);
  return {
    id: newId(),
    name: pn.name,
    fileName: file.name,
    materialId: pn.materialId ?? defs.materialId,
    thickness: pn.thickness ?? defs.thickness,
    qty: pn.qty ?? 1,
    geom: { width: 0, height: 0, netArea: 0, bboxArea: 0, cutLength: 0, pierces: 0, count: 1 },
    bends: 0,
    bendLength: 0,
    extras: [],
    warnings: ['PDF — скан (картинка): размеры не распознать. Откройте позицию и задайте габарит вручную'],
    guessed: { material: !pn.materialId, thickness: !pn.thickness, qty: !pn.qty },
    detectedBends: 0,
    source: 'pdf',
    pdf: {
      meta: {
        fileName: file.name,
        page: 0,
        pages,
        scale: 1,
        scaleWhy: 'скан',
        title: { massInTable: false },
        table: null,
        row: -1,
        axes: {},
        base: { outer: [], holes: [], bends: [], bbox: { minX: 0, minY: 0, maxX: 0, maxY: 0 } },
      },
      fileKey,
      geometryFromPdf: false,
      notes: [],
    },
  };
}

export async function importPdf(file: File, defs: ImportDefaults): Promise<PdfImportResult> {
  const buf = await file.arrayBuffer();
  const fileKey = `pdf:${file.name}:${file.size}:${file.lastModified}`;
  const pages = await readPdf(await pdfjs(), buf);
  await putFile(fileKey, buf);
  const pn = parseFileName(file.name);
  const fileDesig = findDesignation(pn.name) ?? undefined;
  const groups = groupDrawings(pages);
  const notes: string[] = [];
  const positions: OrderPosition[] = [];
  const listPages: PdfPageData[] = []; // листы без чертежа — заявка, спецификация, счёт
  let prevTitle: { materialId?: string; thickness?: number; materialText?: string } = {};

  for (const g of groups) {
    // одно обозначение на файл — берём из имени (там бывает номер исполнения), иначе из штампа
    const desig = groups.length === 1 ? (fileDesig ?? g.designation) : (g.designation ?? fileDesig);
    const an = analyzePdf(g.pages, file.name, desig);
    if (!an.meta) {
      if (an.scan) positions.push(scanPosition(file, fileKey, defs, pages.length));
      else listPages.push(...g.pages);
      continue;
    }
    const meta = an.meta;
    // продолжение чертежа (лист 2, зеркальное исполнение) — материал как на первом листе
    if (!meta.title.thickness && prevTitle.thickness) meta.title.thickness = prevTitle.thickness;
    if (!meta.title.materialId && prevTitle.materialId) {
      meta.title.materialId = prevTitle.materialId;
      meta.title.materialText = prevTitle.materialText;
    }
    prevTitle = meta.title;
    const T = meta.title;
    const name = desig ?? T.designation ?? pn.name;
    const warnings: string[] = [];
    if (/нет подтверждений/.test(meta.scaleWhy)) warnings.push('Масштаб вида не подтверждён размерами или массой — проверьте габарит');
    if (meta.base.brk && !meta.base.brk.target && !(meta.table && meta.row >= 0)) warnings.push('Вид с обрывом: настоящая длина не найдена — проверьте габарит');
    if (meta.table && meta.row < 0 && meta.table.rows.length) warnings.push('На чертеже таблица исполнений — выберите исполнение в карточке позиции');
    if (!T.thickness && !pn.thickness) warnings.push('Толщина не найдена в штампе');
    const base: OrderPosition = {
      id: newId(),
      name,
      fileName: file.name,
      materialId: T.materialId ?? pn.materialId ?? defs.materialId,
      thickness: T.thickness ?? pn.thickness ?? defs.thickness,
      qty: pn.qty ?? 1,
      geom: { width: 0, height: 0, netArea: 0, bboxArea: 0, cutLength: 0, pierces: 0, count: 1 },
      bends: 0,
      bendLength: 0,
      extras: [],
      warnings,
      guessed: { material: !T.materialId && !pn.materialId, thickness: !T.thickness && !pn.thickness, qty: !pn.qty },
      detectedBends: 0,
      source: 'pdf',
      pdf: { meta, fileKey, geometryFromPdf: true, notes: T.materialText ? [`материал в штампе: ${T.materialText}`] : [] },
    };
    positions.push({ ...base, ...geometryPatch(meta) });
  }
  const qty = readQtyList(listPages);
  if (listPages.length && !qty.length && !positions.length) notes.push(`${file.name}: чертежа и списка деталей не найдено`);
  return { positions, qty, notes };
}

// ---------- просмотр и ручная правка ----------

const docs = new Map<string, Promise<any>>();

async function openDoc(fileKey: string): Promise<any | null> {
  let d = docs.get(fileKey);
  if (!d) {
    d = (async () => {
      const buf = await getFile(fileKey);
      if (!buf) return null;
      const m = await pdfjs();
      return m.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
    })();
    docs.set(fileKey, d);
  }
  const doc = await d;
  if (!doc) docs.delete(fileKey);
  return doc;
}

/** Рисует страницу в canvas шириной cssWidth; возвращает размер листа в мм */
export async function renderPage(fileKey: string, pageIndex: number, canvas: HTMLCanvasElement, cssWidth: number): Promise<{ w: number; h: number } | null> {
  const doc = await openDoc(fileKey);
  if (!doc) return null;
  const page = await doc.getPage(pageIndex + 1);
  const vp1 = page.getViewport({ scale: 1 });
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const vp = page.getViewport({ scale: (cssWidth * dpr) / vp1.width });
  canvas.width = Math.round(vp.width);
  canvas.height = Math.round(vp.height);
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${(cssWidth * vp1.height) / vp1.width}px`;
  await page.render({ canvas, viewport: vp }).promise;
  return { w: vp1.width * PT, h: vp1.height * PT };
}

export interface Reanalysis {
  pages: PdfPageData[];
  an: PdfAnalysis;
}

const reCache = new Map<string, Promise<Reanalysis | null>>();

/** Повторный разбор файла — нужен, чтобы показать все найденные виды и выбрать другой */
export function reanalyze(p: OrderPosition): Promise<Reanalysis | null> {
  const key = `${p.pdf!.fileKey}|${p.name}`;
  let r = reCache.get(key);
  if (!r) {
    r = (async () => {
      const buf = await getFile(p.pdf!.fileKey);
      if (!buf) return null;
      const all = await readPdf(await pdfjs(), buf);
      const groups = groupDrawings(all);
      const g = groups.find((x) => x.pages.some((pg) => pg.index === p.pdf!.meta.page)) ?? groups[0];
      return { pages: g.pages, an: analyzePdf(g.pages, p.pdf!.meta.fileName, p.name) };
    })();
    reCache.set(key, r);
  }
  return r;
}

/** Новый вид и/или масштаб для позиции */
export function repick(re: Reanalysis, p: OrderPosition, candIndex: number, scale?: number): PdfMeta {
  const c = re.an.candidates[candIndex];
  const old = p.pdf!.meta;
  const pick = pickFor(c, re.pages, old.title, scale);
  return metaFor(re.pages, c, pick, old.fileName, old.title, old.table, old.row);
}

/** Контур вида на листе (мм листа) — для подсветки на картинке чертежа */
export function candidateOutline(re: Reanalysis, i: number): { page: number; pts: Vec[] } {
  const c = re.an.candidates[i];
  return { page: c.page, pts: c.part.outer.pts };
}
