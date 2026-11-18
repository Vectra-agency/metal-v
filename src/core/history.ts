// История заказов — общая для всех пользователей, хранится на сервере (data/history.json).
// Заказ сохраняется с деталями (всё, что нужно для пересчёта по текущим расценкам) и нашим расчётом;
// к нему можно приложить счёт цеха — тогда у деталей есть факт: сколько цех взял на самом деле.
// По истории ищем ту же деталь (по обозначению) и похожие (материал, толщина, габарит, рез, гибы).
// Модуль общий для src/ и server/*.ts — только типы и чистые функции, без браузера и Node.

import { findDesignation, keyDesig } from './pdfAnalyze.ts';
import type { PartGeometry } from './pricing.ts';

export const HISTORY_VERSION = 1;

export const HISTORY_LIMITS = {
  orders: 5000, // заказов в истории
  parts: 400, // деталей в заказе
  invoiceLines: 300,
  bodyBytes: 900_000, // тело PUT/POST (nginx пускает до 1 МБ)
  matchParts: 400, // деталей в одном поиске
  same: 5, // той же детали — последних заказов
  similar: 3, // похожих деталей
};

/** Наш расчёт 1 шт на момент сохранения: себестоимость с НДС, ₽ */
export interface HistoryCalc {
  material: number;
  cut: number; // резка с врезками
  bend: number;
  extras: number;
  total: number;
}

/** Эскиз детали: контуры плоскими массивами x0,y0,x1,y1… в мм (как Preview приложения, без рамок и обрывков) */
export interface HistoryPreview {
  outer: number[][];
  holes: number[][];
  bends: number[][];
  bbox: [number, number, number, number];
}

/** Чисел в эскизе одной детали — не больше (≈ 2–8 КБ JSON); сложнее — эскиз не сохраняется */
export const PREVIEW_MAX_NUMBERS = 1600;

/** Деталь в истории: входные данные расчёта (как Position, без PDF) и результат */
export interface HistoryPart {
  id: string;
  name: string;
  fileName?: string;
  materialId: string;
  thickness: number;
  qty: number;
  disabled?: boolean;
  geom: PartGeometry;
  bends: number;
  bendLength: number;
  bendLengths?: number[];
  extras: { label: string; perPiece: number }[];
  note?: string;
  massKg: number;
  preview?: HistoryPreview; // упрощённый эскиз (для повторного открытия заказа)
  calc: HistoryCalc | null; // null — позиция исключена или без размеров
  price: number | null; // цена клиенту за 1 шт (с наценкой)
}

/** Строка счёта цеха и детали заказа, к которым она относится */
export interface InvoiceLine {
  n: number;
  text: string;
  qty: number;
  unit: string;
  price: number;
  sum: number;
  partIds: string[]; // пусто — к расчёту не относится (металл клиента, доставка, листы на склад)
}

export interface HistoryInvoice {
  supplier: string; // цех: «ООО "ЛАЗЕРНАЯ РЕЗКА СПБ"»
  number: string;
  date: string | null; // дата счёта YYYY-MM-DD
  total: number; // всего к оплате, ₽
  fileName: string;
  addedAt: string; // ISO
  lines: InvoiceLine[];
}

export interface HistoryTotals {
  cost: number; // себестоимость заказа
  total: number; // цена клиенту
  material: number;
  cutting: number;
  bending: number;
  extras: number;
  pieces: number;
  kg: number;
}

export interface HistoryOrder {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  markupPct: number;
  delivery: number;
  sheetChoice: Record<string, string>;
  priceOverride: Record<string, number>;
  request?: string;
  totals: HistoryTotals;
  parts: HistoryPart[];
  invoice: HistoryInvoice | null;
}

/** Строка списка истории */
export interface HistorySummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  parts: number; // деталей в расчёте
  names: string[]; // обозначения (для поиска по списку), до 40
  groups: string[]; // «Ст3 2 мм» — материал и толщина
  pieces: number;
  cost: number;
  total: number;
  invoice: null | {
    supplier: string;
    number: string;
    date: string | null;
    total: number;
    fact: number; // строки счёта, отнесённые к деталям
    calc: number; // наш расчёт тех же деталей
    unmatched: number; // строк счёта не отнесено
  };
}

// ---------- факт по счёту ----------

export interface PartFact {
  piece: number; // ₽ за 1 шт по счёту
  shared: boolean; // строка счёта на несколько деталей — доля по нашему расчёту
}

/** Строка счёта в штуках («5 шт», «10 ед.») — цена штуки из счёта; «1 компл» — на всё количество детали */
const perPieceLine = (line: InvoiceLine) => line.qty > 0 && /^(шт|ед)/i.test(line.unit.trim());
const activeParts = (o: HistoryOrder) => o.parts.filter((p) => !p.disabled && p.qty > 0);

/** Сколько по нашему расчёту стоит то, что выставлено строкой счёта: деталь × количество в счёте или группа деталей.
 *  piece — себестоимость 1 шт (по умолчанию — расчёт при сохранении; для сверки — пересчёт по текущим расценкам) */
export function lineCalc(o: HistoryOrder, line: InvoiceLine, piece: (p: HistoryPart) => number | null = (p) => p.calc?.total ?? null): number | null {
  const parts = line.partIds.map((id) => o.parts.find((p) => p.id === id)).filter((p): p is HistoryPart => !!p && !p.disabled);
  const prices = parts.map(piece);
  if (!parts.length || prices.some((v) => v == null)) return null;
  if (parts.length === 1 && perPieceLine(line)) return prices[0]! * line.qty;
  return parts.reduce((a, p, i) => a + prices[i]! * p.qty, 0);
}

/** Факт по счёту на 1 шт для каждой детали, к которой отнесена строка счёта */
export function partFacts(o: HistoryOrder): Map<string, PartFact> {
  const out = new Map<string, PartFact>();
  if (!o.invoice) return out;
  const byId = new Map(activeParts(o).map((p) => [p.id, p]));
  const add = (id: string, piece: number, shared: boolean) => {
    const cur = out.get(id);
    out.set(id, cur ? { piece: cur.piece + piece, shared: cur.shared || shared } : { piece, shared });
  };
  for (const line of o.invoice.lines) {
    const parts = line.partIds.map((id) => byId.get(id)).filter((p): p is HistoryPart => !!p);
    if (!parts.length || !(line.sum > 0)) continue;
    if (parts.length === 1) {
      const p = parts[0];
      // «5 шт по 6 394» — цена штуки из счёта, даже если в расчёте было другое количество
      const piece = perPieceLine(line) ? line.sum / line.qty : line.sum / p.qty;
      add(p.id, piece, false);
      continue;
    }
    // строка на группу («Набор пластин из Ст3 толщиной 2 мм»): делим по нашему расчёту, без расчёта — по штукам
    const weights = parts.map((p) => (p.calc ? p.calc.total * p.qty : 0));
    const sumW = weights.reduce((a, b) => a + b, 0);
    const pieces = parts.reduce((a, p) => a + p.qty, 0);
    parts.forEach((p, i) => add(p.id, sumW > 0 ? (line.sum * weights[i]) / sumW / p.qty : line.sum / pieces, true));
  }
  return out;
}

/** Заказ пересохранили с другими деталями (файлы загрузили заново — у деталей новые id): строки счёта
 *  переходят на деталь с тем же обозначением (или тем же именем, материалом и толщиной), если она одна */
export function remapInvoice(inv: HistoryInvoice, prevParts: readonly HistoryPart[], parts: readonly HistoryPart[]): HistoryInvoice {
  const ids = new Set(parts.map((p) => p.id));
  const keyOf = (p: HistoryPart) => designationKey(p.name) ?? `${p.name}|${p.materialId}|${p.thickness}`;
  const byKey = new Map<string, string[]>();
  for (const p of parts) if (!p.disabled) byKey.set(keyOf(p), [...(byKey.get(keyOf(p)) ?? []), p.id]);
  const old = new Map(prevParts.map((p) => [p.id, p]));
  const lines = inv.lines.map((l) => {
    const next = l.partIds.flatMap((id) => {
      if (ids.has(id)) return [id];
      const was = old.get(id);
      const hit = was ? byKey.get(keyOf(was)) : undefined;
      return hit?.length === 1 ? hit : [];
    });
    return { ...l, partIds: [...new Set(next)] };
  });
  return { ...inv, lines };
}

/** Строки счёта, отнесённые к деталям: факт и наш расчёт тех же деталей */
export function invoiceTotals(o: HistoryOrder): { fact: number; calc: number; unmatched: number } {
  let fact = 0;
  let calc = 0;
  let unmatched = 0;
  for (const line of o.invoice?.lines ?? []) {
    const c = line.partIds.length ? lineCalc(o, line) : null;
    if (c == null) {
      unmatched++;
      continue;
    }
    fact += line.sum;
    calc += c;
  }
  return { fact, calc, unmatched };
}

const n1 = (v: number) => String(Math.round(v * 10) / 10).replace('.', ',');

export function summaryOf(o: HistoryOrder, materialShort: (id: string) => string = (id) => id): HistorySummary {
  const active = activeParts(o);
  const groups = [...new Set(active.map((p) => `${materialShort(p.materialId)} ${n1(p.thickness)} мм`))];
  return {
    id: o.id,
    title: o.title,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    parts: active.length,
    names: active.slice(0, 40).map((p) => p.name),
    groups,
    pieces: o.totals.pieces,
    cost: o.totals.cost,
    total: o.totals.total,
    invoice: o.invoice
      ? { supplier: o.invoice.supplier, number: o.invoice.number, date: o.invoice.date, total: o.invoice.total, ...invoiceTotals(o) }
      : null,
  };
}

// ---------- поиск той же детали и похожих ----------

/** Ключ обозначения для поиска той же детали; null — обозначения нет («Пластина 100×200», «Деталь 1») */
export function designationKey(name: string): string | null {
  const d = findDesignation(name);
  if (!d) return null;
  const k = keyDesig(d);
  return (k.match(/\d/g)?.length ?? 0) >= 3 && k.length >= 5 ? k : null;
}

/** Деталь текущего заказа, для которой ищем историю */
export interface MatchQuery {
  id: string;
  name: string;
  materialId: string;
  thickness: number;
  width: number; // габарит, мм
  height: number;
  cutM: number; // рез на 1 шт, м
  bends: number;
  qty: number;
}

export interface HistoryMatch {
  kind: 'same' | 'similar'; // same — то же обозначение; similar — похожая деталь с фактом по счёту
  orderId: string;
  orderTitle: string;
  date: string; // дата счёта, иначе сохранения заказа (ISO)
  supplier: string | null;
  invoiceNumber: string | null;
  name: string;
  materialId: string;
  thickness: number;
  qty: number;
  width: number;
  height: number;
  bends: number;
  calc: number | null; // наш расчёт 1 шт тогда, ₽
  fact: number | null; // по счёту цеха, ₽ за 1 шт
  factShared: boolean;
  score: number; // 0 — та же деталь; больше — дальше
}

const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-9);

/** Насколько деталь из истории похожа на искомую: null — не похожа */
export function similarity(q: MatchQuery, p: HistoryPart): number | null {
  if (p.materialId !== q.materialId || Math.abs(p.thickness - q.thickness) > 1e-6) return null;
  if (!(q.width > 0 && q.height > 0 && p.geom.width > 0 && p.geom.height > 0)) return null;
  const [qa, qb] = [Math.min(q.width, q.height), Math.max(q.width, q.height)];
  const [pa, pb] = [Math.min(p.geom.width, p.geom.height), Math.max(p.geom.width, p.geom.height)];
  const dw = rel(qa, pa);
  const dh = rel(qb, pb);
  const dc = rel(q.cutM, p.geom.cutLength / 1000);
  if (Math.max(dw, dh) > 0.3 || dc > 0.35) return null;
  if (q.bends > 0 !== p.bends > 0 || Math.abs(q.bends - p.bends) > 2) return null;
  return (dw + dh) / 2 + dc + 0.1 * Math.abs(q.bends - p.bends);
}

/** Та же деталь (по обозначению) и похожие с фактом по счёту — для каждой детали запроса */
export function findMatches(queries: MatchQuery[], orders: HistoryOrder[], exclude?: string): Record<string, HistoryMatch[]> {
  const out: Record<string, HistoryMatch[]> = {};
  const pool = orders.filter((o) => o.id !== exclude);
  const facts = new Map(pool.map((o) => [o.id, partFacts(o)]));
  const keys = new Map<HistoryPart, string | null>();
  const keyOf = (p: HistoryPart) => {
    if (!keys.has(p)) keys.set(p, designationKey(p.name));
    return keys.get(p)!;
  };
  for (const q of queries) {
    const key = designationKey(q.name);
    const same: HistoryMatch[] = [];
    const similar: HistoryMatch[] = [];
    for (const o of pool) {
      const f = facts.get(o.id)!;
      for (const p of o.parts) {
        if (p.disabled || !(p.qty > 0)) continue;
        const isSame = !!key && keyOf(p) === key;
        const fact = f.get(p.id) ?? null;
        const score = isSame ? 0 : fact ? similarity(q, p) : null;
        if (score == null) continue;
        const m: HistoryMatch = {
          kind: isSame ? 'same' : 'similar',
          orderId: o.id,
          orderTitle: o.title,
          date: o.invoice?.date ?? o.updatedAt,
          supplier: o.invoice?.supplier ?? null,
          invoiceNumber: o.invoice?.number ?? null,
          name: p.name,
          materialId: p.materialId,
          thickness: p.thickness,
          qty: p.qty,
          width: p.geom.width,
          height: p.geom.height,
          bends: p.bends,
          calc: p.calc?.total ?? null,
          fact: fact?.piece ?? null,
          factShared: fact?.shared ?? false,
          score,
        };
        (isSame ? same : similar).push(m);
      }
    }
    same.sort((a, b) => b.date.localeCompare(a.date) || Number(b.fact != null) - Number(a.fact != null));
    similar.sort((a, b) => a.score - b.score || b.date.localeCompare(a.date));
    const list = [...same.slice(0, HISTORY_LIMITS.same), ...similar.slice(0, HISTORY_LIMITS.similar)];
    if (list.length) out[q.id] = list;
  }
  return out;
}

/** Последнее «то же» с фактом по счёту, иначе последнее «то же» */
export function bestSame(ms: readonly HistoryMatch[] | undefined): HistoryMatch | null {
  const same = (ms ?? []).filter((m) => m.kind === 'same');
  return same.find((m) => m.fact != null) ?? same[0] ?? null;
}
