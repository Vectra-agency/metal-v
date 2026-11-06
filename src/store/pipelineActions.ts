// Конвейер в интерфейсе: файлы → цены mc.ru → анализ ИИ → расчёт (ui-spec §4.5–4.6).
// Разборы файлов идут по очереди (parseChain). Запуск этапов «цены → ИИ» один: новый запуск отменяет прежний
// (seq + AbortController, задача ИИ на сервере удаляется). Запуск отменяется, только если разбор принёс новое.
// «Показать расчёт без ИИ» задачу не отменяет: поздний результат ждёт решения (ai.pending), числа не меняются.
// «Отменить анализ» — abort → analyzeOrder сам шлёт DELETE /api/ai/jobs/<id>.
import { toast } from 'sonner';
import { aiStateFrom, appliedCount, isApplicable, pendingOffers } from '../ai/apply.ts';
import { aiStatus } from '../ai/api.ts';
import { buildAiContext, contextHash } from '../ai/context.ts';
import type { AiAnalysis, AiJobState, AiServerStatus } from '../core/ai.ts';
import { elapsed, hhmm, plural, signedRub } from '../format.ts';
import { deleteFiles, heldFileKeys, holdFiles, holdTabLock, otherTabsAlive, sweepFiles } from '../idb.ts';
import { EMPTY_BOOK, emptyOrder, fetchPrices, orderFileKeys, type Order, type OrderPosition } from '../order.ts';
import {
  aiStage,
  calcDetail,
  importDefaults,
  initialStages,
  parseFiles,
  pricesStage,
  STAGE_ORDER,
  updateStage,
  type AiStageResult,
  type ParseResult,
  type StageId,
  type Stages,
  type StageStatus,
} from '../pipeline.ts';
import { ensurePrices, orderPairs, pairKey, stalePairs, type EnsurePricesResult, type Pair } from '../prices.ts';
import { applyRequestQty, qtyLinesFromText } from '../requestQty.ts';
import { isJunkFile, skipHints } from '../components/shell/skipHints.ts';
import { appendJournal, openSheet, setAiCardOpen } from './actions.ts';
import { getDerived } from './derived.tsx';
import { getState, initialAi, initialPipeline, patchAi, patchPipeline, patchPrices, setOrder, setState } from './store.ts';
import type { AppState } from './types.ts';
import { newOrderEpoch, restoreOrderEpoch, undoToast } from './undo.ts';

const MIN_PROCESSING_MS = 1000; // экран обработки не мелькает: пропущенные этапы видны ~1 с
const ANTIBOT_BLOCK_MS = 15 * 60_000; // mc.ru попросил «я не робот» — не обновлять 15 минут
const RESTART_DEBOUNCE_MS = 1500; // вставка заявки во время анализа: перезапуск после паузы ввода
const NO_AI: AiServerStatus = { configured: false, model: null, vision: false };

let booted: Promise<void> | null = null;
let parseChain: Promise<void> = Promise.resolve(); // разборы файлов — строго по очереди
let pricesCtl: AbortController | null = null;
let aiCtl: AbortController | null = null;
let seq = 0; // номер последнего запуска этапов; у отменённых запусков номер меньше
let activeRun = 0; // идущий запуск (0 — нет)
let restarting = false; // abort задачи ИИ — ради перезапуска с заявкой, а не отмена
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let processingSince = 0;
let orderGen = 0; // «Новый заказ» и «Вернуть» меняют поколение: разбор старого заказа не пишет в новый

/** Работа с файлами в очереди разборов: удаление PDF не обгоняет разбор, который их ещё записывает в заказ */
function queueFiles(fn: () => Promise<unknown>): void {
  parseChain = parseChain.then(fn).then(
    () => {},
    () => {},
  );
}

/** При старте: PDF, на которые не ссылается заказ. Открыта другая вкладка — не трогаем: там может быть другой заказ */
async function sweepOrphans(): Promise<void> {
  if (await otherTabsAlive()) return;
  await sweepFiles(orderFileKeys(getState().order));
}

/** PDF прежнего заказа, которые больше не нужны: кроме ссылок нынешнего заказа, живых снимков «Вернуть» и других вкладок */
async function dropOrderFiles(prev: Order): Promise<void> {
  if (await otherTabsAlive()) return;
  const keep = orderFileKeys(getState().order);
  const held = heldFileKeys();
  await deleteFiles([...orderFileKeys(prev)].filter((k) => !keep.has(k) && !held.has(k)));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function setStage(id: StageId, status: StageStatus, detail?: string): void {
  patchPipeline({ stages: updateStage(getState().pipeline.stages, id, status, detail) });
}

/** Новые подробности идущего этапа — без сброса времени начала */
function setDetail(id: StageId, detail: string): void {
  const stages = getState().pipeline.stages;
  if (stages[id].status !== 'running' || stages[id].detail === detail) return;
  patchPipeline({ stages: { ...stages, [id]: { ...stages[id], detail } } });
}

/** Модель без префикса поставщика: «anthropic/claude-haiku-5.5» → «claude-haiku-5.5» */
export const shortModel = (m: string | null | undefined): string => (m ? (m.split('/').pop() ?? m) : 'модель');

/** Что сейчас делает задача ИИ (ui-spec §2.5): для списка этапов, пилюли и карточки ИИ */
export function jobDetail(job: AiJobState | null, startedAt: number, model: string | null, now: number = Date.now()): string {
  if (!job) return 'Готовлю данные для ИИ…';
  if (job.status === 'waiting') return `Отправляю чертежи: ${job.imagesReceived} из ${job.imagesExpected}`;
  if (job.status === 'queued') return `В очереди, место ${job.position}`;
  if (job.status === 'running') return `${shortModel(job.model ?? model)} · ${elapsed(now - startedAt)} · обычно 20–60 с`;
  return 'Получаю ответ ИИ…';
}

// ---------- старт ----------

/** Старт приложения (один раз): цены (API сервера или снимок) и статус ИИ на сервере */
export function bootstrap(): Promise<void> {
  booted ??= (async () => {
    holdTabLock(); // замок вкладки — на всю её жизнь (не ждём)
    queueFiles(sweepOrphans); // PDF, на которые больше никто не ссылается
    const [prices, status] = await Promise.allSettled([fetchPrices(), aiStatus()]);
    if (prices.status === 'fulfilled') patchPrices({ book: prices.value.book, live: prices.value.live, loaded: true, busy: null });
    else {
      patchPrices({ book: EMPTY_BOOK, live: false, loaded: true, busy: null });
      toast.error('Не удалось загрузить цены — используются цены по умолчанию');
    }
    const live = getState().prices.live;
    patchAi({ server: live && status.status === 'fulfilled' ? status.value : NO_AI });
  })();
  return booted;
}

/** Закрытие вкладки: задачу ИИ снять с сервера (DELETE с keepalive) */
export function abortOnPageHide(): void {
  aiCtl?.abort();
}

// ---------- 1. файлы ----------

/** Файлы в заказ: разбор → (если есть новое) цены → ИИ → расчёт. mode 'new' — сначала «Новый заказ» */
export async function addFiles(files: File[], opts: { mode?: 'append' | 'new'; folderName?: string } = {}): Promise<void> {
  const list = files.filter((f) => !isJunkFile(f.name));
  if (!list.length) {
    if (files.length) toast('Нет файлов для расчёта — нужны DXF, PDF или TXT');
    return;
  }
  await bootstrap();
  if (opts.mode === 'new' && getState().order.positions.length) startNewOrder();
  const job = parseChain.then(() => parseAndRun(list, opts.folderName));
  parseChain = job.catch(() => {});
  return job;
}

const isRedundant = (text: string) => text.startsWith('Пропущено файлов (не DXF, PDF или TXT)') || text.startsWith('Архивы (');

/** Позиции разбора поверх правок, сделанных во время чтения файлов (удалённые не возвращаем, правки не теряем) */
function mergeParsed(snap: OrderPosition[], parsed: OrderPosition[], cur: OrderPosition[]): OrderPosition[] {
  if (cur === snap) return parsed;
  const was = new Map(snap.map((p) => [p.id, p]));
  const now = new Map(cur.map((p) => [p.id, p]));
  const out: OrderPosition[] = [];
  for (const p of parsed) {
    const old = was.get(p.id);
    if (!old) out.push(p);
    else if (now.has(p.id)) out.push(old === p ? now.get(p.id)! : p);
  }
  const ids = new Set(out.map((p) => p.id));
  for (const p of cur) if (!was.has(p.id) && !ids.has(p.id)) out.push(p);
  return out;
}

const nFiles = (n: number) => `${n} ${plural(n, 'файл', 'файла', 'файлов')}`;
const nPositions = (n: number) => `${n} ${plural(n, 'позиция', 'позиции', 'позиций')}`;
const nDocs = (n: number) => `${n} ${plural(n, 'документ', 'документа', 'документов')}`;

/** «12 файлов → 6 позиций, 1 документ · пропущено 2 · уже в заказе 1» (ui-spec §4.6.2) */
function filesStageDetail(files: number, r: ParseResult, skipped: number): string {
  const added = r.addedIds.length;
  let s = `${nFiles(files)} → ${nPositions(added)}`;
  if (r.stats.documents) s += `, ${nDocs(r.stats.documents)}`;
  if (r.errors.length) s += `, не прочитано: ${r.errors.length}`;
  if (skipped) s += ` · пропущено ${skipped}`;
  if (r.stats.duplicates) s += ` · уже в заказе ${r.stats.duplicates}`;
  if (r.stats.restored) s += ` · восстановлено чертежей: ${r.stats.restored}`;
  return s;
}

const showJournal = { label: 'Подробнее', onClick: () => openSheet({ kind: 'request', section: 'journal' }) };

async function parseAndRun(files: File[], folderName?: string): Promise<void> {
  const gen = orderGen;
  const s0 = getState();
  const before = s0.order;
  const wasEmpty = !before.positions.length;
  const processing = wasEmpty || s0.pipeline.processing;
  if (processing && !s0.pipeline.processing) processingSince = Date.now();
  // заказ был пуст — этапы с начала; иначе прежний запуск пока идёт, меняется только «Файлы»
  const stages0 = wasEmpty ? initialStages() : s0.pipeline.stages;
  patchPipeline({
    busy: true,
    processing,
    emptyResult: false,
    parse: { done: 0, total: files.length, file: '' },
    stages: updateStage(stages0, 'files', 'running', 'Читаю файлы…'),
  });
  // название — сразу (экран обработки: «Расчёт заказа «{папка}»»)
  if (folderName && !before.title.trim()) setOrder((o) => (o.title.trim() ? o : { ...o, title: folderName }));
  const hints = skipHints(files);
  appendJournal(hints.entries);

  let r: ParseResult;
  try {
    const ex = { positions: before.positions, documents: before.documents ?? [], requestLines: before.requestLines ?? [], request: before.request ?? '' };
    r = await parseFiles(files, ex, importDefaults(before.positions), (p) => gen === orderGen && patchPipeline({ parse: p }));
  } catch (e) {
    if (gen !== orderGen) return;
    const msg = `Не удалось прочитать файлы: ${(e as Error).message}`;
    appendJournal([{ level: 'error', text: msg }]);
    patchPipeline({
      parse: null,
      busy: activeRun !== 0,
      processing: getState().pipeline.processing && activeRun !== 0,
      stages: updateStage(getState().pipeline.stages, 'files', 'error', msg),
    });
    toast.error(msg);
    return;
  }

  if (gen !== orderGen) {
    // пока читали, начат новый заказ или возвращён прежний — этот разбор уже не к месту
    patchPipeline({ parse: null, busy: activeRun !== 0 });
    return;
  }
  const positions = mergeParsed(before.positions, r.positions, getState().order.positions);
  setOrder((o) => ({ ...o, positions, documents: r.documents, requestLines: r.requestLines, title: o.title || folderName || '' }));
  appendJournal([
    ...r.errors.map((text) => ({ level: 'error' as const, text })),
    ...r.warnings.filter((t) => !isRedundant(t)).map((text) => ({ level: 'warn' as const, text })),
    ...r.notes.filter((t) => !isRedundant(t)).map((text) => ({ level: 'info' as const, text })),
  ]);

  const added = r.addedIds.length;
  const newDocs = r.stats.documents;
  const status: StageStatus = r.errors.length && !added && !newDocs ? 'error' : 'done';
  const detail = filesStageDetail(files.length, r, hints.count);

  // уведомления (ui-spec §2.17); на первом запуске итог виден на экране обработки
  if (!wasEmpty && (added || newDocs)) {
    const what = added ? `${plural(added, 'Добавлена', 'Добавлено', 'Добавлено')} ${nPositions(added)}${newDocs ? `, ${nDocs(newDocs)}` : ''}` : `${plural(newDocs, 'Добавлен', 'Добавлено', 'Добавлено')} ${nDocs(newDocs)}`;
    toast.success(what);
  }
  // PDF, которого не было в браузере, записан снова (позиция та же) — вместо «Новых файлов нет»
  if (r.stats.restored) toast.success(r.stats.restored > 1 ? `Чертежи восстановлены: ${r.stats.restored}` : 'Чертёж восстановлен');
  else if (!added && !newDocs && r.stats.duplicates) toast.info(`Новых файлов нет: уже в заказе ${r.stats.duplicates}`);
  if (hints.count) toast(`${plural(hints.count, 'Пропущен', 'Пропущено', 'Пропущено')} ${nFiles(hints.count)}`, { action: showJournal });
  if (r.errors.length) toast.error(`Не удалось прочитать ${nFiles(r.errors.length)}`, { action: showJournal });

  const cur = getState();
  if (!cur.order.positions.length) {
    // чертежей нет (projects/1): документы сохранены, цены и ИИ не запускаем
    patchPipeline({ parse: null, busy: false, processing: false, emptyResult: true, addedIds: [], stages: updateStage(cur.pipeline.stages, 'files', status, detail) });
    return;
  }
  if (!wasEmpty && !added && !newDocs) {
    // ничего нового — идущий расчёт и анализ не трогаем
    patchPipeline({ parse: null, busy: activeRun !== 0, stages: updateStage(cur.pipeline.stages, 'files', status, detail) });
    return;
  }
  abortRuns();
  patchPipeline({
    parse: null,
    detached: false,
    addedIds: wasEmpty ? [] : r.addedIds,
    stages: updateStage({ ...initialStages(), files: getState().pipeline.stages.files }, 'files', status, detail),
  });
  void runStages();
}

// ---------- 2–4. цены → ИИ → расчёт ----------

/** Отменить идущий запуск этапов (новый запуск, «Новый заказ») */
function abortRuns(): void {
  seq++;
  activeRun = 0;
  pricesCtl?.abort();
  aiCtl?.abort();
  pricesCtl = aiCtl = null;
  clearRestart();
  if (getState().ai.run) patchAi({ run: null });
}

function clearRestart(): void {
  restarting = false;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = null;
}

/** Итог обновления цен: причина сбоя (и блокировка после «я не робот») или сброс прошлого сбоя */
function notePriceResult(r: EnsurePricesResult, live: boolean): void {
  if (!live) return; // статическая версия: снимок цен — не сбой
  const now = Date.now();
  if (r.reason) {
    const antiBot = /не робот|check-human/i.test([r.reason, ...r.errors].join(' '));
    patchPrices({ issue: { at: now, reason: r.reason, errors: r.errors }, ...(antiBot ? { blockedUntil: now + ANTIBOT_BLOCK_MS } : {}) });
  } else patchPrices({ issue: null });
}

async function runStages(): Promise<void> {
  const id = ++seq;
  activeRun = id;
  patchPipeline({ runId: id, busy: true });
  await pricesStep(id);
  if (id !== seq) return;
  await aiStep(id);
  if (id === seq) await finish(id);
}

/** 1. цены mc.ru: только устаревшие пары заказа; после «я не робот» mc.ru 15 минут не трогаем */
async function pricesStep(id: number): Promise<void> {
  const current = () => id === seq;
  const s1 = getState();
  const blockedUntil = s1.prices.blockedUntil ?? 0;
  if (s1.prices.live && blockedUntil > Date.now()) {
    setStage('prices', 'skipped', `mc.ru просил проверку «я не робот» — обновление отложено до ${hhmm(blockedUntil)}, взяты сохранённые цены`);
    return;
  }
  const maxAge = s1.settings.priceMaxAgeHours ?? 24;
  const stale = s1.prices.live ? stalePairs(s1.prices.book, orderPairs(s1.order.positions), maxAge).length : 0;
  const progress = (d: number, t: number) => `Обновляю цены mc.ru: ${d} из ${t}, обычно до 10 с`;
  setStage('prices', 'running', stale ? progress(0, stale) : 'Проверяю свежесть цен…');
  const ownBusy = stale > 0 && !s1.prices.busy;
  if (ownBusy) patchPrices({ busy: `Обновляю цены mc.ru: 0 из ${stale}` });
  const ctl = new AbortController();
  pricesCtl = ctl;
  const pr = await pricesStage({
    positions: s1.order.positions,
    book: s1.prices.book,
    settings: s1.settings,
    live: s1.prices.live,
    signal: ctl.signal,
    onProgress: (d, t) => {
      if (!current()) return;
      setDetail('prices', progress(d, t));
      if (ownBusy) patchPrices({ busy: `Обновляю цены mc.ru: ${d} из ${t}` });
    },
  });
  if (pricesCtl === ctl) pricesCtl = null;
  if (ownBusy) patchPrices({ busy: null });
  if (!current()) return;
  if (pr.book !== s1.prices.book) patchPrices({ book: pr.book });
  notePriceResult(pr, s1.prices.live);
  setStage('prices', pr.status, pr.detail);
}

/** 3. расчёт (сам расчёт — в derived; здесь итог для списка этапов) и выход с экрана обработки */
async function finish(id: number): Promise<void> {
  const current = () => id === seq;
  setStage('calc', 'running', 'Считаю…');
  const d = getDerived();
  setStage('calc', 'done', calcDetail(d.res, d.quote));
  const st = getState().pipeline;
  if (st.processing && (st.stages.prices.status === 'skipped' || st.stages.ai.status === 'skipped')) {
    const left = processingSince + MIN_PROCESSING_MS - Date.now();
    if (left > 0) await sleep(left);
    if (!current()) return;
  }
  activeRun = 0;
  patchPipeline({ busy: false, processing: false });
  if (getState().ai.run) patchAi({ run: null });
}

async function aiStep(id: number): Promise<void> {
  const current = () => id === seq;
  let server = getState().ai.server;
  if (!server) {
    server = getState().prices.live ? await aiStatus() : NO_AI;
    if (!current()) return;
    patchAi({ server });
  }
  if (!server.configured) {
    const reason = getState().prices.live ? 'ИИ не подключён на сервере' : 'Без сервера (статическая версия)';
    patchAi({ outcome: { kind: 'skipped', reason, canRun: false }, run: null });
    setStage('ai', 'skipped', reason);
    return;
  }
  let restarted = false;
  for (;;) {
    const ctl = new AbortController();
    aiCtl = ctl;
    restarting = false;
    const s = getState();
    const startedAt = Date.now();
    patchAi({ run: { id, startedAt, job: null, requestAtStart: s.order.request ?? '', restarted } });
    if (restarted) setDetail('ai', jobDetail(null, startedAt, server.model));
    else setStage('ai', 'running', jobDetail(null, startedAt, server.model));
    const model = server.model;
    const r = await aiStage({
      order: { ...s.order, ai: undefined },
      book: s.prices.book,
      settings: s.settings,
      signal: ctl.signal,
      status: server,
      onJob: (job) => {
        const run = getState().ai.run;
        if (!current() || !run || ctl.signal.aborted) return;
        patchAi({ run: { ...run, job } });
        setDetail('ai', jobDetail(job, run.startedAt, model));
      },
    });
    if (aiCtl === ctl) aiCtl = null;
    if (!current()) return;
    if (r.status === 'skipped' && ctl.signal.aborted) {
      if (restarting && !restarted) {
        // заявку вставили во время анализа: один перезапуск, уже с заявкой
        restarted = true;
        continue;
      }
      clearRestart();
      patchAi({ outcome: { kind: 'cancelled' }, run: null });
      setStage('ai', 'skipped', 'Анализ отменён');
      return;
    }
    clearRestart();
    if (r.status === 'skipped') {
      patchAi({ outcome: { kind: 'skipped', reason: 'Нет позиций для анализа', canRun: false }, run: null });
      setStage('ai', 'skipped', 'Нет позиций для анализа');
      return;
    }
    if (r.status === 'error' || !r.ai) {
      const message = r.error ?? r.detail;
      patchAi({ outcome: { kind: 'error', message }, run: null });
      setStage('ai', 'error', message);
      return;
    }
    receive(r);
    setStage('ai', 'done', r.detail);
    return;
  }
}

const countOf = (n: number, one: string, few: string, many: string) => `${n} ${plural(n, one, few, many)}`;

/** «Анализ ИИ готов: 1 проблема, 3 замечания, 5 предложений» */
export function readyText(a: AiAnalysis): string {
  const p = a.positions.filter((r) => r.status === 'problem').length;
  const c = a.positions.filter((r) => r.status === 'check').length;
  const sg = a.positions.reduce((n, r) => n + r.suggestions.filter(isApplicable).length, 0);
  const parts: string[] = [];
  if (p) parts.push(countOf(p, 'проблема', 'проблемы', 'проблем'));
  if (c) parts.push(countOf(c, 'замечание', 'замечания', 'замечаний'));
  if (sg) parts.push(countOf(sg, 'предложение', 'предложения', 'предложений'));
  return `Анализ ИИ готов: ${parts.length ? parts.join(', ') : 'замечаний нет'}`;
}

/** Показать карточку ИИ (поздний результат): развернуть, если пользователь её свернул, и прокрутить */
function revealAiCard(): void {
  if (getState().ui.aiCardOpen === false) setAiCardOpen(true);
  requestAnimationFrame(() => document.getElementById('ai-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

/** Результат ИИ пришёл. Заказ не менялся и расчёт не отвязан — применить с переносом решений; иначе — ждёт решения */
function receive(r: AiStageResult): void {
  const ai = r.ai!;
  const ctx = r.ctx ?? null;
  const startHash = ai.contextHash;
  const scope = ctx ? ctx.positions.map((p) => p.id) : [];
  const s = getState();
  patchAi({ lastImages: r.images, outcome: { kind: 'done', at: Date.now() }, run: null });
  const nowHash = contextHash(buildAiContext(s.order, getDerived().baseRes, s.prices.book, s.settings));
  const late = s.pipeline.detached || nowHash !== startHash;
  if (late) {
    patchAi({ pending: { analysis: ai.analysis, contextHash: startHash, scope, ctx, receivedAt: Date.now() } });
    toast(readyText(ai.analysis), { action: { label: 'Показать', onClick: revealAiCard } });
    return;
  }
  const before = getDerived().quote.total;
  const prev = s.order.ai;
  setOrder((o) => ({ ...o, ai: aiStateFrom(ai.analysis, o.positions, startHash, { prev }), aiScope: scope }));
  patchAi({ lastContext: ctx, pending: null });
  if (prev) {
    const o = getState().order;
    const n = appliedCount(o.ai, o.positions);
    const m = pendingOffers(o.ai, o.positions).length;
    toast(`Новый анализ ИИ: применено ${n} (${signedRub(getDerived().quote.total - before)}), ждут решения ${m}`);
  }
  ensureExtraPairs();
}

/** ИИ поменял материал или толщину — цены новых пар проверяем в фоне */
function ensureExtraPairs(): void {
  const known = new Set(orderPairs(getState().order.positions).map(([m, t]) => pairKey(m, t)));
  ensurePairsQuietly(orderPairs(getDerived().positions).filter(([m, t]) => !known.has(pairKey(m, t))));
}

function ensurePairsQuietly(pairs: Pair[]): void {
  const s = getState();
  if (!pairs.length || !s.prices.live || s.prices.busy || (s.prices.blockedUntil ?? 0) > Date.now()) return;
  const book = s.prices.book;
  void ensurePrices({ book, pairs, maxAgeHours: s.settings.priceMaxAgeHours ?? 24, live: true }).then((r) => {
    if (r.book !== book) patchPrices({ book: r.book });
    if (r.reason) notePriceResult(r, true);
  });
}

/** Устаревшие цены пар заказа — обновить в фоне (после «Детали без чертежа» с новой толщиной) */
export function ensureOrderPrices(): void {
  ensurePairsQuietly(orderPairs(getDerived().positions));
}

/** «Обновить анализ ИИ» / «Запустить анализ ИИ» / «Повторить»: цены → ИИ по текущему заказу */
export async function runAnalysis(): Promise<void> {
  await bootstrap();
  const s = getState();
  if (!s.order.positions.length) return;
  abortRuns();
  const files = s.pipeline.stages.files.status === 'done' ? s.pipeline.stages.files : updateStage(initialStages(), 'files', 'done', nPositions(s.order.positions.length)).files;
  patchPipeline({ detached: false, stages: { ...initialStages(), files } });
  await runStages();
}

/** «Отменить анализ»: abort → DELETE задачи на сервере; итог — «Анализ ИИ не выполнялся» */
export function cancelAnalysis(): void {
  clearRestart();
  aiCtl?.abort();
}

/** «Показать расчёт без ИИ»: результат сразу, анализ продолжается в фоне (его итог — ai.pending) */
export function showResultNow(): void {
  patchPipeline({ processing: false, detached: true });
}

/** Заявка клиента. Вставили во время анализа, начатого без заявки, — один перезапуск анализа (после паузы ввода) */
/** Количество из вставленной заявки — после паузы ввода, чтобы «1» из набираемого «10» не проставилось */
let requestQtyTimer: ReturnType<typeof setTimeout> | null = null;
const REQUEST_QTY_DEBOUNCE_MS = 700;

function applyRequestText(): void {
  const o = getState().order;
  const lines = qtyLinesFromText(o.request ?? '');
  const r = applyRequestQty(o.positions, lines);
  if (!r.applied) return;
  setOrder((cur) => ({ ...cur, positions: applyRequestQty(cur.positions, lines).positions }));
  toast.success(`Количество из заявки проставлено: ${r.applied} ${plural(r.applied, 'позиция', 'позиции', 'позиций')}`);
}

export function setRequest(text: string): void {
  setOrder((o) => (o.request === text ? o : { ...o, request: text }));
  if (requestQtyTimer) clearTimeout(requestQtyTimer);
  requestQtyTimer = setTimeout(() => {
    requestQtyTimer = null;
    applyRequestText();
  }, REQUEST_QTY_DEBOUNCE_MS);
  const s = getState();
  const run = s.ai.run;
  if (!run || run.restarted || run.requestAtStart.trim() || s.pipeline.stages.ai.status !== 'running' || !text.trim()) return;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    const st = getState();
    const r2 = st.ai.run;
    if (!r2 || r2.id !== run.id || r2.restarted || st.pipeline.stages.ai.status !== 'running' || !st.order.request?.trim()) return;
    restarting = true;
    aiCtl?.abort(); // задача снимается (DELETE), этап ИИ запускается заново уже с заявкой
  }, RESTART_DEBOUNCE_MS);
}

// ---------- поздний результат ----------

/** Применить с решениями по умолчанию (и перенесёнными из прежнего анализа) */
export function applyPendingAi(): void {
  const p = getState().ai.pending;
  if (!p) return;
  setOrder((o) => ({ ...o, ai: aiStateFrom(p.analysis, o.positions, p.contextHash, { prev: o.ai }), aiScope: p.scope }));
  patchAi({ pending: null, lastContext: p.ctx });
  ensureExtraPairs();
}

/** Показать, но решения — только перенесённые, остальное ждёт решения */
export function reviewPendingAi(): void {
  const p = getState().ai.pending;
  if (!p) return;
  setOrder((o) => ({ ...o, ai: aiStateFrom(p.analysis, o.positions, p.contextHash, { prev: o.ai, defaults: false }), aiScope: p.scope }));
  patchAi({ pending: null, lastContext: p.ctx });
  ensureExtraPairs();
}

/** Не применять поздний результат: карточка показывает прежнее состояние */
export function dismissPendingAi(): void {
  patchAi({ pending: null });
}

// ---------- цены ----------

/** «Обновить цены заказа»: все пары позиций расчёта, без учёта возраста цен */
export async function refreshPrices(): Promise<void> {
  await bootstrap();
  const s = getState();
  if (!s.prices.live || s.prices.busy || (s.prices.blockedUntil ?? 0) > Date.now()) return;
  const pairs = orderPairs(getDerived().positions);
  if (!pairs.length) return;
  const stage = !s.pipeline.busy; // во время запуска этапы ведёт сам запуск
  patchPrices({ busy: `Обновляю цены mc.ru: 0 из ${pairs.length}` });
  if (stage) setStage('prices', 'running', `Обновляю цены mc.ru: 0 из ${pairs.length}, обычно до 10 с`);
  const r = await ensurePrices({
    book: s.prices.book,
    pairs,
    maxAgeHours: 0,
    live: true,
    onProgress: (d, t) => patchPrices({ busy: `Обновляю цены mc.ru: ${d} из ${t}` }),
  });
  patchPrices(r.book !== s.prices.book ? { busy: null, book: r.book } : { busy: null });
  notePriceResult(r, true);
  const n = r.refreshed;
  const detail = r.skipped ? (r.reason ?? 'Цены не обновлены') : `Обновлено с mc.ru: ${n} из ${pairs.length}${r.reason ? ` — ${r.reason}` : ''}`;
  if (stage && !getState().pipeline.busy) setStage('prices', r.skipped ? 'skipped' : 'done', detail);
  if (r.skipped) toast.warning(r.reason ?? 'Цены не обновлены');
  else {
    toast.success(`Цены mc.ru обновлены: ${countOf(n, 'толщина', 'толщины', 'толщин')}`);
    if (r.reason) toast.warning(r.reason);
  }
}

// ---------- новый заказ ----------

/** Ход расчёта для «Вернуть»: этапы, прерванные «Новым заказом», — пропущены */
function settledStages(stages: Stages): Stages {
  let out = stages;
  for (const id of STAGE_ORDER) if (out[id].status === 'running') out = updateStage(out, id, 'skipped', 'Прервано: был начат новый заказ');
  return out;
}

/** «Новый заказ»: сразу, с «Вернуть» 15 с; PDF прежнего заказа удаляются, когда вернуть уже нельзя */
export function startNewOrder(): void {
  const s0 = getState();
  const prev = s0.order;
  // «Вернуть» возвращает и сессию: поздний результат ИИ, «Что видел ИИ», ход расчёта
  const session = {
    pending: s0.ai.pending,
    lastContext: s0.ai.lastContext,
    lastImages: s0.ai.lastImages,
    outcome: s0.ai.run ? ({ kind: 'cancelled' } as const) : s0.ai.outcome,
    stages: settledStages(s0.pipeline.stages),
  };
  const prevEpoch = newOrderEpoch();
  const release = holdFiles(orderFileKeys(prev)); // PDF прежнего заказа не удалит истечение другого «Новый заказ»
  orderGen++;
  abortRuns();
  const ui = (u: AppState['ui']): AppState['ui'] => ({ ...u, sheet: null, dialog: null, triage: null, selection: [], filter: 'all', search: '', highlight: null, flash: null });
  setState((s) => ({ ...s, order: emptyOrder(), pipeline: initialPipeline(), ai: initialAi(s.ai.server), ui: ui(s.ui) }));
  undoToast({
    message: 'Начат новый заказ',
    orderScoped: true, // после следующего «Новый заказ» этот уже не вернуть (сначала — его «Вернуть»)
    // прежний заказ — как был; расчёт и анализ нового заказа останавливаются
    undo: () => {
      release();
      restoreOrderEpoch(prevEpoch);
      orderGen++;
      abortRuns();
      const { stages, ...ai } = session;
      setState((s) => ({ ...s, order: prev, pipeline: { ...initialPipeline(), stages }, ai: { ...initialAi(s.ai.server), ...ai }, ui: ui(s.ui) }));
    },
    // чтение файлов нового заказа могло ещё не записать позиции — удаляем в очереди разборов, после него
    onExpire: () => {
      release();
      queueFiles(() => dropOrderFiles(prev));
    },
  });
}
