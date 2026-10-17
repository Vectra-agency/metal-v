// Форма состояния приложения (ui-spec §4.2). Только типы.
import type { AiAnalysis, AiContext, AiJobState, AiServerStatus } from '../core/ai.ts';
import type { PriceBook, Settings } from '../core/pricing.ts';
import type { Order } from '../order.ts';
import type { ParseProgress, Stages } from '../pipeline.ts';
import type { QuoteSettings } from '../quote.ts';

export type TabId = 'positions' | 'metal' | 'prices' | 'quote';
export type View = 'empty' | 'processing' | 'result';

/** Последнее неудачное (или частичное) обновление цен */
export interface PriceIssue {
  at: number;
  reason: string;
  errors: string[];
}

export interface PricesState {
  book: PriceBook; // EMPTY_BOOK, пока не загружен
  live: boolean; // есть API сервера (false — статическая версия dist/)
  loaded: boolean;
  busy: string | null; // «Обновляю цены mc.ru: 2 из 4» (кнопка обновления недоступна)
  blockedUntil: number | null; // анти-бот mc.ru: не обновлять до (мс); ставится now + 15 мин
  issue: PriceIssue | null; // сбрасывается удачным обновлением
}

export interface AiRun {
  id: number; // сверяется при получении результата: устаревшие отбрасываются
  startedAt: number;
  job: AiJobState | null; // последнее состояние задачи (ожидание / очередь / работа)
  requestAtStart: string; // order.request при запуске
  restarted: boolean; // единственный перезапуск из-за вставленной заявки уже был
}

/** Поздний результат: после «Показать расчёт без ИИ» или правок во время анализа */
export interface PendingAi {
  analysis: AiAnalysis;
  contextHash: string;
  scope: string[];
  ctx: AiContext | null;
  receivedAt: number;
}

export type AiOutcome =
  | { kind: 'none' } // в этой вкладке не запускался
  | { kind: 'done'; at: number }
  | { kind: 'skipped'; reason: string; canRun: boolean } // не настроен / статическая версия / нет позиций
  | { kind: 'cancelled' } // «Отменить анализ»
  | { kind: 'error'; message: string };

export interface AiSlice {
  server: AiServerStatus | null; // null — ещё не спрашивали
  run: AiRun | null;
  pending: PendingAi | null;
  lastContext: AiContext | null; // только в памяти («Что видел ИИ», цитаты); НИКОГДА не сохраняется
  lastImages: number;
  outcome: AiOutcome;
}

export interface PipelineSlice {
  stages: Stages; // src/pipeline.ts (initialStages/updateStage)
  parse: ParseProgress | null;
  busy: boolean; // идёт какой-то этап
  processing: boolean; // экран обработки (первый запуск на пустом заказе)
  detached: boolean; // во время этого запуска нажато «Показать расчёт без ИИ»
  addedIds: string[]; // позиции, добавленные последним повторным разбором («новая»)
  emptyResult: boolean; // последний разбор не нашёл чертежей
  runId: number;
}

export type SheetFocus = 'dims' | 'material' | 'thickness' | 'qty' | 'bends' | 'extras' | 'variant' | 'ai';
export type RequestSection = 'stages' | 'request' | 'documents' | 'missing' | 'journal';
export type SettingsTab = 'cut' | 'bend' | 'mat' | 'nest' | 'extra' | 'quote';
export type SheetState =
  | { kind: 'position'; id: string; focus?: SheetFocus }
  | { kind: 'item'; itemId: string }
  | { kind: 'request'; section?: RequestSection }
  | { kind: 'settings'; tab?: SettingsTab };
export type GuardAction = 'copy' | 'copyTable' | 'copyQuestions' | 'csv' | 'print';
export type DialogState =
  | { kind: 'manual'; prefill?: { name?: string; qty?: number } }
  | { kind: 'pdfReview'; id: string }
  | { kind: 'guard'; action: GuardAction }
  | { kind: 'shortcuts' };
export interface TriageState {
  ids: string[];
  index: number;
}
export type TableFilter = 'all' | 'attention' | 'ai' | 'unpriced' | 'disabled' | 'unchecked';
export type SortKey = 'order' | 'name' | 'status' | 'piece' | 'sum';
export type ColumnId = 'thumb' | 'geometry' | 'bends' | 'breakdown' | 'cost' | 'share';

export interface UiState {
  tab: TabId;
  sheet: SheetState | null;
  dialog: DialogState | null;
  triage: TriageState | null;
  highlight: string | null; // подсветка при наведении (список ↔ SVG листов, строки таблицы)
  flash: string | null; // вспышка строки при переходе к ней; сбрасывается через 1200 мс
  selection: string[];
  filter: TableFilter;
  search: string;
  sort: { key: SortKey; dir: 1 | -1 };
  columns: Record<ColumnId, boolean>; // сохраняется
  aiCardOpen: boolean | null; // сохраняется; null — авто
  quoteQuestions: boolean; // вопросы клиенту в тексте/КП (только в памяти)
  printMode: 'client' | 'internal';
}

export interface AppState {
  order: Order;
  settings: Settings;
  quote: QuoteSettings;
  prices: PricesState;
  ai: AiSlice;
  pipeline: PipelineSlice;
  ui: UiState;
}
