// Состояние заказа: позиции, импорт DXF, сохранение в браузере.

import type { AiDocument, AiState } from './core/ai.ts';
import { dxfText } from './core/drawingText.ts';
import { parseDxf, type Vec } from './core/dxf.ts';
import { analyze, metricsOf, type Analysis } from './core/geometry.ts';
import { parseFileName, MATERIAL_BY_ID } from './core/materials.ts';
import { normalizeCutRows } from './core/cutPrice.ts';
import { DEFAULT_SETTINGS, type Position, type PriceBook, type Settings } from './core/pricing.ts';
import type { PdfMeta, QtyLine } from './core/pdfAnalyze.ts';

export interface Preview {
  outer: number[][]; // плоские массивы x0,y0,x1,y1…
  holes: number[][];
  bends: number[][];
  ignored: number[][]; // рамки/штампы и обрывки — не в расчёте
  bbox: [number, number, number, number];
}

/** Что известно о детали из PDF-чертежа */
export interface PdfInfo {
  meta: PdfMeta; // распознанный вид, масштаб, штамп, таблица исполнений
  fileKey: string; // ключ файла в IndexedDB (для показа чертежа)
  geometryFromPdf: boolean; // false — контур взят из DXF, PDF дал гибы/материал/массу
  notes: string[];
}

export interface OrderPosition extends Position {
  preview?: Preview;
  warnings: string[];
  guessed: { material: boolean; thickness: boolean; qty: boolean };
  detectedBends: number;
  source?: 'dxf' | 'pdf' | 'manual';
  pdf?: PdfInfo;
  drawingText?: string; // текст с чертежа для ИИ: технические требования, штамп, надписи (обрезан)
}

/** Запись журнала загрузки (что прочитано, пропущено, не распознано) */
export interface JournalEntry {
  at: string; // ISO
  level: 'info' | 'warn' | 'error';
  text: string;
}

/** Сколько записей журнала хранить (последние) */
export const JOURNAL_MAX = 200;

export interface Order {
  title: string;
  positions: OrderPosition[];
  sheetChoice: Record<string, string>;
  priceOverride: Record<string, number>;
  markupPct: number;
  delivery: number;
  v?: number; // версия формата: 2 — наценка по умолчанию 50 %
  request?: string; // текст заявки клиента, вставленный вручную
  documents?: AiDocument[]; // тексты без чертежа: .txt, листы PDF с заявкой/спецификацией
  requestLines?: QtyLine[]; // строки «обозначение — N шт» из заявок в PDF (для сверки в ИИ-анализе)
  ai?: AiState; // анализ ИИ и решения по его предложениям (поверх позиций, позиции не меняет)
  checks?: Record<string, string>; // id замечания (с отпечатком значения) → когда нажато «Верно», ISO
  aiScope?: string[]; // id позиций, которые видел последний применённый анализ ИИ (≤ 150)
  journal?: JournalEntry[]; // журнал загрузки, новые в конце, не больше JOURNAL_MAX
}

export const DEFAULT_MARKUP_PCT = 50;

export const emptyOrder = (): Order => ({
  title: '',
  positions: [],
  sheetChoice: {},
  priceOverride: {},
  markupPct: DEFAULT_MARKUP_PCT,
  delivery: 0,
  v: 2,
  request: '',
  documents: [],
  requestLines: [],
  checks: {},
  aiScope: [],
  journal: [],
});

/** Справочник цен до загрузки (и если загрузить не удалось): считаем по ценам материалов по умолчанию */
export const EMPTY_BOOK: PriceBook = { updatedAt: null, region: 'Санкт-Петербург', materials: {} };

/** Ключи PDF в IndexedDB, на которые ссылаются позиции заказа */
export function orderFileKeys(o: Order): Set<string> {
  const keys = new Set<string>();
  for (const p of o.positions) if (p.pdf?.fileKey) keys.add(p.pdf.fileKey);
  return keys;
}

/** Расценки с параметрами заказа (лист, цена вручную, наценка, доставка) — как их видит computeOrder */
export const orderSettings = (o: Order, s: Settings): Settings => ({
  ...s,
  sheetChoice: o.sheetChoice,
  priceOverride: o.priceOverride,
  markupPct: o.markupPct,
  delivery: o.delivery,
});

let seq = 0;
export const newId = () => `p${Date.now().toString(36)}${(seq++).toString(36)}`;

// ---------- упрощение контуров для превью ----------

function simplify(pts: Vec[], tol: number): Vec[] {
  if (pts.length <= 4) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const A = pts[a];
    const B = pts[b];
    const L = Math.hypot(B.x - A.x, B.y - A.y) || 1e-9;
    let worst = -1;
    let wd = tol;
    for (let i = a + 1; i < b; i++) {
      const P = pts[i];
      const d = Math.abs((B.x - A.x) * (A.y - P.y) - (A.x - P.x) * (B.y - A.y)) / L;
      if (d > wd) {
        wd = d;
        worst = i;
      }
    }
    if (worst > 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

export function flat(pts: Vec[], tol: number, closed: boolean): number[] {
  let s: Vec[];
  if (closed && pts.length > 3) {
    // замкнутый контур делим в самой дальней от начала точке, иначе упрощение вырождается
    let k = 1;
    let best = -1;
    pts.forEach((p, i) => {
      const d = (p.x - pts[0].x) ** 2 + (p.y - pts[0].y) ** 2;
      if (d > best) {
        best = d;
        k = i;
      }
    });
    s = [...simplify(pts.slice(0, k + 1), tol), ...simplify([...pts.slice(k), pts[0]], tol).slice(1)];
  } else s = simplify(pts, tol);
  const out: number[] = [];
  for (const p of s) out.push(Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10);
  return out;
}

export function makePreview(an: Analysis): Preview {
  const b = an.bbox;
  const tol = Math.max(0.05, Math.hypot(b.maxX - b.minX, b.maxY - b.minY) / 2500);
  return {
    outer: an.parts.map((p) => flat(p.outer.pts, tol, true)),
    holes: an.parts.flatMap((p) => p.holes.map((h) => flat(h.pts, tol, true))),
    bends: an.bends.map((o) => flat(o.pts, tol, false)),
    ignored: [...an.annotations.map((l) => flat(l.pts, tol * 4, true)), ...an.stray.map((o) => flat(o.pts, tol, false))],
    bbox: [b.minX, b.minY, b.maxX, b.maxY],
  };
}

// ---------- импорт ----------

export interface ImportDefaults {
  materialId: string;
  thickness: number;
}

export async function importDxf(file: File, defs: ImportDefaults): Promise<OrderPosition> {
  return positionFromDxf(await file.arrayBuffer(), file.name, defs);
}

/** Позиция из содержимого DXF (без File — для Node-скриптов) */
export function positionFromDxf(buf: ArrayBuffer, fileName: string, defs: ImportDefaults): OrderPosition {
  const dwg = parseDxf(buf);
  const an = analyze(dwg);
  const m = metricsOf(an.parts, an.bends);
  const pn = parseFileName(fileName);
  const warnings = [...dwg.warnings, ...an.warnings];
  if (m.count > 1) warnings.push(`В файле ${m.count} отдельных контура — считаются как один комплект на 1 шт.`);
  if (!dwg.insUnits && Math.max(m.width, m.height) < 20 && m.count) warnings.push('Очень мелкий габарит — проверьте единицы чертежа (мм?)');
  return {
    id: newId(),
    name: pn.name,
    fileName,
    materialId: pn.materialId ?? defs.materialId,
    thickness: pn.thickness ?? defs.thickness,
    qty: pn.qty ?? 1,
    geom: {
      width: m.width,
      height: m.height,
      netArea: m.netArea,
      bboxArea: m.bboxArea,
      cutLength: m.cutLength,
      pierces: m.pierces,
      count: m.count,
    },
    bends: m.bendCount,
    bendLength: m.bendCount ? Math.round(m.bendMaxLen) : Math.round(Math.max(m.width, m.height)),
    extras: [],
    preview: makePreview(an),
    warnings,
    guessed: { material: !pn.materialId, thickness: !pn.thickness, qty: !pn.qty },
    detectedBends: m.bendCount,
    source: 'dxf',
    drawingText: dxfText(dwg.labels ?? []) || undefined,
  };
}

/** Деталь без чертежа: прямоугольник с отверстиями */
export function manualPosition(o: {
  name: string;
  materialId: string;
  thickness: number;
  qty: number;
  width: number;
  height: number;
  holes: number;
  holeD: number;
  bends: number;
}): OrderPosition {
  const holeArea = o.holes * Math.PI * (o.holeD / 2) ** 2;
  const w = o.width;
  const h = o.height;
  const holesPreview: number[][] = [];
  for (let i = 0; i < o.holes; i++) {
    const cx = (w * (i + 1)) / (o.holes + 1);
    const cy = h / 2;
    const r = o.holeD / 2;
    const ring: number[] = [];
    for (let k = 0; k <= 24; k++) ring.push(cx + r * Math.cos((k / 24) * 2 * Math.PI), cy + r * Math.sin((k / 24) * 2 * Math.PI));
    holesPreview.push(ring);
  }
  return {
    id: newId(),
    name: o.name || `Пластина ${w}×${h}`,
    materialId: o.materialId,
    thickness: o.thickness,
    qty: o.qty,
    geom: {
      width: w,
      height: h,
      netArea: w * h - holeArea,
      bboxArea: w * h,
      cutLength: 2 * (w + h) + o.holes * Math.PI * o.holeD,
      pierces: 1 + o.holes,
      count: 1,
    },
    bends: o.bends,
    bendLength: Math.max(w, h),
    extras: [],
    preview: { outer: [[0, 0, w, 0, w, h, 0, h, 0, 0]], holes: holesPreview, bends: [], ignored: [], bbox: [0, 0, w, h] },
    warnings: [],
    guessed: { material: false, thickness: false, qty: false },
    detectedBends: 0,
    source: 'manual',
  };
}

/** Рекурсивно собирает файлы из перетаскивания (файлы и папки) */
export async function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  const out: File[] = [];
  const entries = [...dt.items].map((i) => (i.kind === 'file' ? i.webkitGetAsEntry?.() : null)).filter(Boolean) as FileSystemEntry[];
  if (!entries.length) return [...dt.files];
  const walk = async (e: FileSystemEntry): Promise<void> => {
    if (e.isFile) {
      out.push(await new Promise<File>((res, rej) => (e as FileSystemFileEntry).file(res, rej)));
    } else if (e.isDirectory) {
      const reader = (e as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const c of batch) await walk(c);
      }
    }
  };
  for (const e of entries) await walk(e);
  return out;
}

// ---------- хранение ----------

const K_ORDER = 'metalcalc.order.v1';
const K_SETTINGS = 'metalcalc.settings.v1';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown, def: number) => (typeof v === 'number' && Number.isFinite(v) ? v : def);

/** Позиция из хранилища: обязательные поля на месте, иначе позиция отбрасывается (null) */
function normalizePosition(raw: unknown): OrderPosition | null {
  if (!isObj(raw)) return null;
  const p = raw as unknown as OrderPosition;
  if (typeof p.id !== 'string' || !MATERIAL_BY_ID.has(p.materialId) || !isObj(p.geom)) return null;
  const g = isObj(p.guessed) ? p.guessed : null;
  return {
    ...p,
    name: typeof p.name === 'string' ? p.name : String(p.fileName ?? p.id),
    thickness: num(p.thickness, 2),
    qty: num(p.qty, 1),
    bends: num(p.bends, 0),
    bendLength: num(p.bendLength, 0),
    extras: Array.isArray(p.extras) ? p.extras.filter((e) => isObj(e) && typeof e.label === 'string') : [],
    warnings: Array.isArray(p.warnings) ? p.warnings.filter((w) => typeof w === 'string') : [],
    guessed: { material: !!g?.material, thickness: !!g?.thickness, qty: !!g?.qty },
    detectedBends: num(p.detectedBends, 0),
  };
}

const isLevel = (v: unknown): v is JournalEntry['level'] => v === 'info' || v === 'warn' || v === 'error';

/** Приводит сохранённый заказ (в т.ч. старого формата) к текущему: новые поля необязательны и проверяются */
export function normalizeOrder(raw: unknown): Order {
  const o = { ...(isObj(raw) ? (raw as unknown as Order) : emptyOrder()) };
  // раньше наценка по умолчанию была 0 % — в таких заказах ставим новую
  if (!o.v && !o.markupPct) o.markupPct = DEFAULT_MARKUP_PCT;
  o.markupPct = num(o.markupPct, DEFAULT_MARKUP_PCT);
  o.delivery = num(o.delivery, 0);
  if (typeof o.title !== 'string') o.title = '';
  if (!isObj(o.sheetChoice)) o.sheetChoice = {};
  if (!isObj(o.priceOverride)) o.priceOverride = {};
  o.positions = (Array.isArray(o.positions) ? o.positions : []).map(normalizePosition).filter((p): p is OrderPosition => !!p);
  o.documents = Array.isArray(o.documents) ? o.documents.filter((d) => d && typeof d.fileName === 'string' && typeof d.text === 'string') : [];
  o.requestLines = Array.isArray(o.requestLines) ? o.requestLines.filter((l) => l && typeof l.designation === 'string' && Number(l.qty) > 0) : [];
  if (typeof o.request !== 'string') o.request = '';
  const ai = o.ai;
  if (ai && !(ai.analysis && Array.isArray(ai.analysis.positions) && ai.accepted && typeof ai.accepted === 'object' && typeof ai.contextHash === 'string')) delete o.ai;
  o.checks = isObj(o.checks) ? Object.fromEntries(Object.entries(o.checks).filter(([, v]) => typeof v === 'string')) : {};
  o.aiScope = Array.isArray(o.aiScope) ? o.aiScope.filter((id) => typeof id === 'string') : [];
  o.journal = Array.isArray(o.journal)
    ? o.journal.filter((e) => isObj(e) && typeof e.at === 'string' && typeof e.text === 'string' && isLevel(e.level)).slice(-JOURNAL_MAX)
    : [];
  return { ...emptyOrder(), ...o };
}

export function loadOrder(): Order {
  try {
    const raw = localStorage.getItem(K_ORDER);
    if (raw) return normalizeOrder(JSON.parse(raw));
  } catch {
    /* нет доступа к хранилищу — начинаем с пустого */
  }
  return emptyOrder();
}

export function saveOrder(o: Order): string | null {
  try {
    localStorage.setItem(K_ORDER, JSON.stringify(o));
    return null;
  } catch {
    // не влезло — сохраняем без превью, потом и без текстов чертежей
    try {
      localStorage.setItem(K_ORDER, JSON.stringify({ ...o, positions: o.positions.map((p) => ({ ...p, preview: undefined })) }));
      return 'Заказ большой — эскизы деталей не сохранятся после перезагрузки';
    } catch {
      try {
        localStorage.setItem(K_ORDER, JSON.stringify({ ...o, documents: [], positions: o.positions.map((p) => ({ ...p, preview: undefined, drawingText: undefined })) }));
        return 'Заказ большой — эскизы и тексты чертежей не сохранятся после перезагрузки';
      } catch {
        return 'Не удалось сохранить заказ в браузере';
      }
    }
  }
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(K_SETTINGS);
    if (raw) {
      const s: Settings = { ...structuredClone(DEFAULT_SETTINGS), ...JSON.parse(raw) };
      // резка до прайса хранилась как ставка ₽/м + врезка — такие таблицы заменяются прайсом
      s.cutting = normalizeCutRows(s.cutting) ?? structuredClone(DEFAULT_SETTINGS.cutting);
      s.matK = Object.fromEntries(Object.entries(s.matK ?? {}).map(([id, k]) => [id, k?.bendK != null ? { bendK: k.bendK } : {}]));
      return s;
    }
  } catch {
    /* по умолчанию */
  }
  return structuredClone(DEFAULT_SETTINGS);
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(K_SETTINGS, JSON.stringify(s));
  } catch {
    /* игнор */
  }
}

// ---------- цены ----------

export async function fetchPrices(): Promise<{ book: PriceBook; live: boolean }> {
  try {
    const r = await fetch('/api/prices', { cache: 'no-store' });
    if (r.ok && (r.headers.get('content-type') ?? '').includes('json')) return { book: await r.json(), live: true };
  } catch {
    /* сервера нет — берём снимок */
  }
  const r = await fetch('./prices.json', { cache: 'no-store' });
  return { book: await r.json(), live: false };
}

/** Ошибка API цен; status 0 — нет ответа сервера (сеть, статическая версия) */
export class PriceApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'PriceApiError';
    this.status = status;
  }
}

export async function refreshPricesApi(pairs: [string, number][] | null, signal?: AbortSignal): Promise<{ book: PriceBook; errors: string[] }> {
  let r: Response;
  try {
    r = await fetch('/api/prices/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairs }),
      signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new PriceApiError('нет связи с сервером', 0);
  }
  const j = (await r.json().catch(() => null)) as { book?: PriceBook; errors?: string[]; error?: string } | null;
  if (!r.ok || !j?.book) throw new PriceApiError(j?.error ?? `Ошибка ${r.status}`, r.status);
  return { book: j.book, errors: Array.isArray(j.errors) ? j.errors : [] };
}
