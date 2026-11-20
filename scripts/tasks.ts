// Доска задач из терминала — связка доски на сайте с ИИ-агентами (Claude Code, Codex, Cursor…), которые работают
// с кодом локально. Без зависимостей: node scripts/tasks.ts <команда> (или npm run tasks -- <команда>).
//
// Вход — тот же пароль сайта: `login` один раз (cookie на 30 дней в .tasks/session.json, в git её нет).
// Записи из CLI помечаются как сделанные ИИ-агентом (имя — --as, TASKS_AGENT или «ИИ-агент»);
// человеку из терминала — --human --as "Имя".
//
// Порядок работы агента (подробно — .claude/skills/tasks/SKILL.md):
//   pull → next → take <id> → код и проверки → review <id> -m "что сделано";
//   неясно — ask <id> -m "вопрос": задача ждёт ответа и не попадает в next, пока человек не ответит.

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cleanName,
  columnTasks,
  DEFAULT_AGENT_NAME,
  isKind,
  isPriority,
  isStatus,
  KIND_LABEL,
  nextTask,
  PRIORITY_LABEL,
  slug,
  STATUS_LABEL,
  TASK_STATUSES,
  taskMarkdown,
  taskRef,
  type Task,
  type TasksBoard,
  type TaskStatus,
} from '../src/core/tasks.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIR = join(ROOT, '.tasks');
const SESSION = join(DIR, 'session.json');
const DEFAULT_URL = 'https://metal.vectra-agency.tech';
const AUTH_COOKIE = 'mc_auth';

try {
  process.loadEnvFile(join(ROOT, '.env')); // TASKS_URL, METAL_PASSWORD, TASKS_AGENT — по желанию
} catch {
  /* файла нет */
}

// ---------- аргументы ----------

const HELP = `Доска задач из терминала (сайт: ${DEFAULT_URL}/tasks)

  login [--url URL]           войти по паролю сайта (METAL_PASSWORD или спросит); вход на 30 дней
  logout                      забыть вход
  status                      куда подключён, вошёл ли, сколько задач в колонках
  pull                        скачать доску в .tasks/: BOARD.md, задача на файл, вложения
  list [колонки…] [--all]     задачи (по умолчанию: К работе, В работе, На проверке)
  next                        следующая задача из «К работе» целиком; очереди нет — код выхода 3
  show <id>                   задача целиком (вложения скачиваются в .tasks/files/<id>/)
  take <id> [-m текст]        взять в работу: «В работе», исполнитель — агент
  comment <id> -m текст       комментарий (или --file путь, или -m - для stdin)
  ask <id> -m вопрос          вопрос автору: задача ждёт ответа и не попадает в next
  review <id> -m отчёт        готово: отчёт комментарием и перенос в «На проверке»
  move <id> <колонка>         перенести (${TASK_STATUSES.join(', ')}); --index N — место в колонке
  create --title T [-m описание] [--kind ${['feature', 'improvement', 'bug'].join('|')}] [--priority low|normal|high|urgent] [--status …]
  attach <id> <файл…>         приложить файлы

  Общие флаги: --url URL (или TASKS_URL), --as "Имя" (или TASKS_AGENT; по умолчанию «${DEFAULT_AGENT_NAME}»),
  --human — запись от человека, а не от агента; --json — ответ JSON (list, next, show, status).`;

interface Args {
  cmd: string;
  pos: string[];
  flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set(['url', 'as', 'm', 'message', 'file', 'title', 'kind', 'priority', 'status', 'index']);

function parseArgs(argv: string[]): Args {
  const pos: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const m = /^--?([a-z][\w-]*)(?:=(.*))?$/i.exec(a);
    if (!m || a === '-') {
      pos.push(a);
      continue;
    }
    const name = m[1] === 'message' ? 'm' : m[1];
    if (m[2] !== undefined) flags.set(name, m[2]);
    else if (VALUE_FLAGS.has(name) && i + 1 < argv.length) flags.set(name, argv[++i]);
    else flags.set(name, true);
  }
  return { cmd: pos.shift() ?? 'help', pos, flags };
}

class CliError extends Error {
  readonly code: number;
  constructor(message: string, code = 1) {
    super(message);
    this.code = code;
  }
}

const fail = (msg: string, code = 1): never => {
  throw new CliError(msg, code);
};

// ---------- сессия и HTTP ----------

interface Session {
  url: string;
  cookie: string | null; // null — сервер без пароля (локальная разработка)
  expiresAt?: string | null;
}

function readSession(): Session | null {
  try {
    return JSON.parse(readFileSync(SESSION, 'utf8')) as Session;
  } catch {
    return null;
  }
}

function writeSession(s: Session): void {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(SESSION, JSON.stringify(s, null, 2), { mode: 0o600 }); // cookie входа — только владельцу
  chmodSync(SESSION, 0o600); // файл мог быть и раньше, с другими правами
}

const trimUrl = (u: string) => u.replace(/\/+$/, '');

function baseUrl(a: Args): string {
  const f = a.flags.get('url');
  return trimUrl(typeof f === 'string' ? f : process.env.TASKS_URL || readSession()?.url || DEFAULT_URL);
}

function cookieFor(url: string): string | null {
  const s = readSession();
  return s && trimUrl(s.url) === url ? s.cookie : null;
}

async function http(a: Args, method: string, path: string, body?: unknown, raw?: Buffer): Promise<Response> {
  const url = baseUrl(a);
  const headers: Record<string, string> = {};
  const cookie = cookieFor(url);
  if (cookie) headers.Cookie = `${AUTH_COOKIE}=${cookie}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (raw) headers['Content-Type'] = 'application/octet-stream';
  let r: Response;
  try {
    r = await fetch(url + path, { method, headers, body: raw ? Uint8Array.from(raw) : body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) {
    return fail(`Нет связи с ${url}: ${(e as Error).message}`);
  }
  if (r.status === 401) fail(`Нужно войти на ${url}: node scripts/tasks.ts login${url === DEFAULT_URL ? '' : ` --url ${url}`} (в своём терминале — спросит пароль сайта)`);
  if (r.status === 413) fail('Файл слишком большой для сервера: nginx без настройки принимает до 1 МБ (DEPLOY.md, раздел «Задачи»)');
  return r;
}

async function call<T>(a: Args, method: string, path: string, body?: unknown, raw?: Buffer): Promise<T> {
  const r = await http(a, method, path, body, raw);
  const j = (await r.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!r.ok || !j) fail(j?.error ?? `Ошибка ${r.status} от ${baseUrl(a)}${path}`);
  return j as T;
}

function actor(a: Args): { by: string; agent: boolean } {
  const human = a.flags.has('human');
  const as = a.flags.get('as');
  // TASKS_AGENT — имя агента; человеку из терминала имя — только явно через --as
  const by = cleanName(typeof as === 'string' ? as : human ? '' : process.env.TASKS_AGENT || DEFAULT_AGENT_NAME);
  if (!by) fail('Для --human укажите имя: --as "Имя"');
  return { by, agent: !human };
}

const qs = (o: Record<string, string>) => new URLSearchParams(o).toString();
const getBoard = (a: Args) => call<TasksBoard>(a, 'GET', '/api/tasks');
const getTask = (a: Args, id: number) => call<Task>(a, 'GET', `/api/tasks/${id}`);

/** Лишние слова после команды — почти всегда текст без кавычек: -m Исправил баг → «Исправил», остальное потерялось бы */
function noExtra(a: Args, max: number): void {
  if (a.pos.length > max) fail(`Лишнее: «${a.pos.slice(max).join(' ')}». Текст — в кавычках: -m "…"`, 2);
}

function idArg(a: Args, i = 0): number {
  const s = (a.pos[i] ?? '').replace(/^#/, '');
  if (!/^\d{1,7}$/.test(s)) fail(`Укажите номер задачи: ${a.cmd} <id>`, 2);
  return Number(s);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Текст из -m, -m - (stdin) или --file */
async function message(a: Args, required: string | null): Promise<string> {
  const m = a.flags.get('m');
  const f = a.flags.get('file');
  let s = '';
  if (m === '-') s = await readStdin();
  else if (typeof m === 'string') s = m;
  else if (typeof f === 'string') s = readFileSync(f, 'utf8');
  s = s.trim();
  if (!s && required) fail(required, 2);
  return s;
}

// ---------- вложения и Markdown ----------

const taskUrl = (a: Args, id: number) => `${baseUrl(a)}/tasks?task=${id}`;
const safeFile = (s: string) => s.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_').slice(0, 120) || 'file';

/** Скачать вложения задачи в .tasks/files/<id>/; ответ — id файла → путь (от .tasks/ или абсолютный) */
async function downloadFiles(a: Args, t: Task, absolute: boolean): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!t.files.length) return out;
  const dir = join(DIR, 'files', String(t.id));
  mkdirSync(dir, { recursive: true });
  for (const f of t.files) {
    const p = join(dir, `${f.id.slice(0, 6)}-${safeFile(f.name)}`);
    if (!existsSync(p)) {
      const r = await http(a, 'GET', `/api/tasks/${t.id}/files/${f.id}?download=1`);
      if (!r.ok) {
        console.error(`  не скачалось вложение ${f.name}: ${r.status}`);
        continue;
      }
      writeFileSync(p, Buffer.from(await r.arrayBuffer()));
    }
    out[f.id] = absolute ? p : relative(DIR, p);
  }
  // удалённые на доске вложения — убрать и локально
  const keep = new Set(Object.values(out).map((p) => basename(p)));
  for (const n of readdirSync(dir)) if (!keep.has(n)) rmSync(join(dir, n), { force: true });
  return out;
}

const fileOf = (t: Task) => `${t.id}-${slug(t.title)}.md`;

function line(t: Task): string {
  const bits = [KIND_LABEL[t.kind]];
  if (t.priority !== 'normal') bits.push(PRIORITY_LABEL[t.priority].toLowerCase());
  if (t.assignee) bits.push(`исп.: ${t.assignee}`);
  if (t.question) bits.push('ЖДЁТ ОТВЕТА');
  if (t.comments.length) bits.push(`комм.: ${t.comments.length}`);
  if (t.files.length) bits.push(`влож.: ${t.files.length}`);
  return `${taskRef(t.id)} ${t.title} — ${bits.join(', ')}`;
}

function counts(b: TasksBoard): string {
  return TASK_STATUSES.map((s) => `${STATUS_LABEL[s]}: ${b.tasks.filter((t) => t.status === s).length}`).join(' · ');
}

const DONE_KEEP = 20;

// ---------- команды ----------

async function askHidden(q: string): Promise<string> {
  if (!process.stdin.isTTY) fail('Пароль: задайте METAL_PASSWORD или запустите login в терминале', 2);
  process.stdout.write(q);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  return new Promise((resolve) => {
    let s = '';
    const done = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off('data', on);
      process.stdout.write('\n');
      resolve(s);
    };
    const on = (chunk: string) => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n') return done();
        if (c === '\u0003') {
          process.stdin.setRawMode(false);
          process.exit(130);
        }
        if (c === '\u007f' || c === '\b') s = s.slice(0, -1);
        else s += c;
      }
    };
    process.stdin.on('data', on);
  });
}

async function login(a: Args): Promise<void> {
  const url = baseUrl(a);
  let st: Response;
  try {
    st = await fetch(`${url}/api/auth/status`);
  } catch (e) {
    return fail(`Нет связи с ${url}: ${(e as Error).message}`);
  }
  if (st.ok) {
    const j = (await st.json().catch(() => null)) as { enabled?: boolean } | null;
    if (j && j.enabled === false) {
      writeSession({ url, cookie: null });
      console.log(`${url}: вход не нужен (пароль на сервере не задан). Запомнил адрес.`);
      return;
    }
  }
  const password = process.env.METAL_PASSWORD || (await askHidden(`Пароль сайта ${url}: `));
  if (!password) fail('Пароль пустой', 2);
  const r = await fetch(`${url}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  if (!r.ok) {
    const j = (await r.json().catch(() => null)) as { error?: string } | null;
    fail(j?.error ?? `Вход не удался: ${r.status}`);
  }
  const set = r.headers.getSetCookie().find((c) => c.startsWith(`${AUTH_COOKIE}=`));
  const cookie = set?.slice(AUTH_COOKIE.length + 1).split(';')[0];
  if (!cookie) fail('Сервер не выдал cookie входа');
  const maxAge = Number(/Max-Age=(\d+)/i.exec(set ?? '')?.[1] ?? 0);
  const expiresAt = maxAge ? new Date(Date.now() + maxAge * 1000).toISOString() : null;
  writeSession({ url, cookie: cookie!, expiresAt });
  console.log(`Вошёл на ${url}${expiresAt ? ` до ${expiresAt.slice(0, 10)}` : ''}. Сессия — ${relative(process.cwd(), SESSION)} (в git её нет).`);
}

async function status(a: Args): Promise<void> {
  const url = baseUrl(a);
  const s = readSession();
  const b = await getBoard(a);
  const next = nextTask(b.tasks);
  if (a.flags.has('json')) return void console.log(JSON.stringify({ url, expiresAt: s?.expiresAt ?? null, rev: b.rev, next: next?.id ?? null }));
  console.log(`${url} · вход ${s?.cookie ? `до ${(s.expiresAt ?? '').slice(0, 10) || '?'}` : 'не нужен'} · пишу как «${actor(a).by}»`);
  console.log(counts(b));
  console.log(next ? `Следующая: ${line(next)}` : 'В «К работе» задач для агента нет');
}

async function pull(a: Args): Promise<void> {
  const b = await getBoard(a);
  mkdirSync(DIR, { recursive: true });
  const keep = new Set<string>();
  const out: string[] = [`# Доска задач`, '', `Скачано ${new Date().toLocaleString('ru-RU')} с ${baseUrl(a)}/tasks · ${counts(b)}`, ''];
  const next = nextTask(b.tasks);
  out.push(next ? `Следующая для агента: [${taskRef(next.id)} ${next.title}](${fileOf(next)})` : 'Задач для агента в «К работе» нет.', '');
  for (const s of TASK_STATUSES) {
    let col = columnTasks(b.tasks, s);
    if (s === 'done') col = col.sort((x, y) => y.updatedAt.localeCompare(x.updatedAt)).slice(0, DONE_KEEP);
    out.push(`## ${STATUS_LABEL[s]} (\`${s}\`)${s === 'done' && col.length === DONE_KEEP ? ` — последние ${DONE_KEEP}` : ''}`, '');
    if (!col.length) out.push('_пусто_');
    for (const t of col) {
      const f = fileOf(t);
      keep.add(f);
      const files = s === 'done' ? {} : await downloadFiles(a, t, false);
      writeFileSync(join(DIR, f), taskMarkdown(t, { files, url: taskUrl(a, t.id) }));
      out.push(`- [${line(t)}](${f})`);
    }
    out.push('');
  }
  out.push('Работа с задачами: node scripts/tasks.ts help');
  writeFileSync(join(DIR, 'BOARD.md'), `${out.join('\n')}\n`);
  writeFileSync(join(DIR, 'board.json'), JSON.stringify(b, null, 2));
  for (const n of readdirSync(DIR)) if (/^\d+-.*\.md$/.test(n) && !keep.has(n)) rmSync(join(DIR, n));
  console.log(`Доска → ${relative(process.cwd(), join(DIR, 'BOARD.md'))} · ${counts(b)}`);
  console.log(next ? `Следующая: ${line(next)} → ${relative(process.cwd(), join(DIR, fileOf(next)))}` : 'В «К работе» задач для агента нет');
}

async function list(a: Args): Promise<void> {
  const b = await getBoard(a);
  const want = a.pos.length ? a.pos : a.flags.has('all') ? [...TASK_STATUSES] : ['todo', 'doing', 'review'];
  for (const s of want) if (!isStatus(s)) fail(`Нет колонки «${s}»: ${TASK_STATUSES.join(', ')}`, 2);
  const cols = want as TaskStatus[];
  if (a.flags.has('json')) return void console.log(JSON.stringify(b.tasks.filter((t) => cols.includes(t.status))));
  for (const s of cols) {
    const col = columnTasks(b.tasks, s);
    console.log(`\n${STATUS_LABEL[s]} (${s}) — ${col.length}`);
    for (const t of col) console.log(`  ${line(t)}`);
  }
}

async function printTask(a: Args, t: Task): Promise<void> {
  const files = await downloadFiles(a, t, true);
  if (a.flags.has('json')) return void console.log(JSON.stringify({ ...t, localFiles: files }));
  process.stdout.write(taskMarkdown(t, { files, url: taskUrl(a, t.id) }));
}

async function next(a: Args): Promise<void> {
  const t = nextTask((await getBoard(a)).tasks);
  if (!t) fail('В «К работе» задач для агента нет (задачи с вопросом без ответа пропускаются)', 3);
  await printTask(a, t!);
}

const patch = (a: Args, id: number, body: Record<string, unknown>) => call<Task>(a, 'PATCH', `/api/tasks/${id}`, { ...body, ...actor(a) });
const comment = (a: Args, id: number, text: string, question = false) =>
  call<Task>(a, 'POST', `/api/tasks/${id}/comments`, { text, ...(question ? { question: true } : {}), ...actor(a) });

async function take(a: Args): Promise<void> {
  const id = idArg(a);
  const me = actor(a).by;
  const t = await getTask(a, id);
  if (!a.flags.has('force')) {
    if (t.status === 'doing' && t.assignee && t.assignee !== me) fail(`${taskRef(id)} уже в работе у «${t.assignee}» — --force, если точно брать`);
    if (t.status === 'done') fail(`${taskRef(id)} уже в «Готово» — --force, если точно брать`);
    if (t.question) fail(`${taskRef(id)} ждёт ответа на вопрос — сначала ответ человека (или --force)`);
  }
  const text = await message(a, null);
  // expect: если между проверкой и переносом задачу взял другой агент — сервер ответит 409, а не перезапишет
  const r = await patch(a, id, { status: 'doing', assignee: me, expect: { status: t.status, assignee: t.assignee } });
  if (text) await comment(a, id, text);
  console.log(`${line(r)} → «${STATUS_LABEL[r.status]}»`);
}

async function moveTo(a: Args, id: number, status: TaskStatus, index?: number): Promise<void> {
  const r = await patch(a, id, index == null ? { status } : { status, index });
  console.log(`${line(r)} → «${STATUS_LABEL[r.status]}»`);
}

async function create(a: Args): Promise<void> {
  const title = a.flags.get('title');
  if (typeof title !== 'string' || !title.trim()) fail('Нужен заголовок: create --title "…"', 2);
  const kind = a.flags.get('kind');
  const priority = a.flags.get('priority');
  const st = a.flags.get('status');
  if (kind !== undefined && !isKind(kind)) fail('--kind: feature, improvement или bug', 2);
  if (priority !== undefined && !isPriority(priority)) fail('--priority: low, normal, high или urgent', 2);
  if (st !== undefined && !isStatus(st)) fail(`--status: ${TASK_STATUSES.join(', ')}`, 2);
  const t = await call<Task>(a, 'POST', '/api/tasks', { title, description: await message(a, null), kind, priority, status: st, ...actor(a) });
  console.log(`Создана ${line(t)} в «${STATUS_LABEL[t.status]}» · ${taskUrl(a, t.id)}`);
}

async function attach(a: Args): Promise<void> {
  const id = idArg(a);
  const paths = a.pos.slice(1);
  if (!paths.length) fail('Укажите файлы: attach <id> <файл…>', 2);
  const who = actor(a);
  for (const p of paths) {
    const bytes = readFileSync(p);
    const t = await call<Task>(a, 'POST', `/api/tasks/${id}/files?${qs({ name: basename(p), by: who.by, ...(who.agent ? { agent: '1' } : {}) })}`, undefined, bytes);
    console.log(`${basename(p)} → ${taskRef(id)} (вложений: ${t.files.length})`);
  }
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  switch (a.cmd) {
    case 'help':
    case '--help':
    case '-h':
      return void console.log(HELP);
    case 'login':
      return login(a);
    case 'logout':
      rmSync(SESSION, { force: true });
      return void console.log('Вход забыт');
    case 'status':
      return status(a);
    case 'pull':
      return pull(a);
    case 'list':
      return list(a);
    case 'next':
      return next(a);
    case 'show':
      noExtra(a, 1);
      return printTask(a, await getTask(a, idArg(a)));
    case 'take':
      noExtra(a, 1);
      return take(a);
    case 'comment': {
      noExtra(a, 1);
      const id = idArg(a);
      const t = await comment(a, id, await message(a, 'Нужен текст: comment <id> -m "…"'));
      return void console.log(`Комментарий к ${line(t)}`);
    }
    case 'ask': {
      noExtra(a, 1);
      const id = idArg(a);
      const t = await comment(a, id, await message(a, 'Нужен вопрос: ask <id> -m "…"'), true);
      return void console.log(`Вопрос задан: ${line(t)}`);
    }
    case 'review': {
      noExtra(a, 1);
      const id = idArg(a);
      await comment(a, id, await message(a, 'Нужен отчёт: review <id> -m "что сделано, где, как проверить"'));
      return moveTo(a, id, 'review');
    }
    case 'move': {
      const id = idArg(a);
      const s = a.pos[1];
      if (!isStatus(s)) fail(`Колонка: ${TASK_STATUSES.join(', ')}`, 2);
      noExtra(a, 2);
      const index = a.flags.get('index');
      if (index !== undefined && (typeof index !== 'string' || !/^\d{1,5}$/.test(index))) fail('--index — номер места в колонке: 0, 1, 2…', 2);
      return moveTo(a, id, s as TaskStatus, typeof index === 'string' ? Number(index) : undefined);
    }
    case 'create':
      noExtra(a, 0);
      return create(a);
    case 'attach':
      return attach(a);
    default:
      fail(`Нет команды «${a.cmd}». Список: node scripts/tasks.ts help`, 2);
  }
}

main().catch((e: unknown) => {
  if (e instanceof CliError) {
    console.error(e.message);
    process.exit(e.code);
  }
  console.error(e);
  process.exit(1);
});
