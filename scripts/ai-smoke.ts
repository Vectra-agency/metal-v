// ИИ-анализ целиком на настоящей модели: задача → изображения → ожидание → результат;
// печатает статус, время, модель, токены, стоимость и сам анализ.
//   node scripts/ai-smoke.ts [context.json] [--image <id позиции>=<файл.jpg>]… [--url http://127.0.0.1:8787] [--json] [--out файл.json] [--raw файл.json]
// Без --url — очередь задач server/ai.ts в этом процессе (тот же путь, что у сайта, но без HTTP);
// с --url — через HTTP API запущенного сервера. Ключ — из .env или окружения.
// --raw (без --url) — сохранить запросы к модели и её ответы до проверки (без ключа): видно, что отбросила проверка.
// Каждый запуск — платный запрос к модели (≈ 0,5–2 ₽); LLM_MOCK=1 — без запроса.
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AiAnalysis, AiContext, AiJobCreated, AiJobState, AiServerStatus } from '../src/core/ai.ts';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const flag = (name: string) => {
  const i = args.indexOf(name);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
};
const url = opt('--url')?.replace(/\/+$/, '');
const out = opt('--out');
const rawOut = opt('--raw');
const asJson = flag('--json');
const imageArgs: string[] = [];
for (let v = opt('--image'); v; v = opt('--image')) imageArgs.push(v);
const ctxPath = args[0] ?? fileURLToPath(new URL('./fixtures/context-p4.json', import.meta.url));

const ctx: AiContext = JSON.parse(readFileSync(ctxPath, 'utf8'));
ctx.createdAt = new Date().toISOString();
const images: { index: number; data: Buffer }[] = [];
if (imageArgs.length) {
  ctx.images = [];
  imageArgs.forEach((a, index) => {
    const [id, file] = a.split('=');
    const p = ctx.positions.find((x) => x.id === id);
    if (!p || !file) throw new Error(`--image ${a}: нужно <id позиции>=<файл>, позиции: ${ctx.positions.map((x) => x.id).join(', ')}`);
    ctx.images.push({ index, positionId: id, caption: `${p.name}, ${basename(file)}` });
    p.imageIndex = index;
    images.push({ index, data: readFileSync(file) });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sec = (ms: number) => `${(ms / 1000).toFixed(1)} с`;

interface Api {
  status(): Promise<AiServerStatus>;
  create(): Promise<AiJobCreated>;
  put(id: string, index: number, data: Buffer): Promise<void>;
  get(id: string): Promise<AiJobState>;
}

async function http(path: string, init?: RequestInit): Promise<unknown> {
  const r = await fetch(`${url}${path}`, init);
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} ${path}: ${text}`);
  return text ? JSON.parse(text) : null;
}

let api: Api;
if (url) {
  api = {
    status: async () => (await http('/api/ai/status')) as AiServerStatus,
    create: async () => (await http('/api/ai/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ context: ctx }) })) as AiJobCreated,
    put: async (id, index, data) => {
      await http(`/api/ai/jobs/${id}/images/${index}`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: new Uint8Array(data) });
    },
    get: async (id) => (await http(`/api/ai/jobs/${id}`)) as AiJobState,
  };
} else {
  try {
    process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
  } catch {
    /* только окружение */
  }
  if (rawOut) {
    // перехват fetch: тот же путь server/ai.ts → llm.ts, но запросы к модели и ответы пишутся в файл
    // (заголовки с ключом не сохраняются; изображения base64 заменяются пометкой)
    const realFetch = globalThis.fetch;
    const calls: { request: unknown; status: number; response: unknown; ms: number }[] = [];
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!target.endsWith('/chat/completions')) return realFetch(input, init);
      const t = Date.now();
      const res = await realFetch(input, init);
      const text = await res.clone().text();
      const parse = (s: string): unknown => {
        try {
          return JSON.parse(s);
        } catch {
          return s;
        }
      };
      const body = typeof init?.body === 'string' ? init.body.replace(/data:image\/[\w+.-]+;base64,[A-Za-z0-9+/=]+/g, 'data:image;base64,…') : null;
      calls.push({ request: body ? parse(body) : null, status: res.status, response: parse(text), ms: Date.now() - t });
      writeFileSync(rawOut, JSON.stringify(calls, null, 1));
      return res;
    };
  }
  const ai = await import('../server/ai.ts');
  console.log(ai.aiStartupLine());
  api = {
    status: () => ai.aiStatus(),
    create: () => ai.createJob({ context: ctx }, 'ai-smoke'),
    put: async (id, index, data) => ai.putImage(id, index, data),
    get: async (id) => ai.getJob(id),
  };
}

const status = await api.status();
console.log(`Статус: ${JSON.stringify(status)}${url ? ` (${url})` : ''}`);
if (!status.configured) {
  console.error('ИИ не настроен: задайте LLM_BASE_URL, LLM_MODEL, LLM_API_KEY (см. .env.example)');
  process.exit(1);
}
const json = JSON.stringify(ctx);
console.log(`Заказ: ${ctx.positions.length} поз., контекст ${Math.round(Buffer.byteLength(json) / 1024)} КБ, изображений ${images.length}`);

const t0 = Date.now();
const { jobId, imagesExpected } = await api.create();
console.log(`Задача ${jobId}, ждёт изображений: ${imagesExpected}`);
if (imagesExpected) for (const im of images) await api.put(jobId, im.index, im.data);

let last = '';
let state: AiJobState;
for (;;) {
  state = await api.get(jobId);
  const line =
    state.status === 'waiting'
      ? `ждёт изображения ${state.imagesReceived}/${state.imagesExpected}`
      : state.status === 'queued'
        ? `в очереди, место ${state.position}`
        : state.status === 'running'
          ? `запрос к модели ${state.model ?? ''}`
          : state.status;
  if (line !== last) console.log(`  [${sec(Date.now() - t0)}] ${line}`);
  last = line;
  if (state.status === 'done' || state.status === 'error') break;
  await sleep(1000);
}

if (state.status === 'error') {
  console.error(`Ошибка за ${sec(Date.now() - t0)}: ${state.error}`);
  process.exit(1);
}
if (state.status !== 'done') process.exit(1);
const a: AiAnalysis = state.analysis;
// расход — в самом анализе (так его видит браузер); у старого сервера — только рядом, в состоянии задачи
const u = a.usage ?? state.usage;
console.log(
  `\nГотово за ${sec(Date.now() - t0)} (модель — ${sec(a.durationMs)}) · ${a.model}${a.fallback ? ' (резервная модель!)' : ''}` +
    (u ? ` · токены ${u.promptTokens} + ${u.completionTokens}${u.costRub != null ? ` · ≈ ${u.costRub.toFixed(2)} ₽` : ''}` : ''),
);
if (out) writeFileSync(out, JSON.stringify({ analysis: a, usage: u }, null, 2));
if (asJson) {
  console.log(JSON.stringify(a, null, 2));
  process.exit(0);
}
const name = (id: string) => ctx.positions.find((p) => p.id === id)?.name ?? id;
console.log(`Уверенность: ${a.confidence}\nИтог: ${a.summary}`);
console.log(`\nПозиции с замечаниями (${a.positions.length} из ${ctx.positions.length}):`);
for (const r of a.positions) {
  console.log(`  [${r.status}] ${r.id} ${name(r.id)} — ${r.comment}`);
  if (r.operations.length) console.log(`      операции: ${r.operations.join('; ')}`);
  for (const s of r.suggestions) {
    const what = s.kind === 'material' ? s.materialId : s.kind === 'extra' ? `${s.label} ${s.perPiece} ₽/шт` : s.kind === 'disable' ? 'исключить из расчёта' : s.value;
    console.log(`      + ${s.id} ${s.kind} → ${what}: ${s.reason}`);
  }
}
for (const [title, list] of [
  ['Вопросы клиенту', a.questions],
  ['Риски', a.risks],
  ['Рекомендации', a.recommendations],
] as const) {
  if (list.length) console.log(`\n${title}:\n${list.map((x) => `  - ${x}`).join('\n')}`);
}
