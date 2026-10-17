// Производные данные заказа: позиции с предложениями ИИ, расчёт (computeOrder), КП, «устарел ли анализ», замечания.
// Считаются только здесь (и в ленивых Δ предложений ИИ). Каждая величина кэширована по своим входам (memo.ts):
// наценка и доставка не пересчитывают хэш анализа, правка названия не трогает раскрой и т. д.
import { createContext, use, useDeferredValue, useMemo, type ReactElement, type ReactNode } from 'react';
import { changesFor, effectivePositions, type AiChange } from '../ai/apply.ts';
import { buildAttention, type Attention } from '../attention.ts';
import type { AiContext } from '../core/ai.ts';
import { computeOrder, type OrderResult, type PriceBook, type Settings } from '../core/pricing.ts';
import { orderSettings, type Order, type OrderPosition } from '../order.ts';
import { aiOutdated } from '../pipeline.ts';
import { buildQuote, pricedPositions, type Quote, type QuoteSettings } from '../quote.ts';
import { memo2, memoBy } from './memo.ts';
import { getState, useStore } from './store.ts';
import type { AppState, PriceIssue } from './types.ts';

export interface CalcInput {
  order: Order;
  book: PriceBook;
  settings: Settings;
  quote: QuoteSettings;
  live: boolean;
  priceIssue: PriceIssue | null;
  aiContext: AiContext | null;
  maxAgeHours: number;
  loaded?: boolean; // справочник цен загружен (false — ещё EMPTY_BOOK: «устарел» не показываем)
}

export interface Derived {
  positions: OrderPosition[]; // effectivePositions(order.positions, order.ai) — что показывается и считается
  byId: Map<string, OrderPosition>; // те же позиции по id
  changes: Map<string, AiChange[]>; // changesFor(базовая позиция, order.ai) — только позиции с изменениями ИИ
  baseRes: OrderResult; // computeOrder по базовым позициям (без ИИ, все как есть) — хэш анализа ИИ, замечания
  res: OrderResult; // computeOrder по позициям с ИИ без позиций без размеров (pricedPositions); === baseRes, если ИИ ничего не изменил и все с размерами
  quote: Quote; // КП: «Цена клиенту» везде
  baseQuote: Quote; // КП по базовым позициям (=== quote, если ИИ ничего не изменил)
  aiImpact: number; // quote.total − baseQuote.total: насколько ИИ изменил цену клиенту
  outdated: boolean; // данные заказа изменились после анализа ИИ
  attention: Attention;
  unpriced: Set<string>; // позиции без размеров: цена не посчитана
  stale: boolean; // отрисованные числа отстают от состояния (идёт пересчёт)
}

/** Счётчики пересчётов (в DEV — window.__metalcalcStats): проверка, что лишнего не считается */
export const derivedStats = { derive: 0, computeOrder: 0, contextHash: 0, quote: 0, attention: 0 };

const runOrder = (positions: OrderPosition[], book: PriceBook, s: Settings): OrderResult => {
  derivedStats.computeOrder++;
  return computeOrder(positions, book, s);
};

// ---------- кэши по входам (ui-spec §4.4) ----------

const settingsMemo = memoBy(
  (order: Order, settings: Settings) => [settings, order.sheetChoice, order.priceOverride, order.markupPct, order.delivery],
  (order: Order, settings: Settings) => orderSettings(order, settings),
);
const baseResMemo = memo2(runOrder);
const resMemo = memo2(runOrder);
const baseCalcMemo = memo2(runOrder); // базовые позиции без позиций без размеров — для baseQuote
const positionsMemo = memo2(effectivePositions);
// позиции без размеров — как исключённые: в деньги (себестоимость, раскрой) не идут; свой кэш на базовые и на позиции с ИИ
const pricedBaseMemo = memo2(pricedPositions);
const pricedMemo = memo2(pricedPositions);
const byIdMemo = memo2((positions: OrderPosition[]) => new Map(positions.map((p) => [p.id, p])));
const changesMemo = memo2((positions: OrderPosition[], ai: Order['ai']) => {
  const out = new Map<string, AiChange[]>();
  if (!ai) return out;
  for (const p of positions) {
    const ch = changesFor(p, ai);
    if (ch.length) out.set(p.id, ch);
  }
  return out;
});
const unpricedMemo = memo2((positions: OrderPosition[]) => {
  const out = new Set<string>();
  for (const p of positions) if (!p.disabled && p.qty > 0 && (p.geom.netArea <= 0 || p.geom.cutLength <= 0)) out.add(p.id);
  return out;
});

type QuoteArgs = [order: Order, positions: OrderPosition[], res: OrderResult, settings: Settings, qs: QuoteSettings, book: PriceBook, today: string];
const quoteKey = (order: Order, positions: OrderPosition[], res: OrderResult, settings: Settings, qs: QuoteSettings, book: PriceBook, today: string) => [
  order.title,
  order.delivery,
  order.markupPct,
  positions,
  res,
  settings,
  qs,
  book,
  today,
];
const quoteOf = (...[order, positions, res, settings, qs, book]: QuoteArgs): Quote => {
  derivedStats.quote++;
  return buildQuote({ order, positions, res, settings, quote: qs, book });
};
const quoteMemo = memoBy(quoteKey, quoteOf);
const baseQuoteMemo = memoBy(quoteKey, quoteOf);

// хэш анализа не зависит от наценки и доставки — их нет в ключе, baseRes передаётся, но в ключ не входит
const outdatedMemo = memoBy(
  (order: Order, book: PriceBook, settings: Settings, _baseRes: OrderResult) => [
    order.ai?.contextHash,
    order.title,
    order.positions,
    order.request,
    order.documents,
    order.requestLines,
    order.sheetChoice,
    order.priceOverride,
    book,
    settings,
  ],
  (order: Order, book: PriceBook, settings: Settings, baseRes: OrderResult) => {
    if (!order.ai) return false;
    derivedStats.contextHash++;
    return aiOutdated(order, book, settings, baseRes);
  },
);

const attentionMemo = memo2(
  (
    order: Order,
    positions: OrderPosition[],
    res: OrderResult,
    baseRes: OrderResult,
    book: PriceBook,
    settings: Settings,
    live: boolean,
    priceIssue: PriceIssue | null,
    aiContext: AiContext | null,
    outdated: boolean,
    _maxAgeHours: number,
  ) => {
    derivedStats.attention++;
    return buildAttention({ order, positions, res, baseRes, book, settings, live, priceIssue, aiContext, outdated });
  },
);

const dayKey = () => new Date().toDateString();

function derive(i: CalcInput): Derived {
  derivedStats.derive++;
  const { order, book, settings, quote: qs } = i;
  const s = settingsMemo(order, settings);
  const baseRes = baseResMemo(order.positions, book, s);
  const positions = positionsMemo(order.positions, order.ai);
  // деньги — только по позициям с размерами (те же объекты, если таких нет)
  const pricedBase = pricedBaseMemo(order.positions);
  const baseCalc = pricedBase === order.positions ? baseRes : baseCalcMemo(pricedBase, book, s);
  const priced = positions === order.positions ? pricedBase : pricedMemo(positions);
  const res = priced === order.positions ? baseRes : priced === pricedBase ? baseCalc : resMemo(priced, book, s);
  const today = dayKey();
  // в КП — все позиции: без размеров остаются строкой «цена уточняется»
  const quote = quoteMemo(order, positions, res, settings, qs, book, today);
  const baseQuote = positions === order.positions ? quote : baseQuoteMemo(order, order.positions, baseCalc, settings, qs, book, today);
  // пока справочник цен не загружен (EMPTY_BOOK), хэш контекста не тот — «устарел» не показываем
  const outdated = i.loaded === false ? false : outdatedMemo(order, book, settings, baseRes);
  const attention = attentionMemo(order, positions, res, baseRes, book, settings, i.live, i.priceIssue, i.aiContext, outdated, i.maxAgeHours);
  return {
    positions,
    byId: byIdMemo(positions),
    changes: changesMemo(order.positions, order.ai),
    baseRes,
    res,
    quote,
    baseQuote,
    aiImpact: quote.total - baseQuote.total,
    outdated,
    attention,
    unpriced: unpricedMemo(positions),
    stale: false,
  };
}

/** Чистая функция; тот же вход (по ссылке) — тот же результат */
export const computeDerived: (i: CalcInput) => Derived = memo2(derive);

const calcInputMemo = memo2(
  (
    order: Order,
    book: PriceBook,
    settings: Settings,
    quote: QuoteSettings,
    live: boolean,
    priceIssue: PriceIssue | null,
    aiContext: AiContext | null,
    maxAgeHours: number,
    loaded: boolean,
  ): CalcInput => ({
    order,
    book,
    settings,
    quote,
    live,
    priceIssue,
    aiContext,
    maxAgeHours,
    loaded,
  }),
);

/** Вход расчёта из состояния: тот же объект при тех же ссылках (годится для useStore) */
export const selectCalcInput = (s: AppState): CalcInput =>
  calcInputMemo(
    s.order,
    s.prices.book,
    s.settings,
    s.quote,
    s.prices.live,
    s.prices.issue,
    s.ai.lastContext,
    s.settings.priceMaxAgeHours ?? 24,
    s.prices.loaded,
  );

/** Для действий вне React: всегда по текущему состоянию */
export function getDerived(): Derived {
  return computeDerived(selectCalcInput(getState()));
}

const DerivedCtx = createContext<Derived | null>(null);

/** Пересчёт в фоне (useDeferredValue): ввод не ждёт computeOrder, числа на время пересчёта помечены stale */
export function DerivedProvider({ children }: { children: ReactNode }): ReactElement {
  const live = useStore(selectCalcInput);
  const input = useDeferredValue(live);
  const d = useMemo(() => computeDerived(input), [input]);
  const stale = input !== live;
  const value = useMemo(() => (stale ? { ...d, stale: true } : d), [d, stale]);
  return <DerivedCtx value={value}>{children}</DerivedCtx>;
}

export function useDerived(): Derived {
  const d = use(DerivedCtx);
  if (!d) throw new Error('useDerived() вызван вне <DerivedProvider>');
  return d;
}

if (import.meta.env.DEV && typeof window !== 'undefined') (window as unknown as { __metalcalcStats: typeof derivedStats }).__metalcalcStats = derivedStats;
