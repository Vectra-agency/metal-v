// Заказ приложения ↔ запись истории: что сохраняем (детали с расчётом), отпечаток для «изменён после
// сохранения», запросы поиска той же детали и заказ из истории для повторного открытия.
import { cyrb53, stableStringify } from '../ai/context.ts';
import { invoiceTotals, PREVIEW_MAX_NUMBERS, type HistoryOrder, type HistoryPart, type HistoryPreview, type MatchQuery } from '../core/history.ts';
import { computeOrder, type OrderResult, type PriceBook, type Settings } from '../core/pricing.ts';
import { emptyOrder, flat, orderSettings, type Order, type OrderPosition, type Preview } from '../order.ts';

/** id записи истории: случайный, без данных заказа */
export function newHistoryId(): string {
  const r = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().replace(/-/g, '') : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `h${r.slice(0, 23)}`;
}

/** Только то, что влияет на расчёт: правка названия детали в КП или примечания — тоже изменение (их видно в истории) */
const projection = (o: Order, positions: OrderPosition[]) => ({
  title: o.title.trim(),
  markupPct: o.markupPct,
  delivery: o.delivery,
  sheetChoice: o.sheetChoice,
  priceOverride: o.priceOverride,
  parts: positions.map((p) => [p.id, p.name, p.materialId, p.thickness, p.qty, !!p.disabled, p.geom, p.bends, p.bendLength, p.bendLengths ?? null, p.extras.map((e) => [e.label, e.perPiece]), p.note ?? '']),
});

/** Отпечаток заказа (по позициям с правками ИИ — как в расчёте) */
export function historyHash(o: Order, positions: OrderPosition[]): string {
  return cyrb53(stableStringify(projection(o, positions))).toString(36);
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** Эскиз для истории: грубее, чем в приложении (миниатюра, координаты до 0,5 мм); слишком сложный — без эскиза */
export function compactPreview(p: Preview | undefined): HistoryPreview | undefined {
  if (!p) return undefined;
  const [x0, y0, x1, y1] = p.bbox;
  const tol = Math.max(0.2, Math.hypot(x1 - x0, y1 - y0) / 400);
  const pts = (a: number[]) => Array.from({ length: a.length >> 1 }, (_, i) => ({ x: a[2 * i], y: a[2 * i + 1] }));
  const half = (a: number[]) => a.map((v) => Math.round(v * 2) / 2);
  const closed = (a: number[]) => half(flat(pts(a), tol, true));
  const out: HistoryPreview = {
    outer: p.outer.map(closed),
    holes: p.holes.map(closed),
    bends: p.bends.map((a) => half(flat(pts(a), tol, false))),
    bbox: [r2(x0), r2(y0), r2(x1), r2(y1)],
  };
  const n = [...out.outer, ...out.holes, ...out.bends].reduce((a, l) => a + l.length, 0);
  return n <= PREVIEW_MAX_NUMBERS ? out : undefined;
}

/** Запись истории из заказа: позиции — как в расчёте (с принятыми правками ИИ), расчёт — на сейчас */
export function historyOrderFrom(o: Order, positions: OrderPosition[], res: OrderResult, id: string): HistoryOrder {
  const now = new Date().toISOString();
  const parts: HistoryPart[] = positions.map((p) => {
    const r = res.positions.get(p.id);
    const part: HistoryPart = {
      id: p.id,
      name: p.name,
      materialId: p.materialId,
      thickness: p.thickness,
      qty: p.qty,
      geom: { ...p.geom },
      bends: p.bends,
      bendLength: p.bendLength,
      extras: p.extras.map((e) => ({ label: e.label, perPiece: e.perPiece })),
      massKg: r ? r2(r.netKg) : 0,
      ...(p.preview ? { preview: compactPreview(p.preview) } : {}),
      calc: r && !p.disabled ? { material: r2(r.piece.material), cut: r2(r.piece.cut + r.piece.pierce), bend: r2(r.piece.bend), extras: r2(r.piece.extras), total: r2(r.piece.total) } : null,
      price: r && !p.disabled ? r2(r.price.piece) : null,
    };
    if (p.fileName) part.fileName = p.fileName;
    if (p.note) part.note = p.note;
    if (p.disabled) part.disabled = true;
    if (p.bendLengths?.length) part.bendLengths = p.bendLengths.slice();
    return part;
  });
  const t = res.totals;
  return {
    id,
    title: o.title.trim(),
    createdAt: now,
    updatedAt: now,
    markupPct: o.markupPct,
    delivery: o.delivery,
    sheetChoice: { ...o.sheetChoice },
    priceOverride: { ...o.priceOverride },
    ...(o.request?.trim() ? { request: o.request.slice(0, 8000) } : {}),
    totals: { cost: r2(t.cost), total: r2(t.total), material: r2(t.material), cutting: r2(t.cutting), bending: r2(t.bending), extras: r2(t.extras), pieces: t.pieces, kg: r2(t.kg) },
    parts,
    invoice: null,
  };
}

/** Запросы поиска истории по позициям расчёта (исключённые и без размеров не ищем) */
export function matchQueries(positions: OrderPosition[], res: OrderResult): MatchQuery[] {
  return positions
    .filter((p) => !p.disabled && p.qty > 0 && p.geom.width > 0)
    .map((p) => ({
      id: p.id,
      name: p.name,
      materialId: p.materialId,
      thickness: p.thickness,
      width: Math.round(p.geom.width),
      height: Math.round(p.geom.height),
      cutM: Math.round((res.positions.get(p.id)?.cutM ?? p.geom.cutLength / 1000) * 100) / 100,
      bends: p.bends,
      qty: p.qty,
    }));
}

/** Позиции заказа из деталей истории (эскиз — упрощённый, PDF нет). id — те же: на них ссылаются строки счёта цеха */
export function positionsFromHistory(h: HistoryOrder): OrderPosition[] {
  return h.parts.map((p) => ({
    id: p.id,
    name: p.name,
    ...(p.fileName ? { fileName: p.fileName } : {}),
    materialId: p.materialId,
    thickness: p.thickness,
    qty: p.qty,
    geom: { ...p.geom },
    bends: p.bends,
    bendLength: p.bendLength,
    ...(p.bendLengths?.length ? { bendLengths: p.bendLengths.slice() } : {}),
    extras: p.extras.map((e) => ({ ...e })),
    ...(p.preview ? { preview: { ...p.preview, ignored: [] } } : {}),
    ...(p.note ? { note: p.note } : {}),
    ...(p.disabled ? { disabled: true } : {}),
    warnings: [],
    guessed: { material: false, thickness: false, qty: false },
    detectedBends: p.bends,
  }));
}

/** Заказ из истории — для повторного открытия; связан с той же записью истории */
export function orderFromHistory(h: HistoryOrder): Order {
  const positions = positionsFromHistory(h);
  const o: Order = {
    ...emptyOrder(),
    title: h.title,
    positions,
    sheetChoice: { ...h.sheetChoice },
    priceOverride: { ...h.priceOverride },
    markupPct: h.markupPct,
    delivery: h.delivery,
    request: h.request ?? '',
  };
  o.history = {
    id: h.id,
    savedAt: h.updatedAt,
    hash: historyHash(o, positions),
    invoice: h.invoice ? { number: h.invoice.number, date: h.invoice.date, supplier: h.invoice.supplier, ...invoiceTotals(h) } : null,
  };
  return o;
}

/** Расчёт заказа из истории по текущим расценкам и ценам mc.ru: id позиции → себестоимость 1 шт */
export function recalcHistory(h: HistoryOrder, book: PriceBook, settings: Settings): Map<string, number> {
  const positions = h.parts.map((p) => ({ ...p, warnings: [], guessed: { material: false, thickness: false, qty: false }, detectedBends: p.bends }));
  const s = orderSettings({ ...emptyOrder(), sheetChoice: h.sheetChoice, priceOverride: h.priceOverride, markupPct: h.markupPct, delivery: h.delivery }, settings);
  const res = computeOrder(
    positions.filter((p) => p.geom.netArea > 0 && p.geom.cutLength > 0),
    book,
    s,
  );
  return new Map([...res.positions].map(([id, r]) => [id, r.piece.total]));
}
