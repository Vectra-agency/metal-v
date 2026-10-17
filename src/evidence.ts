// Проверка цитат ИИ: дословные фрагменты в «ёлочках» из комментариев и причин ищутся в текстах, которые
// видел ИИ (чертежи, заявка, документы). Найдено — ✓ с указанием, где; нет — «?» (могла быть прочитана с изображения).
import type { AiContext, AiDocument } from './core/ai.ts';
import type { Evidence } from './attention.ts';
import type { Order } from './order.ts';

export interface EvidenceSources {
  drawings: { positionId: string; name: string; text: string }[];
  request: string;
  documents: AiDocument[];
}

const SAME_TEXT = /^Текст чертежа тот же, что у позиции «(.+)»$/;

function build(order: Order, ctx: AiContext | null): EvidenceSources {
  if (ctx) {
    // ровно то, что ушло модели; «тот же текст, что у …» — текст той позиции
    const byName = new Map<string, string>();
    for (const p of ctx.positions) if (p.drawingText && !SAME_TEXT.test(p.drawingText) && !byName.has(p.name)) byName.set(p.name, p.drawingText);
    const drawings = ctx.positions.flatMap((p) => {
      const m = p.drawingText ? SAME_TEXT.exec(p.drawingText) : null;
      const text = m ? (byName.get(m[1]) ?? '') : (p.drawingText ?? '');
      return text ? [{ positionId: p.id, name: p.name, text }] : [];
    });
    return { drawings, request: ctx.order.request ?? '', documents: ctx.documents ?? [] };
  }
  return {
    drawings: order.positions.flatMap((p) => (p.drawingText ? [{ positionId: p.id, name: p.name, text: p.drawingText }] : [])),
    request: order.request ?? '',
    documents: order.documents ?? [],
  };
}

let last: { positions: unknown; request: unknown; documents: unknown; ctx: unknown; v: EvidenceSources } | null = null;

/** Тексты для сверки цитат: из контекста анализа (что именно ушло модели), иначе — из заказа.
 *  Тот же объект при тех же входах (кэш нормализованных текстов держится на нём). */
export function evidenceSources(order: Order, ctx: AiContext | null): EvidenceSources {
  if (last && last.positions === order.positions && last.request === order.request && last.documents === order.documents && last.ctx === ctx) return last.v;
  const v = build(order, ctx);
  last = { positions: order.positions, request: order.request, documents: order.documents, ctx, v };
  return v;
}

// латиница, похожая на кириллицу (в обозначениях и марках встречается вперемешку)
const LAT_UP: Record<string, string> = { A: 'А', B: 'В', E: 'Е', K: 'К', M: 'М', H: 'Н', O: 'О', P: 'Р', C: 'С', T: 'Т', X: 'Х' };
const LAT_LOW: Record<string, string> = { a: 'а', b: 'в', e: 'е', k: 'к', m: 'м', h: 'н', o: 'о', p: 'р', c: 'с', t: 'т', x: 'х', y: 'у' };

/** Нормализация для сравнения: регистр, ё→е, без кавычек, тире → «-», латиница-двойники → кириллица, пробелы */
export function normalize(s: string): string {
  return s
    .replace(/[ABEKMHOPCTX]/g, (ch) => LAT_UP[ch])
    .toLowerCase()
    .replace(/[abekmhopctxy]/g, (ch) => LAT_LOW[ch])
    .replace(/ё/g, 'е')
    .replace(/[«»"„“”'’]/g, '')
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface QuoteSpan {
  start: number; // индекс «
  end: number; // индекс после »
  inner: string;
}

/** Цитаты верхнего уровня «…» (вложенные «» — внутри цитаты) */
export function quoteSpans(text: string): QuoteSpan[] {
  const out: QuoteSpan[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '«') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '»' && depth > 0) {
      depth--;
      if (depth === 0) out.push({ start, end: i + 1, inner: text.slice(start + 1, i) });
    }
  }
  return out;
}

const MIN_QUOTE = 4;
const isQuote = (inner: string) => normalize(inner).length >= MIN_QUOTE;

/** Фрагменты «…» не короче 4 символов после нормализации */
export function extractQuotes(text: string): string[] {
  return quoteSpans(text)
    .map((q) => q.inner)
    .filter(isQuote);
}

interface NormSource {
  found: Evidence['found'];
  where?: string;
  positionId?: string;
  norm: string;
  tight: string; // без пробелов: «Сталь3» и «Сталь 3» — одно и то же
}

const cache = new WeakMap<EvidenceSources, NormSource[]>();

function normSources(src: EvidenceSources): NormSource[] {
  let v = cache.get(src);
  if (!v) {
    const mk = (found: Evidence['found'], text: string, where?: string, positionId?: string): NormSource => {
      const norm = normalize(text);
      return { found, where, positionId, norm, tight: norm.replace(/ /g, '') };
    };
    v = [
      ...src.drawings.map((d) => mk('drawing', d.text, d.name, d.positionId)),
      mk('request', src.request),
      ...src.documents.map((d) => mk('document', d.text, d.fileName)),
    ].filter((x) => x.norm);
    cache.set(src, v);
  }
  return v;
}

/** Все части цитаты (модель сокращает «…») есть в тексте по порядку */
function contains(hay: string, parts: string[]): boolean {
  let from = 0;
  for (const p of parts) {
    const i = hay.indexOf(p, from);
    if (i < 0) return false;
    from = i + p.length;
  }
  return true;
}

function partsOf(quote: string, tight: boolean): string[] {
  return normalize(quote)
    .split(/\s*(?:…|\.\.\.)\s*/)
    .map((x) => (tight ? x.replace(/ /g, '') : x))
    .filter((x) => x.length >= 3);
}

/** Где найдена цитата: свой чертёж → заявка → документы → другие чертежи */
export function checkQuote(quote: string, src: EvidenceSources, positionId?: string): Evidence {
  const all = normSources(src);
  const own = all.filter((s) => s.found === 'drawing' && s.positionId === positionId);
  const order = [
    ...own,
    ...all.filter((s) => s.found === 'request'),
    ...all.filter((s) => s.found === 'document'),
    ...all.filter((s) => s.found === 'drawing' && s.positionId !== positionId),
  ];
  const loose = partsOf(quote, false);
  const tight = partsOf(quote, true);
  if (!loose.length) return { quote, found: null };
  for (const s of order) {
    if (contains(s.norm, loose) || contains(s.tight, tight)) {
      if (s.found === 'drawing' && s.positionId === positionId) return { quote, found: 'drawing' };
      return s.where ? { quote, found: s.found, where: s.where } : { quote, found: s.found };
    }
  }
  return { quote, found: null };
}

/** Цитаты текста ИИ и где каждая найдена (в порядке появления) */
export function findEvidence(text: string, src: EvidenceSources, positionId?: string): Evidence[] {
  return extractQuotes(text).map((q) => checkQuote(q, src, positionId));
}

/** Подсказка к отметке цитаты */
export function evidenceHint(e: Evidence): string {
  switch (e.found) {
    case 'drawing':
      return e.where ? `Найдено в тексте чертежа «${e.where}»` : 'Найдено в тексте чертежа';
    case 'request':
      return 'Найдено в заявке';
    case 'document':
      return `Найдено в документе «${e.where ?? ''}»`;
    default:
      return 'Цитаты нет в текстах — проверьте по чертежу (могла быть прочитана с изображения)';
  }
}
