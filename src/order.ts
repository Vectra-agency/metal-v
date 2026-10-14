// Состояние заказа: позиции, импорт DXF, сохранение в браузере.

import { parseDxf, type Vec } from './core/dxf.ts';
import { analyze, metricsOf, type Analysis } from './core/geometry.ts';
import { parseFileName, MATERIAL_BY_ID } from './core/materials.ts';
import { DEFAULT_SETTINGS, type Position, type PriceBook, type Settings } from './core/pricing.ts';

export interface Preview {
  outer: number[][]; // плоские массивы x0,y0,x1,y1…
  holes: number[][];
  bends: number[][];
  ignored: number[][]; // рамки/штампы и обрывки — не в расчёте
  bbox: [number, number, number, number];
}

export interface OrderPosition extends Position {
  preview?: Preview;
  warnings: string[];
  guessed: { material: boolean; thickness: boolean; qty: boolean };
  detectedBends: number;
}

export interface Order {
  title: string;
  positions: OrderPosition[];
  sheetChoice: Record<string, string>;
  priceOverride: Record<string, number>;
  markupPct: number;
  delivery: number;
}

export const emptyOrder = (): Order => ({ title: '', positions: [], sheetChoice: {}, priceOverride: {}, markupPct: 0, delivery: 0 });

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

function flat(pts: Vec[], tol: number, closed: boolean): number[] {
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

function makePreview(an: Analysis): Preview {
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
  const buf = await file.arrayBuffer();
  const dwg = parseDxf(buf);
  const an = analyze(dwg);
  const m = metricsOf(an.parts, an.bends);
  const pn = parseFileName(file.name);
  const warnings = [...dwg.warnings, ...an.warnings];
  if (m.count > 1) warnings.push(`В файле ${m.count} отдельных контура — считаются как один комплект на 1 шт.`);
  if (!dwg.insUnits && Math.max(m.width, m.height) < 20 && m.count) warnings.push('Очень мелкий габарит — проверьте единицы чертежа (мм?)');
  return {
    id: newId(),
    name: pn.name,
    fileName: file.name,
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
  };
}

/** Рекурсивно собирает .dxf из перетаскивания (файлы и папки) */
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

export function loadOrder(): Order {
  try {
    const raw = localStorage.getItem(K_ORDER);
    if (raw) {
      const o = JSON.parse(raw) as Order;
      o.positions = o.positions.filter((p) => MATERIAL_BY_ID.has(p.materialId));
      return { ...emptyOrder(), ...o };
    }
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
    // не влезло — сохраняем без превью
    try {
      localStorage.setItem(K_ORDER, JSON.stringify({ ...o, positions: o.positions.map((p) => ({ ...p, preview: undefined })) }));
      return 'Заказ большой — эскизы деталей не сохранятся после перезагрузки';
    } catch {
      return 'Не удалось сохранить заказ в браузере';
    }
  }
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(K_SETTINGS);
    if (raw) return { ...structuredClone(DEFAULT_SETTINGS), ...JSON.parse(raw) };
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

export async function refreshPricesApi(pairs: [string, number][] | null): Promise<{ book: PriceBook; errors: string[] }> {
  const r = await fetch('/api/prices/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pairs }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? `Ошибка ${r.status}`);
  return j;
}
