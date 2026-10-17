// Состояние приложения: одно хранилище, помощники для срезов, сохранение в браузере и вкладка в адресе (#metal).
import { toast } from 'sonner';
import { DEFAULT_QUOTE, type PieceRounding, type QuoteSettings } from '../quote.ts';
import { EMPTY_BOOK, loadOrder, loadSettings, saveOrder, saveSettings, type Order } from '../order.ts';
import { initialStages } from '../pipeline.ts';
import { createStore, useSelector } from './createStore.ts';
import type { AiSlice, AppState, ColumnId, PipelineSlice, PricesState, TabId, UiState, View } from './types.ts';

const K_QUOTE = 'metalcalc.quote.v1';
const K_UI = 'metalcalc.ui.v1';
const TABS: readonly TabId[] = ['positions', 'metal', 'prices', 'quote'];

// ---------- сохранённые настройки КП и интерфейса ----------

const ROUNDING: readonly PieceRounding[] = ['kop', 'rub', 'ten'];

export function loadQuote(): QuoteSettings {
  const q: QuoteSettings = { ...DEFAULT_QUOTE };
  try {
    const raw = localStorage.getItem(K_QUOTE);
    const j = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    if (j && typeof j === 'object') {
      const out = q as unknown as Record<string, unknown>;
      for (const k of Object.keys(DEFAULT_QUOTE)) if (typeof j[k] === typeof out[k]) out[k] = j[k];
      if (!ROUNDING.includes(q.rounding)) q.rounding = DEFAULT_QUOTE.rounding;
    }
  } catch {
    /* по умолчанию */
  }
  return q;
}

const mq = (q: string) => typeof window !== 'undefined' && window.matchMedia(q).matches;

/** Колонки таблицы по умолчанию: разбивка на 1 шт — только на широком экране, габарит — от 1280 px */
export function defaultColumns(): Record<ColumnId, boolean> {
  return { thumb: true, geometry: mq('(min-width: 1280px)'), bends: true, breakdown: mq('(min-width: 1536px)'), cost: true, share: true };
}

function loadUiPrefs(): Pick<UiState, 'columns' | 'aiCardOpen'> {
  const columns = defaultColumns();
  let aiCardOpen: boolean | null = null;
  try {
    const raw = localStorage.getItem(K_UI);
    const j = raw ? (JSON.parse(raw) as { columns?: Record<string, unknown>; aiCardOpen?: unknown }) : null;
    if (j?.columns && typeof j.columns === 'object') {
      for (const k of Object.keys(columns) as ColumnId[]) if (typeof j.columns[k] === 'boolean') columns[k] = j.columns[k] as boolean;
    }
    if (typeof j?.aiCardOpen === 'boolean') aiCardOpen = j.aiCardOpen;
  } catch {
    /* по умолчанию */
  }
  return { columns, aiCardOpen };
}

function save(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* хранилище недоступно — только до перезагрузки */
  }
}

/** Вкладка из адреса: '' → позиции; неизвестное — null (не трогаем) */
function tabFromHash(): TabId | null {
  if (typeof location === 'undefined') return null;
  const h = decodeURIComponent(location.hash.replace(/^#/, ''));
  if (!h) return 'positions';
  return (TABS as readonly string[]).includes(h) ? (h as TabId) : null;
}

// ---------- начальное состояние ----------

export function initialPipeline(): PipelineSlice {
  return { stages: initialStages(), parse: null, busy: false, processing: false, detached: false, addedIds: [], emptyResult: false, runId: 0 };
}

export function initialAi(server: AiSlice['server'] = null): AiSlice {
  return { server, run: null, pending: null, lastContext: null, lastImages: 0, outcome: { kind: 'none' } };
}

function initialPrices(): PricesState {
  return { book: EMPTY_BOOK, live: false, loaded: false, busy: 'Загрузка цен…', blockedUntil: null, issue: null };
}

function initialState(): AppState {
  return {
    order: loadOrder(),
    settings: loadSettings(),
    quote: loadQuote(),
    prices: initialPrices(),
    ai: initialAi(),
    pipeline: initialPipeline(),
    ui: {
      tab: tabFromHash() ?? 'positions',
      sheet: null,
      dialog: null,
      triage: null,
      highlight: null,
      flash: null,
      selection: [],
      filter: 'all',
      search: '',
      sort: { key: 'order', dir: 1 },
      ...loadUiPrefs(),
      quoteQuestions: false,
      printMode: 'client',
    },
  };
}

// ---------- хранилище и помощники ----------

export const appStore = createStore<AppState>(initialState());
export const getState = (): AppState => appStore.get();
export const setState = (fn: (s: AppState) => AppState): void => appStore.set(fn);
/** Селектор — примитив или существующая ссылка (не новый объект) */
export const useStore = <T>(sel: (s: AppState) => T): T => useSelector(appStore, sel);

/** Поверхностное слияние: та же ссылка, если ничего не изменилось */
export function merge<T extends object>(cur: T, p: Partial<T>): T {
  for (const k of Object.keys(p) as (keyof T)[]) if (!Object.is(cur[k], p[k])) return { ...cur, ...p };
  return cur;
}

type SliceKey = 'ui' | 'ai' | 'pipeline' | 'prices';
function patchSlice<K extends SliceKey>(key: K, p: Partial<AppState[K]>): void {
  setState((s) => {
    const next = merge(s[key], p);
    return next === s[key] ? s : { ...s, [key]: next };
  });
}

export function setOrder(fn: (o: Order) => Order): void {
  setState((s) => {
    const order = fn(s.order);
    return order === s.order ? s : { ...s, order };
  });
}
export const patchUi = (p: Partial<UiState>): void => patchSlice('ui', p);
export const patchAi = (p: Partial<AiSlice>): void => patchSlice('ai', p);
export const patchPipeline = (p: Partial<PipelineSlice>): void => patchSlice('pipeline', p);
export const patchPrices = (p: Partial<PricesState>): void => patchSlice('prices', p);

export const selectView = (s: AppState): View => (s.pipeline.processing ? 'processing' : s.order.positions.length ? 'result' : 'empty');

// ---------- сохранение и адрес ----------

let saveTimer: ReturnType<typeof setTimeout> | null = null;
const warned = new Set<string>();

function flushOrder() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  const w = saveOrder(getState().order);
  if (w && !warned.has(w)) {
    warned.add(w);
    toast.warning(w);
  }
}

if (typeof window !== 'undefined') {
  let prev = getState();
  appStore.subscribe(() => {
    const s = getState();
    if (s.order !== prev.order) {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(flushOrder, 400);
    }
    if (s.settings !== prev.settings) saveSettings(s.settings);
    if (s.quote !== prev.quote) save(K_QUOTE, s.quote);
    if (s.ui.columns !== prev.ui.columns || s.ui.aiCardOpen !== prev.ui.aiCardOpen) save(K_UI, { columns: s.ui.columns, aiCardOpen: s.ui.aiCardOpen });
    // pushState, а не location.hash: страница не прокручивается к элементу с таким id
    if (s.ui.tab !== prev.ui.tab && (tabFromHash() ?? '') !== s.ui.tab) history.pushState(history.state, '', `#${s.ui.tab}`);
    prev = s;
  });
  // закрытие вкладки — сохранить сразу
  window.addEventListener('pagehide', () => {
    if (saveTimer) flushOrder();
  });
  // назад/вперёд в браузере переключают вкладки
  window.addEventListener('hashchange', () => {
    const t = tabFromHash();
    if (t) patchUi({ tab: t });
  });
  if (import.meta.env.DEV) (window as unknown as { __store: typeof appStore }).__store = appStore;
}

// модуль с подписками на окно не обновляется на лету: при правке его (или его зависимостей) — перезагрузка страницы
if (import.meta.hot) import.meta.hot.accept(() => location.reload());
