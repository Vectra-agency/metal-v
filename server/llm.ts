// Клиент LLM для ИИ-анализа, настройка — env. Провайдеры:
// - PoYo (https://api.poyo.ai/v1, как в ../video-creator): модели Claude — через Anthropic Messages
//   (/v1/messages: строгая JSON-схема и изображения), остальные — через OpenAI Chat Completions;
//   резервные модели перебираются здесь, по очереди (у PoYo нет цепочки models);
// - шлюзы Hubris / OpenRouter: цепочка models и reasoning — как complete() из ../aurel/lib/llm.ts;
// - любой другой OpenAI-совместимый /chat/completions.
// Без npm-зависимостей: снятые модели, лимиты ключа, один повтор на 429/5xx, отмена, справочник моделей
// (какие принимают изображения, цены). Env читается при каждом вызове: api.ts загружает .env уже после
// импорта этого модуля.

import { AI_RESPONSE_SCHEMA, type AiUsage } from '../src/core/ai.ts';

export type LlmPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | LlmPart[];
}

export type LlmJsonMode = 'schema' | 'object' | 'off';

export type LlmProvider = 'poyo' | 'gateway' | 'other';

export interface LlmConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  fallbacks: string[];
  timeoutMs: number; // на один запрос к модели
  maxTokens: number;
  vision: 'auto' | 'on' | 'off';
  json: LlmJsonMode;
  provider: LlmProvider;
  gateway: boolean; // Hubris / OpenRouter: понимают models и reasoning (резерв — на стороне шлюза)
  mock: string; // LLM_MOCK — заглушка вместо модели, только для разработки
}

export interface LlmRequest {
  messages: LlmMessage[];
  signal?: AbortSignal; // отмена задачи
  json?: LlmJsonMode; // по умолчанию LLM_JSON
  maxTokens?: number;
  mock?: () => string; // ответ заглушки при LLM_MOCK
}

/** Токены и стоимость: costRub — по данным Hubris или его справочника, costUsd — по ценам каталога PoYo */
export type LlmUsage = AiUsage;

export interface LlmResult {
  content: string;
  model: string; // модель, которая ответила (резервная, если основная не смогла)
  usage: LlmUsage;
  finishReason: string | null; // stop | length | …
}

/** Ошибка с текстом для пользователя (по-русски); status/code — ответ сервиса для логов */
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

export const POYO_BASE_URL = 'https://api.poyo.ai/v1';
/** Основная модель PoYo по умолчанию: дешёвая, видит чертежи, строгая JSON-схема; на ней отлажен промпт */
export const POYO_DEFAULT_MODEL = 'claude-haiku-5-5';
/** Резерв другого поставщика: если Anthropic недоступен, не упадёт вместе с ним */
export const POYO_DEFAULT_FALLBACKS = ['gemini-3.8-flash'];
const POYO_USD_PER_CREDIT = 0.005; // poyo.ai/pricing: 1 credit = $0.005

function envInt(v: string | undefined, def: number, min: number, max: number): number {
  const n = Number(v);
  return v && Number.isFinite(n) && n > 0 ? Math.min(max, Math.max(min, Math.round(n))) : def;
}

function providerOf(baseUrl: string): LlmProvider {
  if (/hubris\.pw|openrouter\.ai/i.test(baseUrl)) return 'gateway';
  if (/poyo\.ai/i.test(baseUrl)) return 'poyo';
  return 'other';
}

const list = (v: string | undefined) => [...new Set((v ?? '').split(',').map((m) => m.trim()))].filter(Boolean);

export function llmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  // PoYo можно включить одним ключом, как в video-creator: POYO_API_KEY (адрес и модели — по умолчанию)
  const poyoKey = (env.POYO_API_KEY ?? '').trim();
  const baseUrl = ((env.LLM_BASE_URL ?? '').trim() || (poyoKey ? POYO_BASE_URL : '')).replace(/\/+$/, '');
  const provider = providerOf(baseUrl);
  const poyo = provider === 'poyo';
  const model = (env.LLM_MODEL ?? '').trim() || (poyo ? POYO_DEFAULT_MODEL : '');
  // пусто — резерв по умолчанию (для PoYo), none — без резерва
  const fb = (env.LLM_FALLBACK_MODELS ?? '').trim();
  const fallbacks = (/^(none|off|-)$/i.test(fb) ? [] : fb ? list(fb) : poyo ? POYO_DEFAULT_FALLBACKS : []).filter((m) => m !== model);
  const vision = (env.LLM_VISION ?? '').trim().toLowerCase();
  const json = (env.LLM_JSON ?? '').trim().toLowerCase();
  const mock = (env.LLM_MOCK ?? '').trim();
  return {
    baseUrl,
    model,
    apiKey: (env.LLM_API_KEY ?? '').trim() || (poyo ? poyoKey : ''),
    fallbacks,
    timeoutMs: envInt(env.LLM_TIMEOUT_MS, 150_000, 5_000, 600_000),
    maxTokens: envInt(env.LLM_MAX_TOKENS, 12_000, 500, 64_000),
    vision: /^(on|1|true|yes)$/.test(vision) ? 'on' : /^(off|0|false|no)$/.test(vision) ? 'off' : 'auto',
    json: /^(object|json_object)$/.test(json) ? 'object' : /^(off|0|false|no|none|text)$/.test(json) ? 'off' : 'schema',
    provider,
    gateway: provider === 'gateway',
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

/** Ответила не основная модель (LLM_MODEL), а резервная; заглушка — никогда */
export function isFallbackModel(answered: string, c: LlmConfig = llmConfig()): boolean {
  if (c.mock || !answered.trim() || !c.model) return false;
  const a = answered.trim().toLowerCase();
  if (a === c.model.toLowerCase()) return false;
  if (c.fallbacks.some((f) => f.toLowerCase() === a)) return true;
  return bareModel(a) !== bareModel(c.model);
}

// ---------- справочник моделей: Hubris/OpenRouter — GET {base}/models, PoYo — каталог chat-моделей ----------

export interface ModelInfo {
  vision: boolean; // принимает изображения
  inRub: number | null; // ₽ за 1 млн входных токенов (Hubris)
  outRub: number | null;
  inUsd?: number | null; // $ за 1 млн входных токенов (PoYo)
  outUsd?: number | null;
}

let catalog: { at: number; base: string; map: Map<string, ModelInfo> | null; ok: boolean } | null = null;
let catalogLoading: Promise<Map<string, ModelInfo> | null> | null = null;

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
// у PoYo метка input:image есть не у всех моделей, которые принимают изображения: Claude и Gemini видят
const POYO_SEEING = /^(claude-|gemini-)/i;

async function loadPoyoCatalog(c: LlmConfig): Promise<Map<string, ModelInfo>> {
  const map = new Map<string, ModelInfo>();
  let cursor = '';
  for (let page = 0; page < 10; page++) {
    const r = await fetch(`${c.baseUrl}/catalog/models?category=chat${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, {
      headers: { Authorization: `Bearer ${c.apiKey}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = (await r.json()) as { data?: { items?: unknown; has_more?: unknown; next_cursor?: unknown } };
    for (const m of Array.isArray(j.data?.items) ? j.data.items : []) {
      const x = m as { model_id?: unknown; tags?: unknown; billing?: { input_credits?: unknown; output_credits?: unknown } } | null;
      if (!x || typeof x.model_id !== 'string') continue;
      const tags = Array.isArray(x.tags) ? x.tags : [];
      const inC = num(x.billing?.input_credits);
      const outC = num(x.billing?.output_credits);
      map.set(x.model_id, {
        vision: tags.includes('input:image') || POYO_SEEING.test(x.model_id),
        inRub: null,
        outRub: null,
        inUsd: inC == null ? null : inC * POYO_USD_PER_CREDIT,
        outUsd: outC == null ? null : outC * POYO_USD_PER_CREDIT,
      });
    }
    if (!j.data?.has_more || typeof j.data.next_cursor !== 'string') break;
    cursor = j.data.next_cursor;
  }
  return map;
}

async function loadCatalog(c: LlmConfig): Promise<Map<string, ModelInfo> | null> {
  try {
    if (c.provider === 'poyo') {
      const map = await loadPoyoCatalog(c);
      return map.size ? map : null;
    }
    // Hubris отдаёт каталог и без ключа, но с ключом надёжнее (другие шлюзы его требуют); каталог ~400 КБ
    const r = await fetch(`${c.baseUrl}/models`, { headers: c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {}, signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = (await r.json()) as { data?: unknown };
    const map = new Map<string, ModelInfo>();
    for (const m of Array.isArray(j.data) ? j.data : []) {
      const x = m as { id?: unknown; input_modalities?: unknown; architecture?: { input_modalities?: unknown }; pricing?: Record<string, unknown> } | null;
      if (!x || typeof x.id !== 'string') continue;
      // Hubris — input_modalities, OpenRouter — architecture.input_modalities
      const mods = Array.isArray(x.input_modalities) ? x.input_modalities : Array.isArray(x.architecture?.input_modalities) ? x.architecture.input_modalities : [];
      map.set(x.id, { vision: mods.includes('image'), inRub: num(x.pricing?.input_rub_per_million), outRub: num(x.pricing?.output_rub_per_million) });
    }
    return map.size ? map : null;
  } catch (e) {
    console.error(`[llm] справочник моделей ${c.baseUrl} недоступен: ${(e as Error).message}`);
    return null;
  }
}

/** Справочник моделей; кэш на час, после сбоя — прежний справочник и повтор через минуту; null — неизвестно */
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

/** Принимает ли модель изображения: LLM_VISION=on/off или (auto) по справочнику; у PoYo Claude и Gemini — да */
async function seesImages(c: LlmConfig, model: string, waitMs?: number): Promise<boolean> {
  if (c.vision !== 'auto') return c.vision === 'on';
  if (c.mock) return false;
  const cat = waitMs == null ? await modelCatalog(c) : await catalogWithin(c, waitMs);
  return cat?.get(model)?.vision ?? (c.provider === 'poyo' && POYO_SEEING.test(model));
}

/** Принимает ли основная модель изображения (для статуса и для решения, отправлять ли чертежи) */
export function visionEnabled(c: LlmConfig = llmConfig(), waitMs = 5000): Promise<boolean> {
  return seesImages(c, c.model, waitMs);
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

/** Claude у PoYo — через Anthropic Messages: там работают строгая JSON-схема и изображения */
const usesMessagesApi = (c: LlmConfig, model: string) => c.provider === 'poyo' && /^claude-/i.test(model);

/** Тело Anthropic Messages: system — отдельно, изображения — блоками base64 */
function messagesBody(model: string, messages: LlmMessage[], maxTokens: number, json: LlmJsonMode): string {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n\n')))
    .join('\n\n');
  const turns = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role,
      content:
        typeof m.content === 'string'
          ? m.content
          : m.content.map((p) => {
              if (p.type === 'text') return { type: 'text', text: p.text };
              const d = /^data:([^;,]+);base64,(.*)$/s.exec(p.image_url.url);
              return d ? { type: 'image', source: { type: 'base64', media_type: d[1], data: d[2] } } : { type: 'image', source: { type: 'url', url: p.image_url.url } };
            }),
    }));
  return JSON.stringify({
    model,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    messages: turns,
    ...(json === 'schema' ? { output_config: { format: { type: 'json_schema', schema: AI_RESPONSE_SCHEMA } } } : {}),
  });
}

/** Код и текст ошибки из тела ответа ({ error: { code | type, message } } у OpenAI-совместимых и Anthropic) */
function errorInfo(body: string): { code: string; message: string } {
  try {
    const j = JSON.parse(body) as { error?: unknown; message?: unknown };
    const e = j.error && typeof j.error === 'object' ? (j.error as { code?: unknown; type?: unknown; message?: unknown }) : null;
    const message = e?.message ?? (typeof j.error === 'string' ? j.error : j.message) ?? '';
    const code = e?.code ?? e?.type;
    return { code: code == null ? '' : String(code), message: String(message).replace(/\s+/g, ' ').slice(0, 300) };
  } catch {
    return { code: '', message: body.replace(/\s+/g, ' ').slice(0, 300) };
  }
}

function failMessage(status: number, code: string, message: string): string {
  if (status === 401) return 'Ключ ИИ отклонён сервисом (401) — проверьте ключ (LLM_API_KEY или POYO_API_KEY) на сервере';
  if (status === 402) return 'На балансе сервиса ИИ не хватает денег (402) — пополните баланс';
  if (status === 403) return `Доступ к ИИ запрещён (403${code ? `, ${code}` : ''}) — проверьте настройки ключа`;
  if (status === 404) return 'Модель ИИ не найдена (404) — проверьте LLM_MODEL и LLM_FALLBACK_MODELS';
  if (code === 'context_length_exceeded' || /maximum context length|prompt is too long/i.test(message)) return 'Заказ слишком большой для модели ИИ — уберите лишние позиции или тексты';
  if (status === 400 || status === 422) return `Модель ИИ отклонила запрос (${status}): ${message || code || 'без пояснений'}`;
  if (status === 429) return 'Сервис ИИ перегружен (429) — повторите через минуту';
  return `Сервис ИИ недоступен (HTTP ${status}) — повторите через минуту`;
}

/** Ошибки, после которых резервная модель не поможет: ключ, баланс, доступ, отмена */
const fatal = (e: LlmError) => e.code === 'cancelled' || e.code === 'key_limit' || e.status === 401 || e.status === 402 || e.status === 403;

interface Parsed {
  content: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  reportedCost: unknown; // usage.cost Hubris (копейки)
  finishReason: string | null;
  refusal: string;
  error: string;
}

function contentText(v: unknown): string {
  if (typeof v === 'string') return v;
  // некоторые шлюзы отдают content массивом частей
  if (Array.isArray(v)) return v.map((p) => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : '')).join('');
  return '';
}

const tokens = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);

function parseChat(text: string): Parsed {
  let d: {
    model?: unknown;
    choices?: { message?: { content?: unknown; refusal?: unknown }; finish_reason?: unknown }[];
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; cost?: unknown };
    error?: unknown;
  };
  try {
    d = JSON.parse(text);
  } catch {
    d = { error: 'ответ сервиса — не JSON' };
  }
  const choice = d.choices?.[0];
  return {
    content: contentText(choice?.message?.content).trim(),
    model: typeof d.model === 'string' ? d.model : '',
    promptTokens: tokens(d.usage?.prompt_tokens),
    completionTokens: tokens(d.usage?.completion_tokens),
    reportedCost: d.usage?.cost,
    finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
    refusal: typeof choice?.message?.refusal === 'string' ? choice.message.refusal.trim() : '',
    error: d.error ? errorInfo(JSON.stringify(d)).message : '',
  };
}

function parseMessages(text: string): Parsed {
  let d: {
    model?: unknown;
    content?: { type?: unknown; text?: unknown }[];
    stop_reason?: unknown;
    usage?: { input_tokens?: unknown; output_tokens?: unknown; cache_creation_input_tokens?: unknown; cache_read_input_tokens?: unknown };
    error?: unknown;
  };
  try {
    d = JSON.parse(text);
  } catch {
    d = { error: 'ответ сервиса — не JSON' };
  }
  const u = d.usage;
  const stop = typeof d.stop_reason === 'string' ? d.stop_reason : null;
  return {
    content: (Array.isArray(d.content) ? d.content : [])
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('')
      .trim(),
    model: typeof d.model === 'string' ? d.model : '',
    // кэшированный и записанный в кэш промпт — тоже входные токены
    promptTokens: tokens(u?.input_tokens) + tokens(u?.cache_creation_input_tokens) + tokens(u?.cache_read_input_tokens),
    completionTokens: tokens(u?.output_tokens),
    reportedCost: undefined,
    finishReason: stop === 'max_tokens' ? 'length' : stop === 'end_turn' ? 'stop' : stop,
    refusal: stop === 'refusal' ? 'модель отказалась отвечать' : '',
    error: d.error ? errorInfo(JSON.stringify(d)).message : '',
  };
}

async function costOf(c: LlmConfig, model: string, prompt: number, completion: number, reported: unknown): Promise<{ costRub: number | null; costUsd?: number | null }> {
  // Hubris пишет стоимость в usage.cost (копейки); иначе — по ценам из справочника моделей
  if (c.gateway && /hubris\.pw/i.test(c.baseUrl) && typeof reported === 'number' && Number.isFinite(reported) && reported >= 0) return { costRub: reported / 100 };
  const m = (await modelCatalog(c))?.get(model);
  if (m?.inUsd != null && m.outUsd != null) return { costRub: null, costUsd: (prompt * m.inUsd + completion * m.outUsd) / 1e6 };
  if (!m || m.inRub == null || m.outRub == null) return { costRub: null };
  return { costRub: (prompt * m.inRub + completion * m.outRub) / 1e6 };
}

/**
 * Один ответ модели. Цепочка: основная модель + LLM_FALLBACK_MODELS — у шлюзов массивом models в одном
 * запросе, у PoYo и прочих по очереди: модель, которая не ответила (сбой, тайм-аут, 5xx, нет такой модели,
 * отказ от запроса), уступает следующей; ключ, баланс, доступ и отмена — сразу ошибка. Внутри модели:
 * снятые модели шлюза (404 model_not_found) выкидываются; 400/401/402/403 и лимиты ключа не повторяются;
 * 429/5xx/сбой сети/пустой ответ — один повтор (retry-after ≤ 10 с); соединение не установилось — ещё до
 * двух повторов (запрос не дошёл, это бесплатно); отказ от response_format — один повтор без него.
 * Бросает LlmError с текстом для пользователя.
 */
export async function complete(req: LlmRequest): Promise<LlmResult> {
  const c = llmConfig();
  if (c.mock) return mockComplete(req, c);
  if (!llmConfigured(c)) throw new LlmError('ИИ-анализ не настроен на сервере', 0, 'not_configured');
  const chain = [c.model, ...c.fallbacks].slice(0, 10); // шлюз принимает до 10 моделей
  if (c.gateway) return attempt(c, chain, await gatewayMessages(c, chain, req.messages), req);
  let last: LlmError | null = null;
  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];
    const messages = hasImages(req.messages) && !(await seesImages(c, model)) ? textOnly(req.messages) : req.messages;
    try {
      return await attempt(c, [model], messages, req);
    } catch (e) {
      if (!(e instanceof LlmError) || fatal(e) || req.signal?.aborted) throw e;
      last = e;
      if (i + 1 < chain.length) console.error(`[llm] ${model} не ответила (${e.message}) — пробуем резервную модель ${chain[i + 1]}`);
    }
  }
  throw last ?? new LlmError('Сервис ИИ недоступен — повторите через минуту');
}

/** Шлюз: с изображениями — только модели цепочки, которые их принимают (если справочник известен) */
async function gatewayMessages(c: LlmConfig, chain: string[], messages: LlmMessage[]): Promise<LlmMessage[]> {
  if (!hasImages(messages)) return messages;
  if (c.vision === 'off') return textOnly(messages);
  if (c.vision === 'on') return messages;
  const cat = await modelCatalog(c);
  if (!cat) return messages;
  const seeing = chain.filter((id) => cat.get(id)?.vision);
  if (seeing.length) {
    chain.splice(0, chain.length, ...seeing);
    return messages;
  }
  console.error('[llm] ни одна модель цепочки не принимает изображения — отправляем без них');
  return textOnly(messages);
}

/** Запрос к одной модели (шлюзу — к цепочке models) с повторами */
async function attempt(c: LlmConfig, chain: string[], messages: LlmMessage[], req: LlmRequest): Promise<LlmResult> {
  let json = req.json ?? c.json;
  let retried = false;
  let connectRetries = 0;
  let delayMs = 2000;

  for (;;) {
    if (req.signal?.aborted) throw cancelled();
    const model = chain[0];
    const anthropic = usesMessagesApi(c, model);
    const url = `${c.baseUrl}/${anthropic ? 'messages' : 'chat/completions'}`;
    const maxTokens = req.maxTokens ?? c.maxTokens;
    const body = anthropic
      ? messagesBody(model, messages, maxTokens, json)
      : JSON.stringify({
          model,
          ...(c.gateway && chain.length > 1 ? { models: chain } : {}),
          messages,
          max_tokens: maxTokens,
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
      // соединение не установилось — запрос до сервиса не дошёл, повтор ничего не стоит: ещё два раза
      if (CONNECT_FAILED.test(why) && connectRetries < 2) {
        connectRetries++;
        console.error(`[llm] нет соединения с сервисом ИИ (${why}) — повтор ${connectRetries} из 2 через ${2 * connectRetries} с`);
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
      const brief = `${model}: HTTP ${status}${code ? ` ${code}` : ''}${message ? `: ${message}` : ''}`;
      // бесплатные модели снимают без предупреждения, а Hubris на неизвестную основную модель
      // отвечает 404 вместо перехода по models — убираем её из цепочки и пробуем следующую
      if (status === 404 && chain.length > 1 && /model_not_found/.test(text)) {
        console.error(`[llm] модель ${model} не найдена — исправьте LLM_MODEL/LLM_FALLBACK_MODELS (${brief})`);
        chain = chain.slice(1);
        continue;
      }
      // модель или провайдер не поддерживает response_format / output_config — один раз без него
      if (status === 400 && json !== 'off' && /response_format|json_schema|json_object|structured|schema|output_config/i.test(text)) {
        console.error(`[llm] формат ответа отклонён — повтор без него (${brief})`);
        json = 'off';
        continue;
      }
      // лимит расходов ключа (сутки/неделя/месяц) и 4xx — нужен человек, повтор только сожжёт квоту
      if (/daily_limit_exceeded|key_limit_exceeded/.test(text)) {
        console.error(`[llm] лимит ключа, не повторяем: ${brief}`);
        throw new LlmError(`Исчерпан лимит расходов ключа ИИ (${/daily/.test(text) ? 'суточный' : 'на период'}) — повторите позже или поднимите лимит ключа`, status, 'key_limit');
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

    const p = anthropic ? parseMessages(text) : parseChat(text);
    if (!p.content) {
      if (p.refusal) throw new LlmError(`Модель ИИ отказалась отвечать: ${p.refusal.slice(0, 200)}`, status, 'refusal');
      if (!retried) {
        retried = true;
        console.error(`[llm] ${model}: пустой ответ${p.error ? ` (${p.error})` : ''} — повтор`);
        await sleep(delayMs, req.signal);
        continue;
      }
      throw new LlmError('Модель ИИ вернула пустой ответ — повторите позже', status, 'empty');
    }
    // шлюз сообщает, какая модель цепочки ответила; PoYo подменяет имя («gemini-3.8-flash-tiered») — берём запрошенную
    const answered = c.gateway && p.model ? p.model : model;
    return {
      content: p.content,
      model: answered,
      usage: { promptTokens: p.promptTokens, completionTokens: p.completionTokens, ...(await costOf(c, answered, p.promptTokens, p.completionTokens, p.reportedCost)) },
      finishReason: p.finishReason,
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
