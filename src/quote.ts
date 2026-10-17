// КП для клиента: цены за шт (округлённые), суммы, доставка, итог с НДС — одни и те же числа везде:
// KPI «Цена клиенту», таблица, текст для письма, TSV, CSV, печать (ui-spec §5.2, §7).
// Суммы считаются в целых копейках: итог = Σ (цена за шт × кол-во) + доставка, без накопления ошибок float.

import { MATERIAL_BY_ID } from './core/materials.ts';
import type { OrderResult, PriceBook, Settings } from './core/pricing.ts';
import { dateDay, NBSP, plural, rub0, rub2, thick } from './format.ts';
import type { Order, OrderPosition } from './order.ts';
import { pairFetchedAt } from './prices.ts';

export type PieceRounding = 'kop' | 'rub' | 'ten';

export interface QuoteSettings {
  rounding: PieceRounding; // цена за шт в КП: до копеек / до рубля / до 10 ₽
  showMaterial: boolean;
  showNotes: boolean;
  showSketch: boolean; // эскизы в печати и превью
  amountInWords: boolean; // сумма прописью (печать)
  validityDays: number; // 0 — строку не писать
  terms: string;
  header: string; // шапка КП (несколько строк)
  signature: string;
}

export const DEFAULT_QUOTE: QuoteSettings = {
  rounding: 'rub',
  showMaterial: true,
  showNotes: true,
  showSketch: true,
  amountInWords: true,
  validityDays: 5,
  terms: '',
  header: '',
  signature: '',
};

/** Подписи округления: переключатель «Цена за шт» и подсказка «Цены клиенту» */
export const ROUNDING_LABEL: Record<PieceRounding, string> = { kop: 'коп.', rub: '1 ₽', ten: '10 ₽' };
export const ROUNDING_HINT: Record<PieceRounding, string> = { kop: 'до копеек', rub: 'до рубля', ten: 'до 10 ₽' };

export interface QuoteLine {
  n: number;
  positionId: string;
  name: string;
  material: string; // «08пс холоднокатаный 2 мм» ('' если !showMaterial)
  qty: number;
  price: number | null; // цена за шт для клиента, округлённая; null — «цена уточняется»
  sum: number | null; // price × qty (в целых копейках)
  exactSum: number; // r.price.sum (или r.piece.total × k × qty при своей наценке)
  note: string;
}

export interface Quote {
  title: string;
  date: string; // «16.10.2026» (сегодня)
  lines: QuoteLine[]; // включённые позиции с qty > 0, по порядку
  linesById: Map<string, QuoteLine>;
  delivery: number; // доставка для клиента = доставка × (1 + наценка), округлена; 0 — строки нет
  total: number; // Σ сумм с ценой + доставка: «Цена клиенту» ВЕЗДЕ
  vat: number;
  vatPct: number;
  unpriced: number; // строк без цены (в итог не входят)
  exactTotal: number; // res.totals.total
  roundingDiff: number; // total − (Σ точных сумм строк с ценой + точная доставка)
  cost: number; // res.totals.cost — без позиций без размеров (только для внутренних экранов)
  revenue: number; // total − cost
  marginPct: number; // revenue / total × 100
  markupPct: number;
  metalDate: string | null; // самая старая дата цен mc.ru среди групп, иначе дата справочника → «16.10.2026»
  works: string; // «лазерная резка, гибка, доп. работы» — подзаголовок КП
  settings: QuoteSettings; // с какими настройками собрано (тексты и печать берут отсюда округление, сроки, условия)
}

/** Цена за шт по правилу округления */
export function roundPiece(v: number, r: PieceRounding): number {
  if (!Number.isFinite(v)) return 0;
  if (r === 'kop') return Math.round(v * 100) / 100;
  if (r === 'ten') return v >= 100 ? Math.round(v / 10) * 10 : Math.round(v);
  return Math.round(v);
}

/** «08пс холоднокатаный 2 мм»: название без пояснения в скобках + толщина */
export const materialText = (materialId: string, t: number): string => {
  const label = MATERIAL_BY_ID.get(materialId)?.label ?? materialId;
  return `${label.replace(/\s*\([^)]*\)/g, '').trim()} ${thick(t)}`;
};

/** Позиция без размеров (скан без габарита): цена не посчитана */
export const isUnpriced = (p: OrderPosition): boolean => !p.disabled && p.qty > 0 && (p.geom.netArea <= 0 || p.geom.cutLength <= 0);

/** Позиции для денежного расчёта: без размеров — как исключённые (их гибка и доп. работы не входят в себестоимость,
 *  пустые заготовки не попадают в раскрой). В КП такая строка остаётся — «цена уточняется». Нет таких — тот же массив. */
export function pricedPositions(ps: OrderPosition[]): OrderPosition[] {
  if (!ps.some(isUnpriced)) return ps;
  return ps.map((p) => (isUnpriced(p) ? { ...p, disabled: true } : p));
}

const toKop = (v: number) => Math.round(v * 100);

/** positions — позиции КП (с предложениями ИИ, вместе с позициями без размеров: «цена уточняется»);
 *  res — computeOrder(pricedPositions(positions)): себестоимость — только позиций с ценой */
export function buildQuote(i: {
  order: Order;
  positions: OrderPosition[];
  res: OrderResult;
  settings: Settings;
  quote: QuoteSettings;
  book: PriceBook;
  markupPct?: number; // своя наценка (сценарии); по умолчанию — наценка расчёта
  now?: Date;
}): Quote {
  const { order, positions, res, settings, quote: qs, book } = i;
  const m = i.markupPct ?? res.markupPct;
  const k = 1 + m / 100;
  const own = i.markupPct != null && i.markupPct !== res.markupPct;
  const lines: QuoteLine[] = [];
  let sumKop = 0;
  let exactPriced = 0;
  let unpriced = 0;
  for (const p of positions) {
    if (p.disabled || !(p.qty > 0)) continue;
    const r = res.positions.get(p.id);
    const exactSum = r ? (own ? r.piece.total * k * p.qty : r.price.sum) : 0;
    let price: number | null = null;
    let sum: number | null = null;
    if (r && !isUnpriced(p)) {
      price = roundPiece(own ? r.piece.total * k : r.price.piece, qs.rounding);
      const s = toKop(price) * p.qty;
      sum = s / 100;
      sumKop += s;
      exactPriced += exactSum;
    } else unpriced++;
    const splitNote = r?.split ? `из ${r.split.pieces} ${plural(r.split.pieces, 'части', 'частей', 'частей')}` : '';
    lines.push({
      n: lines.length + 1,
      positionId: p.id,
      name: p.name,
      material: qs.showMaterial ? materialText(p.materialId, p.thickness) : '',
      qty: p.qty,
      price,
      sum,
      exactSum,
      note: qs.showNotes ? p.note?.trim() || splitNote : '',
    });
  }
  const deliveryExact = order.delivery > 0 ? order.delivery * k : 0;
  const delivery = deliveryExact > 0 ? roundPiece(deliveryExact, qs.rounding) : 0;
  const totalKop = sumKop + toKop(delivery);
  const total = totalKop / 100;
  const vatPct = settings.vatPct;
  const vat = Math.round((totalKop * vatPct) / (100 + vatPct)) / 100;
  const cost = res.totals.cost;
  const revenue = total - cost;
  // самая старая дата цен среди групп (по ней — «Стоимость металла — на …»)
  let oldest: string | null = null;
  for (const g of res.groups) {
    const at = pairFetchedAt(book, g.material.id, g.t);
    if (at && (!oldest || Date.parse(at) < Date.parse(oldest))) oldest = at;
  }
  const metalAt = oldest ?? book.updatedAt;
  const works = ['лазерная резка', ...(res.totals.bending > 0 ? ['гибка'] : []), ...(res.totals.extras > 0 ? ['доп. работы'] : [])].join(', ');
  return {
    title: order.title.trim(),
    date: dateDay(i.now ?? new Date()),
    lines,
    linesById: new Map(lines.map((l) => [l.positionId, l])),
    delivery,
    total,
    vat,
    vatPct,
    unpriced,
    exactTotal: own ? res.totals.cost * k : res.totals.total,
    roundingDiff: total - (exactPriced + deliveryExact),
    cost,
    revenue,
    marginPct: total ? (revenue / total) * 100 : 0,
    markupPct: m,
    metalDate: metalAt ? dateDay(metalAt) : null,
    works,
    settings: qs,
  };
}

// ---------- тексты для клиента (ui-spec §7.2) ----------

/** Деньги для клиента по правилу округления: «коп.» — с копейками, иначе целые рубли */
export const clientMoney = (q: Quote, v: number): string => (q.settings.rounding === 'kop' ? rub2(v) : rub0(v));

/** «5 рабочих дней» / «1 рабочий день» / «3 рабочих дня» */
export const workDays = (n: number): string => `${n}${NBSP}${plural(n, 'рабочий день', 'рабочих дня', 'рабочих дней')}`;

/** «Позиции с пометкой…» — одна фраза для текста, печати и превью */
export const UNPRICED_NOTE = 'Позиции с пометкой «цена уточняется» в итог не входят.';
export const UNPRICED_WORD = 'цена уточняется';

/** «Цены с НДС 22 %, действительны 5 рабочих дней. Стоимость металла — на 16.10.2026.» */
export function validityLine(q: Quote): string {
  const days = Math.max(0, Math.round(q.settings.validityDays || 0));
  const metal = q.metalDate ? ` Стоимость металла — на ${q.metalDate}.` : '';
  return `Цены с НДС ${q.vatPct}${NBSP}%${days > 0 ? `, действительны ${workDays(days)}` : ''}.${metal}`;
}

/** «Скопировать для клиента»: обычный текст для письма, без внутренних цифр */
export function quoteText(q: Quote, o: { questions?: string[] } = {}): string {
  const out = ['Расчёт стоимости изготовления деталей', q.title ? `${q.title} · ${q.date}` : q.date, ''];
  for (const l of q.lines) {
    const head = `${l.n}. ${l.name}${l.material ? ` — ${l.material}` : ''} — ${l.qty}${NBSP}шт`;
    if (l.price == null || l.sum == null) out.push(`${head} — ${UNPRICED_WORD}`);
    else out.push(`${head} × ${clientMoney(q, l.price)} = ${clientMoney(q, l.sum)}${l.note ? ` (${l.note})` : ''}`);
  }
  if (q.delivery > 0) out.push(`Доставка — ${clientMoney(q, q.delivery)}`);
  out.push('', `Итого: ${clientMoney(q, q.total)}, в т.ч. НДС ${q.vatPct}${NBSP}% — ${rub2(q.vat)}`);
  if (q.unpriced) out.push(UNPRICED_NOTE);
  out.push(validityLine(q));
  const terms = q.settings.terms.trim();
  if (terms) out.push(terms);
  const questions = (o.questions ?? []).map((s) => s.trim()).filter(Boolean);
  if (questions.length) out.push('', 'Просим уточнить:', ...questions.map((s, i) => `${i + 1}. ${s}`));
  return out.join('\n');
}

/** Число для таблиц Excel: десятичная запятая, без разделителей разрядов */
const plain = (v: number, d: number) => (d ? v.toFixed(d) : String(Math.round(v))).replace('.', ',');
/** В ячейку TSV/CSV — без табуляций и переводов строк */
const flat = (s: string) => s.replace(/[\t\r\n]+/g, ' ').trim();

/** Строки таблицы для клиента: одни и те же для TSV и CSV */
export function clientRows(q: Quote): string[][] {
  const d = q.settings.rounding === 'kop' ? 2 : 0;
  const mat = q.settings.showMaterial;
  const row = (n: string, name: string, material: string, qty: string, unit: string, price: string, sum: string) =>
    mat ? [n, name, material, qty, unit, price, sum] : [n, name, qty, unit, price, sum];
  const rows = [row('№', 'Наименование', 'Материал', 'Кол-во', 'Ед.', 'Цена, ₽', 'Сумма, ₽')];
  for (const l of q.lines) {
    const priced = l.price != null && l.sum != null;
    const price = priced ? plain(l.price!, d) : UNPRICED_WORD;
    rows.push(row(String(l.n), flat(l.name), flat(l.material), String(l.qty), 'шт', price, priced ? plain(l.sum!, d) : ''));
  }
  if (q.delivery > 0) rows.push(row('', 'Доставка', '', '', '', '', plain(q.delivery, d)));
  rows.push(row('', 'Итого', '', '', '', '', plain(q.total, d)));
  rows.push(row('', `в т.ч. НДС ${q.vatPct} %`, '', '', '', '', plain(q.vat, 2)));
  return rows;
}

/** «Скопировать таблицей» (TSV для Excel): табуляции, \n, десятичная запятая */
export function quoteTsv(q: Quote): string {
  return clientRows(q)
    .map((r) => r.join('\t'))
    .join('\n');
}

const csvCell = (s: string) => (/[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** «Excel для клиента»: те же строки, «;», BOM (кириллица в Excel), CRLF */
export function quoteCsv(q: Quote): string {
  return (
    '\uFEFF' +
    clientRows(q)
      .map((r) => r.map(csvCell).join(';'))
      .join('\r\n')
  );
}

/** Имя файла без запрещённых символов */
export const safeFileName = (s: string): string => s.replace(/[\\/:*?"<>|]/g, '_').trim();
