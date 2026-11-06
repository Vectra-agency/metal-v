// Контракт ИИ-анализа заказа: что браузер отправляет на сервер (AiContext),
// что сервер возвращает (AiAnalysis) и как браузер хранит решения по
// предложениям ИИ (AiState). Общий для src/ и server/*.ts — только типы
// и константы, без зависимостей (сервер исполняет этот файл как есть).

import type { SheetPolicy } from './materials.ts';

export const AI_CONTEXT_VERSION = 1;

/** Лимиты: запрос к модели должен оставаться разумного размера, а тело POST — меньше 1 МБ (nginx по умолчанию) */
export const AI_LIMITS = {
  drawingTextChars: 1500, // текст одного чертежа
  documentChars: 6000, // текст одного документа (заявка, спецификация, письмо)
  documents: 8,
  requestChars: 8000, // текст заявки клиента, вставленный вручную
  totalTextChars: 60000, // все тексты заказа вместе (чертежи + документы + заявка)
  positions: 150, // больше — анализируются первые, остальные помечаются в warnings
  contextBytes: 900_000, // JSON AiContext в POST /api/ai/jobs
  images: 12, // изображений чертежей на один анализ
  imageBytes: 900_000, // один JPEG в PUT /api/ai/jobs/<id>/images/<n>
  imageMaxSidePx: 1600,
} as const;

// ---------- запрос: AiContext ----------

/** Материал из справочника приложения — ИИ может предлагать только эти id */
export interface AiMaterialRef {
  id: string;
  label: string;
  short: string;
  density: number; // кг/м³
  policy: SheetPolicy; // как цех списывает лист
  thicknesses: number[];
  cutGroup?: string; // колонка прайса резки: steel | stainless | aluminum | copper
}

/** Справочная ставка доп. операции (Расценки → «Доп. операции»); ИИ считает по ней ₽/шт */
export interface AiExtraRate {
  label: string;
  unit: string; // «м²», «отв.», «м шва», «кг», «шт»
  price: number; // ₽ за единицу с НДС
  note?: string;
}

/** Вариант листа для группы материал+толщина (как в «Металл и раскрой») */
export interface AiOffer {
  sheet: string; // «1500×3000»
  pricePerKg: number; // ₽/кг с НДС
  source: 'mc' | 'estimate' | 'manual'; // mc.ru / нет толщины на mc.ru — оценка / задана вручную
  note: string;
  materialCost: number; // металл группы при этом листе, ₽
  sheets: number; // листов в расчёте (дробное: последний — по занятой части)
  utilization: number; // заполнение раскроя 0..1
  splitParts: number; // деталей, которые не влезают в лист и режутся из частей
}

export interface AiGroup {
  key: string; // `${materialId}|${thickness}`
  materialId: string;
  materialLabel: string;
  thickness: number;
  policy: SheetPolicy;
  chosenSheet: string;
  autoChosen: boolean; // лист выбран автоматически (а не пользователем)
  capped: boolean; // стоимость металла ограничена потолком отхода
  materialCost: number;
  partsKg: number; // масса деталей группы
  bboxKg: number; // масса габаритных заготовок
  offers: AiOffer[];
  mcUrl: string; // выборка mc.ru по этой толщине
  pricesFetchedAt: string | null; // когда цены этой толщины взяты с mc.ru
}

/** Детерминированный расчёт позиции (до предложений ИИ), ₽ с НДС */
export interface AiPositionCost {
  material: number; // на 1 шт
  cut: number; // резка на 1 шт (метры × ₽/м по прайсу)
  bend: number;
  extras: number;
  total: number; // себестоимость 1 шт
  sum: number; // себестоимость позиции
  priceWithMarkup: number; // цена 1 шт для клиента
  sumWithMarkup: number;
}

export interface AiPosition {
  id: string;
  name: string; // обозначение детали
  fileName?: string;
  source: 'dxf' | 'pdf' | 'manual';
  disabled: boolean; // исключена из расчёта
  materialId: string;
  thickness: number; // мм
  qty: number;
  /** true — значение не найдено в файлах, стоит значение по умолчанию */
  guessed: { material: boolean; thickness: boolean; qty: boolean };
  geometry: {
    widthMm: number; // габарит развёртки
    heightMm: number;
    areaM2: number; // площадь детали за вычетом отверстий
    bboxAreaM2: number;
    cutM: number; // длина реза на 1 шт
    pierces: number; // врезки (контуры)
    contours: number; // отдельных деталей в файле (обычно 1)
  };
  bends: number; // гибов на 1 шт (в расчёте)
  detectedBends: number; // линий гиба найдено в файле (в DXF их обычно нет — тогда 0)
  bendLengthMm: number;
  extras: { label: string; perPiece: number }[]; // доп. работы, уже введённые вручную
  massKg: number; // масса 1 шт по контуру
  massCheck?: { drawingKg: number | null; status: 'ok' | 'warn' | 'bad' | 'unknown' }; // сверка с массой на чертеже
  titleBlock?: { designation?: string; materialText?: string; thickness?: number; massKg?: number; scale?: string };
  drawingText?: string; // текст с чертежа: технические требования, примечания, штамп (обрезан)
  imageIndex?: number; // номер приложенного изображения чертежа (если отправлено)
  warnings: string[];
  note?: string;
  splitParts?: number; // не влезает в лист — режется из N частей
  cost?: AiPositionCost; // нет, если позиция исключена
}

/** Текст документа без чертежа: заявка, спецификация, письмо (.txt / листы PDF без чертежа) */
export interface AiDocument {
  fileName: string;
  text: string;
}

export interface AiImageRef {
  index: number; // порядковый номер, по нему же PUT /api/ai/jobs/<id>/images/<index>
  positionId: string;
  caption: string; // «НГЭН.745421.0001, стр. 1»
}

export interface AiTotals {
  material: number;
  cutting: number;
  bending: number;
  extras: number;
  delivery: number;
  cost: number; // себестоимость заказа
  markup: number;
  total: number; // цена для клиента
  vat: number;
  kg: number;
  cutM: number;
  bends: number;
  pieces: number;
}

export interface AiContext {
  version: typeof AI_CONTEXT_VERSION;
  createdAt: string; // ISO
  order: {
    title: string;
    request: string; // текст заявки клиента (вставлен вручную), может быть пустым
    markupPct: number;
    delivery: number;
    vatPct: number; // цены уже с НДС
    region: string; // регион цен mc.ru
    pricesUpdatedAt: string | null;
  };
  materials: AiMaterialRef[];
  rates: {
    /** прайс резки, ₽ за погонный метр реза; строка t действует для толщин до t включительно; null — нет в прайсе */
    cutting: { t: number; steel: number | null; stainless: number | null; aluminum: number | null; copper: number | null }[];
    bending: { t: number; perBend: number }[]; // гиб до 1 м
    bendLenK: { upTo: number; k: number }[];
    bendSetup: number;
    extraOps: AiExtraRate[];
  };
  groups: AiGroup[];
  positions: AiPosition[];
  documents: AiDocument[];
  images: AiImageRef[]; // пусто, если модель без зрения или картинки не отправляются
  unmatchedRequestLines: string[]; // строки заявки из PDF, для которых нет чертежа
  totals: AiTotals;
}

// ---------- ответ: AiAnalysis ----------

export type AiStatus = 'ok' | 'check' | 'problem';
/** disable — исключить позицию из расчёта (например, базовое исполнение, которое не заказано); никогда не применяется само */
export type AiSuggestionKind = 'material' | 'thickness' | 'qty' | 'bends' | 'extra' | 'disable';

/** Конкретное изменение, которое приложение умеет применить к позиции */
export interface AiSuggestion {
  id: string; // `${positionId}#${n}` — назначает сервер
  kind: AiSuggestionKind;
  materialId?: string; // kind = material: id из AiContext.materials
  value?: number; // thickness (мм), qty (шт), bends (гибов на 1 шт)
  label?: string; // kind = extra: название операции
  perPiece?: number; // kind = extra: ₽ за 1 шт с НДС
  reason: string; // почему: дословная цитата в «ёлочках» из чертежа/заявки и расчёт по ставке
}

/** Токены и стоимость одного анализа: Hubris считает в рублях, PoYo — в долларах (по ценам каталога моделей) */
export interface AiUsage {
  promptTokens: number;
  completionTokens: number;
  costRub: number | null;
  costUsd?: number | null;
}

export interface AiPositionReview {
  id: string; // AiPosition.id
  status: AiStatus;
  comment: string;
  operations: string[]; // какие операции нужны детали по чертежу: «лазерная резка», «гибка 4 гиба», «покраска RAL 7035»…
  suggestions: AiSuggestion[];
}

export interface AiAnalysis {
  summary: string; // 2–5 предложений о заказе
  confidence: 'high' | 'medium' | 'low';
  positions: AiPositionReview[]; // только позиции, по которым есть что сказать; остальные — ok
  questions: string[]; // что уточнить у клиента
  risks: string[];
  recommendations: string[]; // как удешевить / что проверить
  model: string; // какая модель ответила
  createdAt: string; // ISO
  durationMs: number;
  usage?: AiUsage;
  fallback?: boolean; // ответила резервная модель (не LLM_MODEL) — качество может быть ниже
}

/** Что модель должна вернуть (response_format json_schema). Сервер приводит это к AiAnalysis.
 *  Порядок свойств важен: модель пишет поля в порядке схемы, поэтому reason (с расчётом) идёт раньше чисел. */
export const AI_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'confidence', 'positions', 'questions', 'risks', 'recommendations'],
  properties: {
    summary: { type: 'string' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    positions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'status', 'comment', 'operations', 'suggestions'],
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: ['ok', 'check', 'problem'] },
          comment: { type: 'string' },
          operations: { type: 'array', items: { type: 'string' } },
          suggestions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'reason', 'materialId', 'value', 'label', 'perPiece'],
              properties: {
                kind: { type: 'string', enum: ['material', 'thickness', 'qty', 'bends', 'extra', 'disable'] },
                reason: { type: 'string' },
                materialId: { type: ['string', 'null'] },
                value: { type: ['number', 'null'] },
                label: { type: ['string', 'null'] },
                perPiece: { type: ['number', 'null'] },
              },
            },
          },
        },
      },
    },
    questions: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    recommendations: { type: 'array', items: { type: 'string' } },
  },
} as const;

// ---------- API ----------

/** GET /api/ai/status */
export interface AiServerStatus {
  configured: boolean; // LLM_* заданы на сервере
  model: string | null;
  vision: boolean; // модель принимает изображения чертежей
}

/** POST /api/ai/jobs → 201. imagesExpected = 0, если модель без зрения: изображения не нужны */
export interface AiJobCreated {
  jobId: string;
  imagesExpected: number;
}

/** GET /api/ai/jobs/<id> */
export type AiJobState =
  | { status: 'waiting'; imagesReceived: number; imagesExpected: number } // ждёт изображения
  | { status: 'queued'; position: number }
  | { status: 'running'; elapsedMs: number; model: string | null }
  | { status: 'done'; analysis: AiAnalysis; usage?: AiUsage }
  | { status: 'error'; error: string }; // текст для пользователя, по-русски

// ---------- состояние в браузере ----------

/** Анализ, сохранённый в заказе, и решения пользователя по предложениям */
export interface AiState {
  analysis: AiAnalysis;
  accepted: Record<string, boolean>; // AiSuggestion.id → true применено · false отклонено · нет ключа — ждёт решения
  contextHash: string; // хэш AiContext на момент анализа: изменились данные — анализ устарел
}
