// Импорт PDF-чертежей в браузере: pdf.js грузится только при первом PDF,
// исходный файл сохраняется в IndexedDB, чтобы чертёж можно было открыть позже.

import type { AiDocument } from './core/ai.ts';
import { documentTextFromPdf, drawingTextFromPdf } from './core/drawingText.ts';
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
import { getFile, hasFile, putFile } from './idb.ts';
import { flat, newId, type ImportDefaults, type OrderPosition, type Preview } from './order.ts';

type PdfLib = PdfJsLike & { GlobalWorkerOptions: { workerSrc: string } };
let lib: Promise<PdfLib> | null = null;

/** Файл модуля не загрузился: после выкладки новой версии в открытой вкладке старых файлов уже нет */
export const APP_UPDATED = 'Приложение обновилось — обновите страницу';
const RE_CHUNK = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i;
const errText = (e: unknown) => (typeof e === 'object' && e !== null ? String((e as { message?: unknown }).message ?? '') : String(e));

// Не загрузившийся модуль браузер по тому же адресу больше не запрашивает (помнит отказ до перезагрузки страницы):
// повтор — по тому же адресу с ?retry=…, адрес берётся из текста ошибки (Chrome, Firefox)
const failedUrl = new Map<string, string>();

async function loadModule<T>(id: string, load: () => Promise<T>): Promise<T> {
  const url = failedUrl.get(id);
  try {
    if (!url) return await load();
    const again = `${url}${url.includes('?') ? '&' : '?'}retry=${Date.now()}`;
    return (await import(/* @vite-ignore */ again)) as T;
  } catch (e) {
    const m = /dynamically imported module:?\s+(\S+)/i.exec(errText(e));
    if (!url && m) failedUrl.set(id, m[1]);
    throw e;
  }
}

export function pdfjs(): Promise<PdfLib> {
  if (!lib) {
    lib = (async () => {
      const m = (await loadModule('pdfjs', () => import('pdfjs-dist'))) as unknown as PdfLib;
      const worker = (await loadModule('worker', () => import('pdfjs-dist/build/pdf.worker.min.mjs?url'))).default;
      m.GlobalWorkerOptions.workerSrc = worker;
      return m;
    })().catch((e: unknown) => {
      lib = null; // отказ не запоминаем: следующий PDF попробует загрузить pdf.js снова
      throw RE_CHUNK.test(errText(e)) ? new Error(APP_UPDATED) : e;
    });
  }
  return lib;
}

/** Ошибка pdf.js → по-русски, для журнала: «файл.pdf: не PDF или файл повреждён» */
export function pdfErrorText(e: unknown): string {
  const name = typeof e === 'object' && e !== null ? String((e as { name?: unknown }).name ?? '') : '';
  const msg = errText(e);
  if (msg === APP_UPDATED || RE_CHUNK.test(msg)) return APP_UPDATED;
  if (/The PDF file is empty/i.test(msg)) return 'пустой файл';
  if (name === 'PasswordException') return 'PDF защищён паролем';
  if (name === 'InvalidPDFException' || /Invalid PDF structure/i.test(msg)) return 'не PDF или файл повреждён';
  return 'не удалось прочитать PDF';
}

const PT = 25.4 / 72;

export interface PdfImportResult {
  positions: OrderPosition[];
  qty: QtyLine[];
  notes: string[];
  documents: AiDocument[]; // текст листов без чертежа (заявка, спецификация, счёт)
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

const polyLength = (pts: Vec[]) => pts.reduce((a, p, i) => (i ? a + Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) : 0), 0);

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
    bendLengths: bendsDetected ? g.bends.map((l) => Math.round(polyLength(l))) : undefined,
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

function scanPosition(fileName: string, fileKey: string, defs: ImportDefaults, pages: number): OrderPosition {
  const pn = parseFileName(fileName);
  return {
    id: newId(),
    name: pn.name,
    fileName,
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
        fileName,
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

/** Ключ файла в IndexedDB */
export const pdfFileKey = (f: { name: string; size: number; lastModified: number }) => `pdf:${f.name}:${f.size}:${f.lastModified}`;

export async function importPdf(file: File, defs: ImportDefaults): Promise<PdfImportResult> {
  const buf = await file.arrayBuffer();
  const fileKey = pdfFileKey(file);
  let pages: PdfPageData[];
  try {
    pages = await readPdf(await pdfjs(), buf);
  } catch (e) {
    const text = pdfErrorText(e);
    if (text === 'не удалось прочитать PDF') console.warn(`pdf.js: ${file.name}:`, e);
    throw new Error(text);
  }
  const r = positionsFromPages(pages, file.name, fileKey, defs);
  // хранится только PDF с чертежами: листы без чертежа (счёт, заявка) — текстом в документах
  if (r.positions.length) await putFile(fileKey, buf);
  return r;
}

/** PDF позиции пропал из браузера (очищено хранилище, удалила другая вкладка) — записать тот же файл под её ключом.
 *  true — файла не было и он записан; файл на месте или хранилище недоступно — false */
export async function restorePdf(file: File, key: string): Promise<boolean> {
  if ((await hasFile(key)) !== false) return false;
  if (!(await putFile(key, await file.arrayBuffer()))) return false;
  forget(key);
  return true;
}

/** Позиции, строки заявки и документы из прочитанных страниц PDF (чистая часть импорта — работает и в Node) */
export function positionsFromPages(pages: PdfPageData[], fileName: string, fileKey: string, defs: ImportDefaults): PdfImportResult {
  const pn = parseFileName(fileName);
  const fileDesig = findDesignation(pn.name) ?? undefined;
  const groups = groupDrawings(pages);
  const notes: string[] = [];
  const positions: OrderPosition[] = [];
  const listPages: PdfPageData[] = []; // листы без чертежа — заявка, спецификация, счёт
  let prevTitle: { materialId?: string; thickness?: number; materialText?: string } = {};

  for (const g of groups) {
    // одно обозначение на файл — берём из имени (там бывает номер исполнения), иначе из штампа
    const desig = groups.length === 1 ? (fileDesig ?? g.designation) : (g.designation ?? fileDesig);
    const an = analyzePdf(g.pages, fileName, desig);
    if (!an.meta) {
      if (an.scan) {
        const scan = scanPosition(fileName, fileKey, defs, pages.length);
        const text = drawingTextFromPdf(g.pages);
        if (text) scan.drawingText = text;
        // скан: показываем ту страницу, с которой начинается чертёж
        scan.pdf!.meta.page = g.pages[0]?.index ?? 0;
        positions.push(scan);
      } else listPages.push(...g.pages);
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
      fileName,
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
      drawingText: drawingTextFromPdf(g.pages) || undefined,
    };
    positions.push({ ...base, ...geometryPatch(meta) });
  }
  const qty = readQtyList(listPages);
  const documents: AiDocument[] = [];
  const docText = listPages.length ? documentTextFromPdf(listPages) : '';
  if (docText) documents.push({ fileName, text: docText });
  if (listPages.length && !qty.length && !positions.length) notes.push(`${fileName}: чертежа и списка деталей не найдено${docText ? ' — текст передан в анализ как документ' : ''}`);
  return { positions, qty, notes, documents };
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
    // ошибку (pdf.js не загрузился) не запоминаем — следующий показ попробует снова
    d.catch(() => docs.get(fileKey) === d && docs.delete(fileKey));
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

/** Рисует страницу в canvas так, чтобы длинная сторона была maxSidePx (для изображений чертежей в ИИ) */
export async function renderPageFit(fileKey: string, pageIndex: number, canvas: HTMLCanvasElement, maxSidePx: number): Promise<{ w: number; h: number } | null> {
  const doc = await openDoc(fileKey);
  if (!doc) return null;
  const page = await doc.getPage(pageIndex + 1);
  const vp1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: maxSidePx / Math.max(vp1.width, vp1.height) });
  canvas.width = Math.round(vp.width);
  canvas.height = Math.round(vp.height);
  await page.render({ canvas, viewport: vp, background: '#ffffff' }).promise;
  page.cleanup?.();
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
    const job = (async () => {
      const buf = await getFile(p.pdf!.fileKey);
      if (!buf) return null;
      const all = await readPdf(await pdfjs(), buf);
      const groups = groupDrawings(all);
      const g = groups.find((x) => x.pages.some((pg) => pg.index === p.pdf!.meta.page)) ?? groups[0];
      return { pages: g.pages, an: analyzePdf(g.pages, p.pdf!.meta.fileName, p.name) };
    })();
    r = job;
    reCache.set(key, job);
    // нет файла или ошибка — не запоминаем: файл могут вернуть (перетащить ещё раз), pdf.js — загрузиться
    job.then(
      (v) => v === null && reCache.get(key) === job && reCache.delete(key),
      () => reCache.get(key) === job && reCache.delete(key),
    );
  }
  return r;
}

/** Файл записан заново — забыть прочитанное из него раньше */
function forget(fileKey: string): void {
  docs.delete(fileKey);
  for (const k of reCache.keys()) if (k.startsWith(`${fileKey}|`)) reCache.delete(k);
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
