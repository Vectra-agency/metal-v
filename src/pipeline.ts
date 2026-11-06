// Конвейер расчёта без React: 1) файлы → данные, 2) цены mc.ru, 3) анализ ИИ, 4) расчёт.
// Каждый этап возвращает статус и пояснение для степпера; ошибки цен и ИИ не ломают расчёт.

import type { AiContext, AiDocument, AiJobState, AiServerStatus, AiState } from './core/ai.ts';
import { AI_LIMITS } from './core/ai.ts';
import { clipText } from './core/drawingText.ts';
import type { QtyLine } from './core/pdfAnalyze.ts';
import { computeOrder, type OrderResult, type PriceBook, type Settings } from './core/pricing.ts';
import { aiStateFrom, effectivePositions, isOutdated } from './ai/apply.ts';
import { AiError, aiStatus, analyzeOrder } from './ai/api.ts';
import { buildAiContext, contextHash } from './ai/context.ts';
import { drawingImages } from './ai/images.ts';
import { plural, rub0 } from './format.ts';
import { mergeImports } from './merge.ts';
import { applyRequestQty, qtyLinesFromText } from './requestQty.ts';
import { importDxf as importDxfFile, orderSettings, type ImportDefaults, type Order, type OrderPosition } from './order.ts';
import { desigKey, importPdf as importPdfFile, pdfFileKey, restorePdf as restorePdfFile, type PdfImportResult } from './pdfImport.ts';
import { ensurePrices, orderPairs, pairKey, type EnsurePricesResult } from './prices.ts';

// ---------- этапы ----------

export type StageId = 'files' | 'prices' | 'ai' | 'calc';
export type StageStatus = 'pending' | 'running' | 'done' | 'skipped' | 'error';

export interface Stage {
  id: StageId;
  label: string;
  status: StageStatus;
  detail: string; // пояснение по-русски: «12 деталей, 1 документ», «цены свежие», «ИИ не настроен»…
  startedAt?: number; // Date.now()
  finishedAt?: number;
}

export type Stages = Record<StageId, Stage>;

export const STAGE_ORDER: readonly StageId[] = ['files', 'prices', 'ai', 'calc'];

export const STAGE_LABEL: Record<StageId, string> = {
  files: 'Файлы → данные',
  prices: 'Цены mc.ru',
  ai: 'Анализ ИИ',
  calc: 'Расчёт',
};

export function initialStages(): Stages {
  const s = {} as Stages;
  for (const id of STAGE_ORDER) s[id] = { id, label: STAGE_LABEL[id], status: 'pending', detail: '' };
  return s;
}

/** Новый объект этапов с обновлённым этапом (время начала/конца ставится само) */
export function updateStage(stages: Stages, id: StageId, status: StageStatus, detail?: string, now: number = Date.now()): Stages {
  const prev = stages[id];
  const next: Stage = { ...prev, status, detail: detail ?? prev.detail };
  if (status === 'running') {
    next.startedAt = now;
    delete next.finishedAt;
  } else if (status !== 'pending') next.finishedAt = now;
  else {
    delete next.startedAt;
    delete next.finishedAt;
  }
  return { ...stages, [id]: next };
}

const isFinal = (s: StageStatus) => s === 'done' || s === 'skipped' || s === 'error';

/** Этап, который сейчас выполняется (или первый невыполненный) */
export const currentStage = (stages: Stages): StageId | null => STAGE_ORDER.find((id) => !isFinal(stages[id].status)) ?? null;

// ---------- 1. файлы → данные ----------

export interface ParseProgress {
  done: number;
  total: number;
  file: string; // имя файла, который только что прочитан
}

export interface ParseStats {
  files: number; // принято к чтению (новых)
  dxf: number;
  pdf: number;
  txt: number;
  skipped: number; // не DXF/PDF/TXT
  duplicates: number; // уже в заказе (и тот же файл ещё раз в этой загрузке)
  restored: number; // PDF позиций, которых не было в браузере: записаны заново, позиции те же
  archives: number;
  parts: number; // новых позиций из файлов (до слияния)
  pdfParts: number;
  documents: number; // новых документов
  guessed: number; // новых позиций с неопознанным материалом или толщиной
  noQty: number; // новых позиций без количества
}

export interface ParseResult {
  positions: OrderPosition[]; // ВСЕ позиции заказа после слияния (существующие + новые) — записать в заказ
  documents: AiDocument[]; // ВСЕ документы заказа (существующие + новые)
  requestLines: QtyLine[]; // ВСЕ строки заявок из PDF
  addedIds: string[]; // id позиций, появившихся в этой загрузке
  notes: string[]; // сообщения «для сведения»
  warnings: string[]; // требуют внимания
  errors: string[]; // файлы, которые не прочитались
  stats: ParseStats;
}

/** Что уже есть в заказе: можно передать сам заказ или только позиции */
export interface ExistingOrderData {
  positions: OrderPosition[];
  documents?: AiDocument[];
  requestLines?: QtyLine[];
  request?: string; // текст заявки, вставленный вручную: количество из него — позициям, где его нет
}

/** Подмена импортёров (Node-скрипты читают PDF через pdfjs-dist/legacy) */
export interface ParseDeps {
  importPdf?: (file: File, defs: ImportDefaults) => Promise<PdfImportResult>;
  importDxf?: (file: File, defs: ImportDefaults) => Promise<OrderPosition>;
  restorePdf?: (file: File, key: string) => Promise<boolean>; // PDF уже в заказе: вернуть файл, если его нет в браузере
}

/** Материал и толщина для новых файлов без них в имени — как у последней позиции заказа */
export function importDefaults(positions: OrderPosition[]): ImportDefaults {
  const last = positions.at(-1);
  return { materialId: last?.materialId ?? 'st3', thickness: last?.thickness ?? 2 };
}

const RE_DXF = /\.dxf$/i;
const RE_PDF = /\.pdf$/i;
const RE_TXT = /\.txt$/i;
const RE_ARCH = /\.(zip|rar|7z)$/i;

/** Текст .txt: UTF-8 (с BOM или без), UTF-16 по BOM; битый UTF-8 — Windows-1251 */
export function decodeText(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  const utf = new TextDecoder('utf-8').decode(b);
  const bad = (utf.match(/\ufffd/g) ?? []).length;
  if (bad > 0 && bad >= utf.length * 0.001) {
    try {
      return new TextDecoder('windows-1251').decode(b);
    } catch {
      return utf;
    }
  }
  return utf.replace(/^\ufeff/, '');
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** Имя документа, которого ещё нет в списке: «text.txt» → «text (2).txt» (документ убирается по имени) */
function uniqueDocName(name: string, documents: AiDocument[]): string {
  const taken = new Set(documents.map((d) => d.fileName));
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; ; n++) if (!taken.has(`${stem} (${n})${ext}`)) return `${stem} (${n})${ext}`;
}

const listNames = (names: string[], max = 5) => names.slice(0, max).join(', ') + (names.length > max ? ` и ещё ${names.length - max}` : '');

/**
 * Разбор брошенных файлов (перенесено из App.handleFiles): файлы с именем, которое уже есть в заказе, пропускаются
 * (PDF, пропавший из браузера, при этом записывается заново); в одной загрузке повтор — только то же имя и тот же
 * размер (одинаковые имена разных файлов из разных папок читаются все). Архивы — с просьбой распаковать, прочие
 * типы — с уведомлением; DXF/PDF → позиции, листы PDF без чертежа и .txt → документы; затем слияние DXF+PDF
 * одной детали и количества из заявок, сортировка по имени файла.
 */
export async function parseFiles(
  files: File[],
  existing: OrderPosition[] | ExistingOrderData,
  defaults: ImportDefaults,
  onProgress?: (p: ParseProgress) => void,
  deps: ParseDeps = {},
): Promise<ParseResult> {
  const ex: ExistingOrderData = Array.isArray(existing) ? { positions: existing } : existing;
  const doImportPdf = deps.importPdf ?? importPdfFile;
  const doImportDxf = deps.importDxf ?? importDxfFile;
  const doRestorePdf = deps.restorePdf ?? restorePdfFile;
  const notes: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const stats: ParseStats = { files: 0, dxf: 0, pdf: 0, txt: 0, skipped: 0, duplicates: 0, restored: 0, archives: 0, parts: 0, pdfParts: 0, documents: 0, guessed: 0, noQty: 0 };
  const documents = (ex.documents ?? []).slice();
  const requestLines = (ex.requestLines ?? []).slice();
  const result = (): ParseResult => ({ positions: ex.positions, documents, requestLines, addedIds: [], notes, warnings, errors, stats });

  const archives = files.filter((f) => RE_ARCH.test(f.name));
  const known = files.filter((f) => RE_DXF.test(f.name) || RE_PDF.test(f.name) || RE_TXT.test(f.name));
  stats.archives = archives.length;
  stats.skipped = files.length - known.length - archives.length;
  if (archives.length) warnings.push(`Архивы (${archives.map((a) => a.name).join(', ')}) нужно распаковать и перетащить папку`);
  if (stats.skipped > 0) notes.push(`Пропущено файлов (не DXF, PDF или TXT): ${stats.skipped}`);

  // уже в заказе — по имени файла (повторно брошенная папка пропускается целиком);
  // имя PDF после слияния с DXF хранится в pdf.meta.fileName — его тоже считаем загруженным
  const have = new Set([...ex.positions.flatMap((p) => [p.fileName, p.pdf?.meta.fileName]).filter(Boolean), ...documents.map((d) => d.fileName)] as string[]);
  // ключи PDF позиций по имени файла: тот же файл (имя и размер) возвращает пропавший из браузера чертёж
  const pdfKeys = new Map<string, Set<string>>();
  for (const p of ex.positions) if (p.pdf) pdfKeys.set(p.pdf.meta.fileName, (pdfKeys.get(p.pdf.meta.fileName) ?? new Set()).add(p.pdf.fileKey));
  const keyOf = (f: File): string | null => {
    const keys = [...(pdfKeys.get(f.name) ?? [])];
    const exact = pdfFileKey(f);
    return keys.find((k) => k === exact) ?? keys.find((k) => k.startsWith(`pdf:${f.name}:${f.size}:`)) ?? null;
  };
  const fresh: File[] = [];
  const sizes = new Map<string, number[]>(); // имя → размеры файлов этой загрузки
  const restored: string[] = [];
  const tried = new Set<string>();
  let inOrder = 0;
  let copies = 0;
  for (const f of known) {
    if (have.has(f.name)) {
      const key = RE_PDF.test(f.name) ? keyOf(f) : null;
      if (key && !tried.has(key)) {
        tried.add(key);
        if (await doRestorePdf(f, key).catch(() => false)) {
          stats.restored++;
          restored.push(f.name);
          continue;
        }
      }
      inOrder++;
      continue;
    }
    const seen = sizes.get(f.name);
    if (seen?.includes(f.size)) {
      copies++; // тот же файл ещё раз (копия в другой папке)
      continue;
    }
    sizes.set(f.name, [...(seen ?? []), f.size]);
    fresh.push(f);
  }
  stats.duplicates = inOrder + copies;
  if (restored.length) notes.push(`Чертёж восстановлен: ${listNames(restored)} — файла не было в браузере, записан снова`);
  if (inOrder) notes.push(`Уже в заказе, пропущено: ${inOrder}`);
  if (copies) notes.push(`Одинаковые файлы в загрузке, пропущено: ${copies}`);
  const same = [...sizes].filter(([, v]) => v.length > 1);
  if (!fresh.length) return result();
  stats.files = fresh.length;

  const renamed: string[] = []; // документы с занятым именем: «text (2).txt»
  const addDoc = (d: AiDocument) => {
    const fileName = uniqueDocName(d.fileName, documents);
    if (fileName !== d.fileName) renamed.push(`«${fileName}»`);
    documents.push(fileName === d.fileName ? d : { ...d, fileName });
    stats.documents++;
  };
  const addedDxf: OrderPosition[] = [];
  const addedPdf: OrderPosition[] = [];
  const qty: QtyLine[] = [];
  const pdfNotes: string[] = [];
  for (let i = 0; i < fresh.length; i++) {
    const f = fresh[i];
    try {
      if (RE_PDF.test(f.name)) {
        stats.pdf++;
        const r = await doImportPdf(f, defaults);
        addedPdf.push(...r.positions);
        qty.push(...r.qty);
        pdfNotes.push(...r.notes);
        for (const d of r.documents ?? []) {
          addDoc(d);
          qty.push(...qtyLinesFromText(d.text)); // заявка/спецификация в PDF — и строками текста
        }
      } else if (RE_DXF.test(f.name)) {
        stats.dxf++;
        addedDxf.push(await doImportDxf(f, defaults));
      } else {
        stats.txt++;
        const text = clipText(decodeText(await f.arrayBuffer()), AI_LIMITS.documentChars);
        if (text) {
          addDoc({ fileName: f.name, text });
          qty.push(...qtyLinesFromText(text)); // заявка письмом: «БВС-305Х300.000 — 3 шт»
        } else pdfNotes.push(`${f.name}: пустой файл`);
      }
    } catch (e) {
      errors.push(`${f.name}: ${(e as Error).message}`);
    }
    onProgress?.({ done: i + 1, total: fresh.length, file: f.name });
    if (i % 10 === 9 || RE_PDF.test(f.name)) await tick(); // даём отрисоваться прогрессу
  }

  const byFile = (a: OrderPosition, b: OrderPosition) => (a.fileName ?? '').localeCompare(b.fileName ?? '', 'ru');
  addedDxf.sort(byFile);
  addedPdf.sort(byFile);
  const qtyLines = qty.filter((l, i) => qty.findIndex((x) => desigKey(x.designation) === desigKey(l.designation)) === i);
  qty.splice(0, qty.length, ...qtyLines);
  const m = mergeImports(ex.positions, addedDxf, addedPdf, qty);
  const before = new Set(ex.positions.map((p) => p.id));
  const addedIds = m.positions.filter((p) => !before.has(p.id)).map((p) => p.id);
  const addedSet = new Set(addedIds);

  // количество из заявок прошлых загрузок — новым позициям, где его нет
  let positions = m.positions;
  if (requestLines.length) {
    const byKey = new Map(requestLines.map((l) => [desigKey(l.designation), l.qty]));
    let n = 0;
    positions = positions.map((p) => {
      const q = addedSet.has(p.id) && p.guessed.qty ? byKey.get(desigKey(p.name)) : undefined;
      if (!q) return p;
      n++;
      return { ...p, qty: q, guessed: { ...p.guessed, qty: false } };
    });
    if (n) notes.push(`Количество из ранее загруженной заявки проставлено у ${n} поз.`);
  }
  // заявка, вставленная текстом раньше файлов: количество — позициям, где его нет в файлах
  const fromRequest = applyRequestQty(positions, qtyLinesFromText(ex.request ?? ''));
  if (fromRequest.applied) {
    positions = fromRequest.positions;
    notes.push(`Количество из текста заявки проставлено у ${fromRequest.applied} поз.`);
  }
  for (const l of qty) {
    const k = desigKey(l.designation);
    const i = requestLines.findIndex((x) => desigKey(x.designation) === k);
    if (i >= 0) requestLines[i] = l;
    else requestLines.push(l);
  }

  if (same.length) {
    const what = listNames(same.map(([n, v]) => `${n} ×${v.length}`));
    notes.push(`Одинаковые имена файлов: ${what} — это разные файлы, прочитаны все${renamed.length ? `; документы названы ${listNames(renamed)}` : ''}`);
  }

  const added = [...addedDxf, ...addedPdf];
  stats.parts = added.length;
  stats.pdfParts = addedPdf.length;
  stats.guessed = added.filter((p) => p.guessed.material || p.guessed.thickness).length;
  stats.noQty = positions.filter((p) => addedSet.has(p.id) && !p.disabled && p.guessed.qty).length;
  if (added.length) notes.push(`Обработано ${added.length} ${plural(added.length, 'деталь', 'детали', 'деталей')}${addedPdf.length ? `, из них по PDF: ${addedPdf.length}` : ''}`);
  if (stats.documents) notes.push(`Документов для анализа: ${stats.documents} (заявки, спецификации, тексты)`);
  notes.push(...m.notes);
  warnings.push(...pdfNotes);
  if (stats.guessed) warnings.push(`У ${stats.guessed} поз. материал или толщина не распознаны — подсвечены`);
  if (stats.noQty) notes.push(`Количество не указано у ${stats.noQty} поз. — стоит 1 шт, поле подсвечено`);
  return { positions, documents, requestLines, addedIds, notes, warnings, errors, stats };
}

/** Пояснение для этапа «Файлы → данные» */
export function filesDetail(r: ParseResult, totalPositions = r.positions.length): string {
  const parts = [`${totalPositions} ${plural(totalPositions, 'позиция', 'позиции', 'позиций')}`];
  const docs = r.documents.length;
  if (docs) parts.push(`${docs} ${plural(docs, 'документ', 'документа', 'документов')}`);
  if (r.errors.length) parts.push(`не прочитано файлов: ${r.errors.length}`);
  return parts.join(', ');
}

// ---------- 2. цены mc.ru ----------

export interface PricesStageResult extends EnsurePricesResult {
  status: StageStatus;
  detail: string;
}

/** Обновляет устаревшие цены пар заказа (не дольше settings.priceMaxAgeHours); не бросает исключений */
export async function pricesStage(input: {
  positions: OrderPosition[];
  book: PriceBook;
  settings: Settings;
  live: boolean;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}): Promise<PricesStageResult> {
  const pairs = orderPairs(input.positions);
  const r = await ensurePrices({ book: input.book, pairs, maxAgeHours: input.settings.priceMaxAgeHours ?? 24, live: input.live, signal: input.signal, onProgress: input.onProgress });
  let detail: string;
  if (!pairs.length) detail = 'Нет позиций для расчёта';
  else if (r.skipped) detail = r.reason ?? 'Цены не обновлены';
  else if (!r.stale.length) detail = `Цены свежие (${pairs.length} ${plural(pairs.length, 'толщина', 'толщины', 'толщин')})`;
  else if (r.refreshed) detail = `Обновлено с mc.ru: ${r.refreshed} из ${r.stale.length}${r.reason ? ` — ${r.reason}` : ''}`;
  else detail = `Нет на mc.ru: ${r.stale.length} — цена по ближайшей толщине или по умолчанию`;
  return { ...r, status: r.skipped ? 'skipped' : 'done', detail };
}

// ---------- 3. анализ ИИ ----------

export interface AiStageResult {
  status: StageStatus; // done / skipped (не настроен, нет позиций, остановлен) / error
  detail: string;
  ai: AiState | null; // новое состояние для order.ai (null — анализа нет)
  error?: string; // текст ошибки для показа
  server: AiServerStatus;
  ctx?: AiContext; // что отправлено (для отладки и «что видел ИИ»)
  images: number;
  durationMs: number;
}

/**
 * Анализ ИИ заказа. Контекст строится по базовым позициям; предложения по умолчанию применяются
 * по политике defaultAccepted. signal — «Показать расчёт без ИИ»: этап становится «пропущен».
 */
export async function aiStage(input: {
  order: Order;
  book: PriceBook;
  settings: Settings;
  signal?: AbortSignal;
  onJob?: (s: AiJobState) => void;
  status?: AiServerStatus; // уже известный статус сервера
  images?: boolean; // отправлять изображения чертежей модели со зрением (по умолчанию да)
}): Promise<AiStageResult> {
  const t0 = Date.now();
  const server = input.status ?? (await aiStatus(input.signal));
  const base = { server, ai: null, images: 0 };
  const done = (status: StageStatus, detail: string, extra: Partial<AiStageResult> = {}): AiStageResult => ({ ...base, status, detail, durationMs: Date.now() - t0, ...extra });
  if (!server.configured) return done('skipped', 'ИИ-анализ недоступен: на сервере не настроена модель (или открыта статическая версия)');
  if (!input.order.positions.some((p) => !p.disabled && p.qty > 0)) return done('skipped', 'Нет позиций для анализа');
  try {
    let refs: Awaited<ReturnType<typeof drawingImages>> = { refs: [], blobs: [] };
    if (server.vision && input.images !== false && typeof document !== 'undefined') {
      try {
        refs = await drawingImages(input.order.positions);
      } catch {
        /* без изображений */
      }
    }
    if (input.signal?.aborted) throw new AiError('Анализ ИИ остановлен', 'aborted');
    const ctx = buildAiContext(input.order, null, input.book, input.settings, { images: refs.refs });
    const hash = contextHash(ctx);
    const analysis = await analyzeOrder(ctx, refs.blobs, { signal: input.signal, onState: input.onJob });
    const ai = aiStateFrom(analysis, input.order.positions, hash);
    const n = analysis.positions.filter((p) => p.status !== 'ok').length;
    const sec = Math.round(analysis.durationMs / 1000);
    return done('done', `${analysis.model} · ${sec} с${n ? ` · требуют внимания: ${n}` : ''}`, { ai, ctx, images: refs.refs.length });
  } catch (e) {
    const err = e instanceof AiError ? e : new AiError(`Ошибка ИИ-анализа: ${(e as Error).message}`, 'failed');
    if (err.code === 'aborted') return done('skipped', 'Пропущен — показан расчёт без ИИ');
    return done('error', err.message, { error: err.message });
  }
}

/** Анализ устарел: контекст текущего заказа отличается от того, что видел ИИ */
export function aiOutdated(order: Order, book: PriceBook, settings: Settings, baseRes: OrderResult | null = null): boolean {
  if (!order.ai) return false;
  return isOutdated(order.ai, contextHash(buildAiContext(order, baseRes, book, settings)));
}

// ---------- 4. расчёт ----------

/** Расчёт заказа с применёнными предложениями ИИ */
export function computeQuote(order: Order, book: PriceBook, settings: Settings): { positions: OrderPosition[]; res: OrderResult } {
  const positions = effectivePositions(order.positions, order.ai);
  return { positions, res: computeOrder(positions, book, orderSettings(order, settings)) };
}

/** Итог для списка этапов; client — суммы КП (цены за шт округлены как в КП, те же, что в итоге на экране) */
export function calcDetail(res: OrderResult, client?: { total: number; cost: number; revenue: number }): string {
  const T = res.totals;
  const c = client ?? { total: T.total, cost: T.cost, revenue: T.total - T.cost };
  return `Себестоимость ${rub0(c.cost)} · цена клиенту ${rub0(c.total)} · выручка ${rub0(c.revenue)}`;
}

// ---------- всё вместе: цены → ИИ → расчёт ----------

export interface QuoteInput {
  order: Order; // после parseFiles (позиции уже в заказе)
  book: PriceBook;
  settings: Settings;
  live: boolean; // есть API сервера
}

export interface QuoteCallbacks {
  stages?: Stages; // начальное состояние (например, с завершённым этапом «Файлы»)
  onStages?: (s: Stages) => void;
  onBook?: (b: PriceBook) => void; // цены обновились — можно сразу показать
  onJob?: (s: AiJobState) => void; // ход задачи ИИ: очередь, время, модель
  signal?: AbortSignal; // отмена всего
  aiSignal?: AbortSignal; // «Показать расчёт без ИИ» — только пропуск анализа
  aiStatus?: AiServerStatus;
  images?: boolean;
}

export interface QuoteResult {
  book: PriceBook;
  ai: AiState | null; // записать в order.ai (null — анализа нет; старый анализ лучше убрать)
  aiResult: AiStageResult;
  prices: PricesStageResult;
  stages: Stages;
  positions: OrderPosition[]; // позиции для расчёта (с принятыми предложениями)
  res: OrderResult;
}

/** Этапы 2–4 для заказа, в который уже добавлены файлы */
export async function runQuote(input: QuoteInput, cb: QuoteCallbacks = {}): Promise<QuoteResult> {
  let stages = cb.stages ?? updateStage(initialStages(), 'files', 'done', `${input.order.positions.length} ${plural(input.order.positions.length, 'позиция', 'позиции', 'позиций')}`);
  const set = (id: StageId, status: StageStatus, detail?: string) => {
    stages = updateStage(stages, id, status, detail);
    cb.onStages?.(stages);
  };

  set('prices', 'running', 'Проверяю свежесть цен…');
  const prices = await pricesStage({
    positions: input.order.positions,
    book: input.book,
    settings: input.settings,
    live: input.live,
    signal: cb.signal,
    onProgress: (d, t) => set('prices', 'running', `Обновляю цены mc.ru: ${d} из ${t}`),
  });
  let book = prices.book;
  if (book !== input.book) cb.onBook?.(book);
  set('prices', prices.status, prices.detail);

  set('ai', 'running', 'Готовлю данные для ИИ…');
  const signal = cb.aiSignal && cb.signal ? AbortSignal.any([cb.aiSignal, cb.signal]) : (cb.aiSignal ?? cb.signal);
  const aiResult = await aiStage({
    order: { ...input.order, ai: undefined },
    book,
    settings: input.settings,
    signal,
    status: cb.aiStatus,
    images: cb.images,
    onJob: (s) => {
      cb.onJob?.(s);
      if (s.status === 'waiting') set('ai', 'running', `Отправляю чертежи: ${s.imagesReceived} из ${s.imagesExpected}`);
      else if (s.status === 'queued') set('ai', 'running', `В очереди: ${s.position}`);
      else if (s.status === 'running') set('ai', 'running', `Анализирует ${s.model ?? 'модель'} · ${Math.round(s.elapsedMs / 1000)} с`);
    },
  });
  set('ai', aiResult.status, aiResult.detail);

  set('calc', 'running', 'Считаю…');
  const order: Order = { ...input.order, ai: aiResult.ai ?? undefined };
  let positions = effectivePositions(order.positions, order.ai);
  // ИИ поменял материал или толщину — цены новых пар тоже проверяем
  const known = new Set(orderPairs(input.order.positions).map(([m, t]) => pairKey(m, t)));
  const extra = orderPairs(positions).filter(([m, t]) => !known.has(pairKey(m, t)));
  if (extra.length && !prices.skipped && !cb.signal?.aborted) {
    const more = await ensurePrices({ book, pairs: extra, maxAgeHours: input.settings.priceMaxAgeHours ?? 24, live: input.live, signal: cb.signal });
    if (more.book !== book) {
      book = more.book;
      cb.onBook?.(book);
    }
  }
  positions = effectivePositions(order.positions, order.ai);
  const res = computeOrder(positions, book, orderSettings(order, input.settings));
  set('calc', 'done', calcDetail(res));
  return { book, ai: aiResult.ai, aiResult, prices, stages, positions, res };
}
