// Клиент LLM для ИИ-анализа: любой OpenAI-совместимый /chat/completions, настройка — env.
// Повторяет complete() из ../aurel/lib/llm.ts (шлюз Hubris: цепочка models, снятые модели,
// лимиты ключа, один повтор на 429/5xx), но без npm-зависимостей и с JSON по схеме,
// изображениями, отменой и справочником моделей (какие принимают изображения, цены).
// Env читается при каждом вызове: api.ts загружает .env уже после импорта этого модуля.

import { AI_RESPONSE_SCHEMA, type AiUsage } from '../src/core/ai.ts';

export type LlmPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | LlmPart[];
}

export type LlmJsonMode = 'schema' | 'object' | 'off';

export interface LlmConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  fallbacks: string[];
  timeoutMs: number; // на один запрос к модели
  maxTokens: number;
  vision: 'auto' | 'on' | 'off';
  json: LlmJsonMode;
  gateway: boolean; // Hubris / OpenRouter: понимают models и reasoning
  mock: string; // LLM_MOCK — заглушка вместо модели, только для разработки
}

export interface LlmRequest {
  messages: LlmMessage[];
  signal?: AbortSignal; // отмена задачи
  json?: LlmJsonMode; // по умолчанию LLM_JSON
  maxTokens?: number;
  mock?: () => string; // ответ заглушки при LLM_MOCK
}

/** Токены и стоимость (costRub — по данным шлюза или по ценам из справочника моделей) */
export type LlmUsage = AiUsage;

export interface LlmResult {
  content: string;
  model: string; // модель, которая ответила (при срабатывании models — не основная)
  usage: LlmUsage;
  finishReason: string | null; // stop | length | …
}

/** Ошибка с текстом для пользователя (по-русски); status/code — ответ шлюза для логов */
export class LlmError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status = 0, code = '') {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.code = code;
  }
}

function envInt(v: string | undefined, def: number, min: number, max: number): number {
  const n = Number(v);
  return v && Number.isFinite(n) && n > 0 ? Math.min(max, Math.max(min, Math.round(n))) : def;
}

export function llmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const baseUrl = (env.LLM_BASE_URL ?? '').trim().replace(/\/+$/, '');
  // models и reasoning понимают только шлюзы; OpenAI напрямую отвергает незнакомые параметры
  const gateway = /hubris\.pw|openrouter\.ai/i.test(baseUrl);
  const model = (env.LLM_MODEL ?? '').trim();
  const fallbacks = gateway ? [...new Set((env.LLM_FALLBACK_MODELS ?? '').split(',').map((m) => m.trim()))].filter((m) => m && m !== model) : [];
  const vision = (env.LLM_VISION ?? '').trim().toLowerCase();
  const json = (env.LLM_JSON ?? '').trim().toLowerCase();
  const mock = (env.LLM_MOCK ?? '').trim();
  return {
    baseUrl,
    model,
    apiKey: (env.LLM_API_KEY ?? '').trim(),
    fallbacks,
    timeoutMs: envInt(env.LLM_TIMEOUT_MS, 150_000, 5_000, 600_000),
    maxTokens: envInt(env.LLM_MAX_TOKENS, 12_000, 500, 64_000),
    vision: /^(on|1|true|yes)$/.test(vision) ? 'on' : /^(off|0|false|no)$/.test(vision) ? 'off' : 'auto',
    json: /^(object|json_object)$/.test(json) ? 'object' : /^(off|0|false|no|none|text)$/.test(json) ? 'off' : 'schema',
    gateway,
    mock: mock === '0' ? '' : mock,
  };
}

export function llmConfigured(c: LlmConfig = llmConfig()): boolean {
  return Boolean(c.mock || (c.baseUrl && c.model && c.apiKey));
}

// та же модель, если провайдер дописал версию или убрал префикс: «gpt-4o-mini-2024-07-18», «claude-haiku-5.5-20261001»
const bareModel = (id: string) =>
  id
    .trim()
    .toLowerCase()
    .replace(/^[^/]+\//, '')
    .replace(/[-@](?:\d{4}-\d{2}-\d{2}|\d{8}|latest)$/, '');

/** Ответила не основная модель (LLM_MODEL), а резервная из цепочки models шлюза; заглушка — никогда */
export function isFallbackModel(answered: string, c: LlmConfig = llmConfig()): boolean {
  if (c.mock || !answered.trim() || !c.model) return false;
  const a = answered.trim().toLowerCase();
  if (a === c.model.toLowerCase()) return false;
  if (c.fallbacks.some((f) => f.toLowerCase() === a)) return true;
  return bareModel(a) !== bareModel(c.model);
}

// ---------- справочник моделей: GET {LLM_BASE_URL}/models ----------

export interface ModelInfo {
  vision: boolean; // input_modalities содержит image
  inRub: number | null; // ₽ за 1 млн входных токенов (Hubris)
  outRub: number | null;
}

let catalog: { at: number; base: string; map: Map<string, ModelInfo> | null; ok: boolean } | null = null;
let catalogLoading: Promise<Map<string, ModelInfo> | null> | null = null;

async function loadCatalog(c: LlmConfig): Promise<Map<string, ModelInfo> | null> {
  try {
    // Hubris отдаёт каталог и без ключа, но с ключом надёжнее (другие шлюзы его требуют); каталог ~400 КБ
    const r = await fetch(`${c.baseUrl}/models`, { headers: c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {}, signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = (await r.json()) as { data?: unknown };
    const map = new Map<string, ModelInfo>();
    const rub = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    for (const m of Array.isArray(j.data) ? j.data : []) {
      const x = m as { id?: unknown; input_modalities?: unknown; architecture?: { input_modalities?: unknown }; pricing?: Record<string, unknown> } | null;
      if (!x || typeof x.id !== 'string') continue;
      // Hubris — input_modalities, OpenRouter — architecture.input_modalities
      const mods = Array.isArray(x.input_modalities) ? x.input_modalities : Array.isArray(x.architecture?.input_modalities) ? x.architecture.input_modalities : [];
      map.set(x.id, { vision: mods.includes('image'), inRub: rub(x.pricing?.input_rub_per_million), outRub: rub(x.pricing?.output_rub_per_million) });
    }
    return map.size ? map : null;
  } catch (e) {
    console.error(`[llm] справочник моделей ${c.baseUrl}/models недоступен: ${(e as Error).message}`);
    return null;
  }
}

/** Справочник моделей шлюза; кэш на час, после сбоя — прежний справочник и повтор через минуту; null — неизвестно */
export function modelCatalog(c: LlmConfig = llmConfig()): Promise<Map<string, ModelInfo> | null> {
  if (c.mock || !c.baseUrl) return Promise.resolve(null);
  const known = catalog && catalog.base === c.baseUrl ? catalog : null;
  if (known && Date.now() - known.at < (known.ok ? 3_600_000 : 60_000)) return Promise.resolve(known.map);
  catalogLoading ??= loadCatalog(c)
    .then((map) => {
      catalog = map ? { at: Date.now(), base: c.baseUrl, map, ok: true } : { at: Date.now(), base: c.baseUrl, map: known?.map ?? null, ok: false };
      return catalog.map;
    })
    .finally(() => {
      catalogLoading = null;
    });
  return catalogLoading;
}

/** Справочник, но ждать его не дольше waitMs (статус для браузера не должен висеть); не успел — что известно */
async function catalogWithin(c: LlmConfig, waitMs: number): Promise<Map<string, ModelInfo> | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), waitMs)));
  try {
    return (await Promise.race([modelCatalog(c), late])) ?? (catalog?.base === c.baseUrl ? catalog.map : null);
  } finally {
    clearTimeout(timer);
  }
}

/** Принимает ли основная модель изображения: LLM_VISION=on/off или (auto) по справочнику */
export async function visionEnabled(c: LlmConfig = llmConfig(), waitMs = 5000): Promise<boolean> {
  if (c.vision !== 'auto') return c.vision === 'on';
  if (c.mock) return false;
  return (await catalogWithin(c, waitMs))?.get(c.model)?.vision ?? false;
}

// ---------- запрос ----------

const cancelled = () => new LlmError('Анализ отменён', 0, 'cancelled');

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled());
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelled());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ошибки до отправки запроса: TCP-соединение не установлено, имя не разрешилось
const CONNECT_FAILED = /UND_ERR_CONNECT_TIMEOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH/;

const hasImages = (messages: LlmMessage[]) => messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));

/** Те же сообщения без изображений (модель их не принимает) */
function textOnly(messages: LlmMessage[]): LlmMessage[] {
  return messages.map((m) =>
    Array.isArray(m.content)
      ? {
          ...m,
          content: m.content
            .filter((p) => p.type === 'text')
            .map((p) => (p.type === 'text' ? p.text : ''))
            .join('\n\n'),
        }
      : m,
  );
}

function responseFormat(json: LlmJsonMode): Record<string, unknown> {
  if (json === 'schema') return { response_format: { type: 'json_schema', json_schema: { name: 'order_analysis', strict: true, schema: AI_RESPONSE_SCHEMA } } };
  if (json === 'object') return { response_format: { type: 'json_object' } };
  return {};
}

/** Код и текст ошибки из тела ответа шлюза ({ error: { code, message } } у OpenAI-совместимых) */
function errorInfo(body: string): { code: string; message: string } {
  try {
    const j = JSON.parse(body) as { error?: unknown; message?: unknown };
    const e = j.error && typeof j.error === 'object' ? (j.error as { code?: unknown; message?: unknown }) : null;
    const message = e?.message ?? (typeof j.error === 'string' ? j.error : j.message) ?? '';
    return { code: e?.code == null ? '' : String(e.code), message: String(message).replace(/\s+/g, ' ').slice(0, 300) };
  } catch {
    return { code: '', message: body.replace(/\s+/g, ' ').slice(0, 300) };
  }
}

function failMessage(status: number, code: string, message: string): string {
  if (status === 401) return 'Ключ ИИ отклонён шлюзом (401) — проверьте LLM_API_KEY на сервере';
  if (status === 402) return 'На балансе ИИ-шлюза не хватает денег (402) — пополните баланс';
  if (status === 403) return `Доступ к ИИ запрещён (403${code ? `, ${code}` : ''}) — проверьте настройки ключа`;
  if (status === 404) return 'Модель ИИ не найдена (404) — проверьте LLM_MODEL и LLM_FALLBACK_MODELS';
  if (code === 'context_length_exceeded' || /maximum context length/i.test(message)) return 'Заказ слишком большой для модели ИИ — уберите лишние позиции или тексты';
  if (status === 400 || status === 422) return `Модель ИИ отклонила запрос (${status}): ${message || code || 'без пояснений'}`;
  if (status === 429) return 'Сервис ИИ перегружен (429) — повторите через минуту';
  return `Сервис ИИ недоступен (HTTP ${status}) — повторите через минуту`;
}

interface ChatResponse {
  model?: unknown;
  choices?: { message?: { content?: unknown; refusal?: unknown }; finish_reason?: unknown }[];
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; cost?: unknown };
  error?: unknown;
}

function contentText(v: unknown): string {
  if (typeof v === 'string') return v;
  // некоторые шлюзы отдают content массивом частей
  if (Array.isArray(v)) return v.map((p) => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : '')).join('');
  return '';
}

const tokens = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);

async function costRub(c: LlmConfig, model: string, prompt: number, completion: number, reported: unknown): Promise<number | null> {
  // Hubris пишет стоимость в usage.cost (копейки); иначе — по ценам из справочника моделей
  if (c.gateway && /hubris\.pw/i.test(c.baseUrl) && typeof reported === 'number' && Number.isFinite(reported) && reported >= 0) return reported / 100;
  const m = (await modelCatalog(c))?.get(model);
  if (!m || m.inRub == null || m.outRub == null) return null;
  return (prompt * m.inRub + completion * m.outRub) / 1e6;
}

/**
 * Один ответ модели. Цепочка: основная модель + LLM_FALLBACK_MODELS (массив models шлюза);
 * снятые модели (404 model_not_found) выкидываются из цепочки; 400/401/402/403 и лимиты ключа
 * не повторяются; 429/5xx/сбой сети/пустой ответ — один повтор (retry-after ≤ 10 с); соединение
 * не установилось — ещё до двух повторов (запрос не дошёл, это бесплатно); отказ шлюза от
 * response_format — один повтор без него. Бросает LlmError с текстом для пользователя.
 */
export async function complete(req: LlmRequest): Promise<LlmResult> {
  const c = llmConfig();
  if (c.mock) return mockComplete(req, c);
  if (!llmConfigured(c)) throw new LlmError('ИИ-анализ не настроен на сервере', 0, 'not_configured');
  const url = `${c.baseUrl}/chat/completions`;
  let chain = [c.model, ...c.fallbacks].slice(0, 10); // шлюз принимает до 10 моделей
  let messages = req.messages;
  if (hasImages(messages)) {
    if (c.vision === 'off') messages = textOnly(messages);
    else if (c.vision === 'auto') {
      // с изображениями — только модели, которые их принимают (если справочник известен)
      const cat = await modelCatalog(c);
      if (cat) {
        const seeing = chain.filter((id) => cat.get(id)?.vision);
        if (seeing.length) chain = seeing;
        else {
          console.error('[llm] ни одна модель цепочки не принимает изображения — отправляем без них');
          messages = textOnly(messages);
        }
      }
    }
  }
  let json = req.json ?? c.json;
  let retried = false;
  let connectRetries = 0;
  let delayMs = 2000;

  for (;;) {
    if (req.signal?.aborted) throw cancelled();
    const body = JSON.stringify({
      model: chain[0],
      ...(c.gateway && chain.length > 1 ? { models: chain } : {}),
      messages,
      max_tokens: req.maxTokens ?? c.maxTokens,
      ...responseFormat(json),
      // гибридные «думающие» модели тратят max_tokens на рассуждения и обрывают ответ
      ...(c.gateway ? { reasoning: { enabled: false } } : {}),
    });
    const timeout = AbortSignal.timeout(c.timeoutMs);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    let status: number;
    let text: string;
    let retryAfter: number;
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.apiKey}` }, body, signal });
      status = res.status;
      retryAfter = Number(res.headers.get('retry-after'));
      text = await res.text();
    } catch (e) {
      if (req.signal?.aborted) throw cancelled();
      if (timeout.aborted) throw new LlmError(`Модель ИИ не ответила за ${Math.round(c.timeoutMs / 1000)} с — повторите позже`, 0, 'timeout');
      const err = e as Error & { cause?: { code?: string; message?: string } };
      const why = err.cause ? `${err.message}: ${err.cause.code ?? err.cause.message ?? ''}` : err.message;
      // соединение не установилось — запрос до шлюза не дошёл, повтор ничего не стоит: ещё два раза
      if (CONNECT_FAILED.test(why) && connectRetries < 2) {
        connectRetries++;
        console.error(`[llm] нет соединения со шлюзом (${why}) — повтор ${connectRetries} из 2 через ${2 * connectRetries} с`);
        await sleep(2000 * connectRetries, req.signal);
        continue;
      }
      if (!retried) {
        retried = true;
        console.error(`[llm] сбой сети (${why}) — повтор через ${delayMs / 1000} с`);
        await sleep(delayMs, req.signal);
        continue;
      }
      throw new LlmError(`Нет связи с сервисом ИИ (${why}) — повторите позже`, 0, 'network');
    }

    if (status < 200 || status >= 300) {
      const { code, message } = errorInfo(text);
      const brief = `HTTP ${status}${code ? ` ${code}` : ''}${message ? `: ${message}` : ''}`;
      // бесплатные модели снимают без предупреждения, а Hubris на неизвестную основную модель
      // отвечает 404 вместо перехода по models — убираем её из цепочки и пробуем следующую
      if (status === 404 && chain.length > 1 && /model_not_found/.test(text)) {
        console.error(`[llm] модель ${chain[0]} не найдена — исправьте LLM_MODEL/LLM_FALLBACK_MODELS (${brief})`);
        chain = chain.slice(1);
        continue;
      }
      // модель или провайдер не поддерживает response_format — один раз без него
      if (status === 400 && json !== 'off' && /response_format|json_schema|json_object|structured|schema/i.test(text)) {
        console.error(`[llm] response_format отклонён — повтор без него (${brief})`);
        json = 'off';
        continue;
      }
      // лимит расходов ключа (сутки/неделя/месяц) и 4xx — нужен человек, повтор только сожжёт квоту
      if (/daily_limit_exceeded|key_limit_exceeded/.test(text)) {
        console.error(`[llm] лимит ключа, не повторяем: ${brief}`);
        throw new LlmError(`Исчерпан лимит расходов ключа ИИ (${/daily/.test(text) ? 'суточный' : 'на период'}) — повторите позже или поднимите лимит ключа`, status, code);
      }
      if (status < 500 && status !== 429) {
        console.error(`[llm] запрос отклонён, не повторяем: ${brief}`);
        throw new LlmError(failMessage(status, code, message), status, code);
      }
      if (!retried) {
        retried = true;
        // «повторите чуть позже»: мгновенный повтор упрётся в тот же лимит
        if (retryAfter > 0) delayMs = Math.min(retryAfter, 10) * 1000;
        console.error(`[llm] ${brief} — повтор через ${delayMs / 1000} с`);
        await sleep(delayMs, req.signal);
        continue;
      }
      console.error(`[llm] ${brief} — после повтора`);
      throw new LlmError(failMessage(status, code, message), status, code);
    }

    let data: ChatResponse;
    try {
      data = JSON.parse(text) as ChatResponse;
    } catch {
      data = { error: 'ответ шлюза — не JSON' };
    }
    const choice = data.choices?.[0];
    const content = contentText(choice?.message?.content).trim();
    if (!content) {
      const refusal = choice?.message?.refusal;
      if (typeof refusal === 'string' && refusal.trim()) throw new LlmError(`Модель ИИ отказалась отвечать: ${refusal.trim().slice(0, 200)}`, status, 'refusal');
      if (!retried) {
        retried = true;
        console.error(`[llm] пустой ответ${data.error ? ` (${errorInfo(JSON.stringify(data)).message})` : ''} — повтор`);
        await sleep(delayMs, req.signal);
        continue;
      }
      throw new LlmError('Модель ИИ вернула пустой ответ — повторите позже', status, 'empty');
    }
    const model = typeof data.model === 'string' && data.model ? data.model : chain[0];
    const promptTokens = tokens(data.usage?.prompt_tokens);
    const completionTokens = tokens(data.usage?.completion_tokens);
    return {
      content,
      model,
      usage: { promptTokens, completionTokens, costRub: await costRub(c, model, promptTokens, completionTokens, data.usage?.cost) },
      finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
    };
  }
}

// ---------- заглушка для разработки (LLM_MOCK) ----------

/** LLM_MOCK=1 — готовый ответ через LLM_MOCK_DELAY_MS (по умолчанию 1500 мс), fail — ошибка 502 */
async function mockComplete(req: LlmRequest, c: LlmConfig): Promise<LlmResult> {
  const delay = Math.max(0, Number(process.env.LLM_MOCK_DELAY_MS ?? 1500) || 0);
  await sleep(delay, req.signal);
  if (c.mock === 'fail') throw new LlmError('Сервис ИИ недоступен (HTTP 502, LLM_MOCK=fail)', 502, 'upstream_error');
  const content = req.mock?.() ?? '{"summary":"LLM_MOCK","confidence":"low","positions":[],"questions":[],"risks":[],"recommendations":[]}';
  const promptTokens = Math.round(req.messages.reduce((a, m) => a + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length), 0) / 3);
  return { content, model: 'mock', usage: { promptTokens, completionTokens: Math.round(content.length / 3), costRub: 0 }, finishReason: 'stop' };
}
