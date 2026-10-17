// Клиент ИИ-анализа: статус сервера и фоновая задача (создать → загрузить изображения → опрашивать).
// Долгий анализ идёт задачей, потому что nginx обрывает запросы дольше 60 с. Все ошибки — AiError
// с понятным пользователю текстом; без сервера (статическая версия) ИИ просто «не настроен».

import { AI_LIMITS, type AiAnalysis, type AiContext, type AiJobState, type AiServerStatus } from '../core/ai.ts';

export type AiErrorCode = 'network' | 'busy' | 'too_large' | 'unavailable' | 'timeout' | 'aborted' | 'lost' | 'failed' | 'server';

export class AiError extends Error {
  readonly code: AiErrorCode;
  readonly status?: number;
  constructor(message: string, code: AiErrorCode, status?: number) {
    super(message);
    this.name = 'AiError';
    this.code = code;
    this.status = status;
  }
}

export const POLL_MS = 1500;
/** Общий предел ожидания: очередь + ответ модели + попытка починить JSON */
export const ANALYSIS_TIMEOUT_MS = 8 * 60_000;

const NOT_CONFIGURED: AiServerStatus = { configured: false, model: null, vision: false };

const isJson = (r: Response) => (r.headers.get('content-type') ?? '').includes('json');

/** GET /api/ai/status; нет сервера или ИИ не настроен — { configured: false } */
export async function aiStatus(signal?: AbortSignal): Promise<AiServerStatus> {
  try {
    const t = AbortSignal.timeout(8000);
    const r = await fetch('/api/ai/status', { cache: 'no-store', signal: signal ? AbortSignal.any([signal, t]) : t });
    if (!r.ok || !isJson(r)) return NOT_CONFIGURED;
    const j = (await r.json()) as Partial<AiServerStatus>;
    return { configured: !!j.configured, model: typeof j.model === 'string' ? j.model : null, vision: !!j.vision };
  } catch {
    return NOT_CONFIGURED;
  }
}

function abortError(): AiError {
  return new AiError('Анализ ИИ остановлен', 'aborted');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((res, rej) => {
    if (signal?.aborted) return rej(abortError());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      res();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      rej(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Текст ошибки по коду ответа (сервер присылает свой текст в { error }) */
function httpError(status: number, serverText: string | undefined): AiError {
  const tail = serverText ? `: ${serverText}` : '';
  if (status === 429) return new AiError(serverText ?? 'Сервер ИИ сейчас занят или исчерпан лимит анализов — попробуйте через несколько минут', 'busy', status);
  if (status === 413) return new AiError(serverText ?? 'Слишком большой заказ для анализа ИИ — уменьшите число позиций или документов', 'too_large', status);
  if (status === 503) return new AiError(serverText ?? 'ИИ-анализ временно недоступен (не настроен на сервере)', 'unavailable', status);
  if (status === 404 || status === 405) return new AiError('На этом сервере нет ИИ-анализа (статическая версия)', 'unavailable', status);
  if (status === 502 || status === 504) return new AiError('Сервер не ответил вовремя — попробуйте ещё раз', 'network', status);
  if (status === 400 || status === 415) return new AiError(`Сервер ИИ не принял данные заказа${tail}`, 'server', status);
  return new AiError(`Ошибка сервера ИИ (${status})${tail}`, 'server', status);
}

/** Один запрос не дольше 65 с (nginx всё равно рвёт через 60 с) */
const REQUEST_TIMEOUT_MS = 65_000;

async function call(url: string, init: RequestInit): Promise<Response> {
  const user = init.signal ?? undefined;
  const timer = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { cache: 'no-store', ...init, signal: user ? AbortSignal.any([user, timer]) : timer });
  } catch (e) {
    if (user?.aborted) throw abortError();
    if (timer.aborted) throw new AiError('Сервер ИИ не ответил вовремя — проверьте связь и попробуйте ещё раз', 'network');
    if ((e as Error).name === 'AbortError') throw abortError();
    throw new AiError('Нет связи с сервером — проверьте интернет и попробуйте ещё раз', 'network');
  }
}

async function errorText(r: Response): Promise<string | undefined> {
  if (!isJson(r)) return undefined;
  try {
    const j = (await r.json()) as { error?: unknown };
    return typeof j.error === 'string' && j.error ? j.error : undefined;
  } catch {
    return undefined;
  }
}

function cancelJob(id: string) {
  // без ожидания: задача на сервере снимется, ответ не нужен
  fetch(`/api/ai/jobs/${encodeURIComponent(id)}`, { method: 'DELETE', keepalive: true }).catch(() => {});
}

export interface AnalyzeOptions {
  signal?: AbortSignal;
  onState?: (s: AiJobState) => void; // ожидание изображений, очередь, работа модели
  timeoutMs?: number;
  pollMs?: number; // для тестов
}

/**
 * Анализ заказа ИИ: POST /api/ai/jobs → PUT изображений по одному → опрос GET каждые ~1,5 с.
 * images[i] — JPEG для ctx.images[i]. При отмене (signal) задача на сервере удаляется.
 */
export async function analyzeOrder(ctx: AiContext, images: Blob[], opts: AnalyzeOptions = {}): Promise<AiAnalysis> {
  const { signal, onState } = opts;
  const poll = opts.pollMs ?? POLL_MS;
  if (signal?.aborted) throw abortError();
  if (images.length !== ctx.images.length) throw new AiError('Число изображений не совпадает с контекстом анализа', 'failed');
  const big = images.findIndex((b) => b.size > AI_LIMITS.imageBytes);
  if (big >= 0) throw new AiError(`Изображение чертежа «${ctx.images[big].caption}» слишком большое для отправки`, 'too_large');
  const body = JSON.stringify({ context: ctx });
  if (new TextEncoder().encode(body).length > AI_LIMITS.contextBytes + 1000) throw new AiError('Слишком большой заказ для анализа ИИ — уменьшите число позиций или документов', 'too_large', 413);

  const created = await call('/api/ai/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal });
  if (!created.ok || !isJson(created)) throw httpError(created.status, await errorText(created));
  const { jobId, imagesExpected } = (await created.json()) as { jobId?: string; imagesExpected?: number };
  if (!jobId) throw new AiError('Сервер ИИ не создал задачу анализа', 'server', created.status);
  // модель без зрения: сервер изображения не ждёт — не отправляем
  const upload = imagesExpected === 0 ? [] : images;
  const jobUrl = `/api/ai/jobs/${encodeURIComponent(jobId)}`;

  let finished = false;
  const onAbort = () => {
    if (!finished) cancelJob(jobId);
    finished = true; // DELETE уже отправлен — в catch второй не нужен
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    // изображения строго по одному: каждое тело < 1 МБ
    for (let i = 0; i < upload.length; i++) {
      onState?.({ status: 'waiting', imagesReceived: i, imagesExpected: upload.length });
      const put = await call(`${jobUrl}/images/${ctx.images[i].index}`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: upload[i], signal });
      if (!put.ok) throw httpError(put.status, await errorText(put));
    }

    const deadline = Date.now() + (opts.timeoutMs ?? ANALYSIS_TIMEOUT_MS);
    let netFails = 0;
    for (;;) {
      if (Date.now() > deadline) throw new AiError('Анализ ИИ занял слишком много времени и остановлен — можно запустить ещё раз', 'timeout');
      let r: Response;
      try {
        r = await call(jobUrl, { signal });
      } catch (e) {
        // короткий обрыв связи при опросе — не повод бросать задачу
        if ((e as AiError).code === 'network' && ++netFails < 5) {
          await sleep(poll * 2, signal);
          continue;
        }
        throw e;
      }
      netFails = 0;
      if (r.status === 404) throw new AiError('Задача анализа потеряна (сервер перезапущен?) — запустите анализ ещё раз', 'lost', 404);
      if (!r.ok || !isJson(r)) throw httpError(r.status, await errorText(r));
      const st = (await r.json()) as AiJobState;
      onState?.(st);
      if (st.status === 'done') {
        finished = true;
        return st.analysis;
      }
      if (st.status === 'error') {
        finished = true;
        throw new AiError(st.error || 'ИИ-анализ завершился с ошибкой', 'failed');
      }
      await sleep(poll, signal);
    }
  } catch (e) {
    // задача на сервере больше не нужна (отмена, ошибка загрузки, сбой опроса)
    const lost = e instanceof AiError && e.code === 'lost';
    if (!finished && !lost) cancelJob(jobId);
    finished = true;
    if (signal?.aborted) throw abortError();
    throw e;
  } finally {
    finished = true;
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Ошибка для показа пользователю (любой тип исключения) */
export function aiErrorText(e: unknown): string {
  if (e instanceof AiError) return e.message;
  if ((e as Error)?.name === 'AbortError') return 'Анализ ИИ остановлен';
  return `Ошибка ИИ-анализа: ${(e as Error)?.message ?? String(e)}`;
}
