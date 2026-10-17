// Модель строки таблицы позиций (ui-spec §3.6): всё, что нужно строке, одним объектом — строка (memo) сравнивает
// поля по ссылкам. Значения полей (материал, кол-во…) берутся из текущего состояния, деньги и замечания — из
// производных данных (они могут на кадр отставать: идёт пересчёт).
import { changesFor, effectivePositions, pendingOffers, type AiChange } from '@/ai/apply.ts';
import type { AttentionItem, AttentionKind } from '@/attention.ts';
import type { AiPositionReview, AiState, AiSuggestion } from '@/core/ai.ts';
import type { PosResult } from '@/core/pricing.ts';
import type { Order, OrderPosition } from '@/order.ts';
import type { QuoteLine } from '@/quote.ts';
import type { Derived } from '@/store/derived.tsx';
import { memo2 } from '@/store/memo.ts';
import type { AppState, SortKey, TableFilter, UiState } from '@/store/types.ts';

export interface RowModel {
  index: number; // № в заказе (с 1, порядок order.positions)
  base: OrderPosition; // order.positions[i] — сюда пишут правки
  pos: OrderPosition; // с предложениями ИИ — что показывается
  r: PosResult | undefined;
  line: QuoteLine | undefined; // цена и сумма клиенту (КП)
  review: AiPositionReview | undefined;
  changes: AiChange[]; // применённые изменения ИИ (значки, «было»)
  offers: AiSuggestion[]; // предложения ИИ, ждущие решения (чипы)
  items: AttentionItem[]; // открытые замечания (столбец «Проверка»)
  unpriced: boolean; // нет размеров — цена не посчитана
  isNew: boolean; // добавлена последним повторным разбором
  inScope: boolean; // позицию видел последний анализ ИИ
  warnings: string[]; // предупреждения разбора и расчёта, которых нет среди замечаний
}

const NONE: never[] = [];

// ---------- предупреждения, которые уже показаны замечаниями ----------

const COVERED: { re: RegExp; kind: AttentionKind }[] = [
  { re: /скан|контур|векторной геометрии/i, kind: 'nogeom' },
  { re: /Масштаб вида/i, kind: 'scale' },
  { re: /обрыв/i, kind: 'break' },
  { re: /таблица исполнений/i, kind: 'variant' },
  { re: /Не помещается на лист/i, kind: 'split' },
  { re: /Толщина не найдена/i, kind: 'guessed' },
];

/** Предупреждения позиции (разбор + расчёт), кроме тех, по которым есть замечание того же вида */
export function uncoveredWarnings(pos: OrderPosition, r: PosResult | undefined, kinds: ReadonlySet<AttentionKind> | undefined): string[] {
  const all = r?.warnings.length ? [...pos.warnings, ...r.warnings] : pos.warnings;
  if (!all.length) return NONE;
  const out = all.filter((w, i) => all.indexOf(w) === i && !COVERED.some((c) => c.re.test(w) && kinds?.has(c.kind)));
  return out.length ? out : NONE;
}

// ---------- вспомогательные индексы (кэш по ссылкам) ----------

/** Позиции с предложениями ИИ по текущему состоянию (без пересчёта цен — дёшево) */
export const livePositions = memo2((positions: OrderPosition[], ai: AiState | undefined) => effectivePositions(positions, ai));

const reviewsMemo = memo2((ai: AiState | undefined) => new Map((ai?.analysis.positions ?? []).map((r) => [r.id, r])));

const offersMemo = memo2((ai: AiState | undefined, positions: OrderPosition[]) => {
  const out = new Map<string, AiSuggestion[]>();
  for (const { positionId, s } of pendingOffers(ai, positions)) {
    const list = out.get(positionId);
    if (list) list.push(s);
    else out.set(positionId, [s]);
  }
  return out;
});

const kindsMemo = memo2((items: AttentionItem[]) => {
  const out = new Map<string, Set<AttentionKind>>();
  for (const i of items) {
    if (!i.positionId) continue;
    const set = out.get(i.positionId);
    if (set) set.add(i.kind);
    else out.set(i.positionId, new Set([i.kind]));
  }
  return out;
});

/** Позиции, которые видел анализ ИИ; null — все (старый заказ без aiScope) */
export function scopeOf(order: Order): Set<string> | null {
  if (!order.ai) return new Set();
  return order.aiScope?.length ? new Set(order.aiScope) : null;
}
const scopeMemo = memo2((ai: AiState | undefined, aiScope: string[] | undefined) => scopeOf({ ai, aiScope } as Order));

// изменения ИИ по позиции: тот же массив, пока не изменились позиция и решения (ячейки строки — memo)
const changesCache = new WeakMap<OrderPosition, { ai: AiState; ch: AiChange[] }>();
function changesOf(base: OrderPosition, ai: AiState | undefined): AiChange[] {
  if (!ai) return NONE;
  const c = changesCache.get(base);
  if (c && c.ai === ai) return c.ch;
  const ch = changesFor(base, ai);
  const v = ch.length ? ch : NONE;
  changesCache.set(base, { ai, ch: v });
  return v;
}

export const isUnpriced = (p: OrderPosition): boolean => !p.disabled && p.qty > 0 && (p.geom.netArea <= 0 || p.geom.cutLength <= 0);

// ---------- строки ----------

const rowsMemo = memo2(
  (order: Order, d: Pick<Derived, 'res' | 'quote' | 'attention'>, addedIds: string[]): RowModel[] => {
    const live = livePositions(order.positions, order.ai);
    const reviews = reviewsMemo(order.ai);
    const offers = offersMemo(order.ai, order.positions);
    const kinds = kindsMemo(d.attention.items);
    const scope = scopeMemo(order.ai, order.aiScope);
    const added = addedIds.length ? new Set(addedIds) : null;
    return order.positions.map((base, i): RowModel => {
      const pos = live[i] ?? base;
      const r = d.res.positions.get(base.id);
      const ch = changesOf(base, order.ai);
      return {
        index: i + 1,
        base,
        pos,
        r,
        line: d.quote.linesById.get(base.id),
        review: reviews.get(base.id),
        changes: ch,
        offers: offers.get(base.id) ?? NONE,
        items: d.attention.byPosition.get(base.id) ?? NONE,
        unpriced: isUnpriced(pos),
        isNew: !!added?.has(base.id),
        inScope: !!order.ai && (scope == null || scope.has(base.id)),
        warnings: uncoveredWarnings(pos, r, kinds.get(base.id)),
      };
    });
  },
);

// объект производных меняется и тогда, когда нужные строкам части те же (stale ↔ свежие) — ключ кэша только из них
const depsMemo = memo2((res: Derived['res'], quote: Derived['quote'], attention: Derived['attention']) => ({ res, quote, attention }));

/** Строки в порядке заказа (по частям состояния — для компонентов, которые не подписаны на всё состояние) */
export function rowsFor(order: Order, d: Derived, addedIds: string[]): RowModel[] {
  return rowsMemo(order, depsMemo(d.res, d.quote, d.attention), addedIds);
}

/** Строки в порядке заказа */
export function buildRows(state: AppState, d: Derived): RowModel[] {
  return rowsFor(state.order, d, state.pipeline.addedIds);
}

// ---------- фильтр, поиск, сортировка ----------

const HOMO: Record<string, string> = { A: 'А', B: 'В', E: 'Е', K: 'К', M: 'М', H: 'Н', O: 'О', P: 'Р', C: 'С', T: 'Т', X: 'Х' };

/** Для поиска: регистр, ё→е, латиница-двойники (A, B, E, K, M, H, O, P, C, T, X) → кириллица, без пробелов */
export function normSearch(s: string): string {
  return s
    .toUpperCase()
    .replace(/[ABEKMHOPCTX]/g, (c) => HOMO[c])
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, '');
}

export const FILTERS: readonly { id: TableFilter; label: string }[] = [
  { id: 'all', label: 'Все' },
  { id: 'attention', label: 'Требуют внимания' },
  { id: 'ai', label: 'Изменены ИИ' },
  { id: 'unpriced', label: 'Без цены' },
  { id: 'disabled', label: 'Исключены' },
  { id: 'unchecked', label: 'Не проверены ИИ' },
];

export function matchesFilter(m: RowModel, f: TableFilter, hasAi: boolean): boolean {
  switch (f) {
    case 'all':
      return true;
    case 'attention':
      return m.items.length > 0;
    case 'ai':
      return m.changes.length > 0;
    case 'unpriced':
      return m.unpriced;
    case 'disabled':
      return !!m.pos.disabled;
    case 'unchecked':
      return hasAi && !m.pos.disabled && !m.inScope;
  }
}

export const filterCounts = memo2((rows: RowModel[], hasAi: boolean): Record<TableFilter, number> => {
  const out: Record<TableFilter, number> = { all: rows.length, attention: 0, ai: 0, unpriced: 0, disabled: 0, unchecked: 0 };
  for (const m of rows) for (const f of FILTERS) if (f.id !== 'all' && matchesFilter(m, f.id, hasAi)) out[f.id]++;
  return out;
});

const statusRank = (m: RowModel) => {
  let problem = 0;
  for (const i of m.items) if (i.severity === 'problem') problem++;
  if (problem) return 3000 + problem;
  if (m.items.length) return 2000 + m.items.length;
  return m.inScope ? 1 : 0;
};

const collator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });

function sortValue(m: RowModel, key: SortKey): number {
  if (key === 'status') return statusRank(m);
  if (key === 'piece') return m.line?.price ?? -1;
  if (key === 'sum') return m.line?.sum ?? -1;
  return m.index;
}

/** Видимые строки: фильтр → поиск → сортировка */
export const visibleRows = memo2((rows: RowModel[], filter: TableFilter, search: string, sort: UiState['sort'], hasAi: boolean): RowModel[] => {
  const q = normSearch(search);
  let out = filter === 'all' ? rows : rows.filter((m) => matchesFilter(m, filter, hasAi));
  if (q) out = out.filter((m) => normSearch(m.pos.name).includes(q) || (!!m.pos.fileName && normSearch(m.pos.fileName).includes(q)));
  if (sort.key === 'order') return out;
  const dir = sort.dir;
  return out.slice().sort((a, b) => {
    const v = sort.key === 'name' ? collator.compare(a.pos.name, b.pos.name) : sortValue(a, sort.key) - sortValue(b, sort.key);
    return v * dir || a.index - b.index;
  });
});

/** Порядок позиций, как в таблице сейчас (фильтр, поиск, сортировка) — для ↑/↓ в карточке */
export function visibleRowIds(state: AppState, d: Derived): string[] {
  const { filter, search, sort } = state.ui;
  return visibleRows(buildRows(state, d), filter, search, sort, !!state.order.ai).map((m) => m.base.id);
}
