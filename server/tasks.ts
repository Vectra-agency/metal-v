// Доска задач и доработок сервиса: data/tasks.json (том docker, переживает пересборку), общая для всех, кто вошёл
// по паролю; вложения — data/task-files/<задача>/<файл>. Запись — целиком во временный файл и переименованием;
// раз в день копия в data/tasks-backups/ (хранятся 14 последних). Формат — src/core/tasks.ts.
//
// Учётных записей нет (вход — общий пароль), поэтому каждый запрос на запись несёт имя: by — человек (имя
// запомнено в браузере) или ИИ-агент (CLI scripts/tasks.ts, agent: true).
//
//   GET    /api/tasks[?rev=R]                    доска: задачи, люди, ревизия; та же ревизия — { unchanged: true }
//   POST   /api/tasks                            новая задача { title, description?, kind?, priority?, status?, assignee?, by, agent? }
//   GET    /api/tasks/<id>                       задача
//   PATCH  /api/tasks/<id>                       правка и перенос { by, agent?, title?, …, status?, before?|index?, base?, expect? }
//   DELETE /api/tasks/<id>?by=…                  удалить задачу с вложениями (ответ — удалённая задача)
//   POST   /api/tasks/<id>/comments              комментарий { text, by, agent?, question? }
//   DELETE /api/tasks/<id>/comments/<cid>?by=…   удалить комментарий
//   POST   /api/tasks/<id>/files?name=…&by=…     вложение: тело — сам файл (до 10 МБ; nginx без настройки — до 1 МБ)
//   GET    /api/tasks/<id>/files/<fid>[?download=1]  файл вложения
//   DELETE /api/tasks/<id>/files/<fid>?by=…      удалить вложение

import { randomBytes } from 'node:crypto';
import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cleanName,
  columnTasks,
  isKind,
  isPriority,
  isStatus,
  KIND_LABEL,
  placeTask,
  PRIORITY_LABEL,
  STATUS_LABEL,
  TASK_LIMITS,
  TASKS_VERSION,
  type Task,
  type TaskEvent,
  type TaskFile,
} from '../src/core/tasks.ts';
import { HttpError, parseJson, readRaw, send } from './http.ts';

const BACKUPS_KEEP = 14;

interface TasksState {
  version: number;
  seq: number; // последний выданный номер задачи
  rev: number; // растёт с каждым изменением доски — браузер по нему понимает, что перечитывать
  tasks: Task[];
}

// ревизия для браузера — с меткой запуска: восстановили tasks.json из копии и перезапустили — у всех полная перезагрузка
const BOOT = randomBytes(4).toString('hex');
const revOf = (st: TasksState) => `${BOOT}.${st.rev}`;

let dir = process.env.TASKS_DIR || fileURLToPath(new URL('../data/', import.meta.url));
let cache: TasksState | null = null;

/** Для тестов: доска в другой папке (и сброс кэша) */
export function setTasksDir(d: string): void {
  dir = d;
  cache = null;
}

const file = () => join(dir, 'tasks.json');
const filesDir = (taskId: number) => join(dir, 'task-files', String(taskId));

function load(): TasksState {
  if (cache) return cache;
  const f = file();
  if (!existsSync(f)) return (cache = { version: TASKS_VERSION, seq: 0, rev: 0, tasks: [] });
  try {
    const j = JSON.parse(readFileSync(f, 'utf8')) as Partial<TasksState>;
    const tasks = Array.isArray(j.tasks) ? j.tasks : [];
    cache = {
      version: TASKS_VERSION,
      seq: Math.max(Number(j.seq) || 0, ...tasks.map((t) => t.id)),
      rev: Number(j.rev) || 0,
      tasks,
    };
  } catch (e) {
    // битый файл не затираем молча: первая же запись уничтожила бы все задачи
    console.error('[tasks] не удалось прочитать', f, e);
    throw new HttpError(500, 'Файл задач повреждён — восстановите его из data/tasks-backups/');
  }
  return cache;
}

function backup(): void {
  const f = file();
  if (!existsSync(f)) return;
  const bdir = join(dir, 'tasks-backups');
  const target = join(bdir, `tasks-${new Date().toISOString().slice(0, 10)}.json`);
  if (existsSync(target)) return;
  mkdirSync(bdir, { recursive: true });
  copyFileSync(f, target);
  const old = readdirSync(bdir)
    .filter((n) => /^tasks-\d{4}-\d{2}-\d{2}\.json$/.test(n))
    .sort()
    .slice(0, -BACKUPS_KEEP);
  for (const n of old) unlinkSync(join(bdir, n));
}

function persist(next: TasksState): void {
  mkdirSync(dir, { recursive: true });
  backup(); // копия вчерашнего состояния — до первой записи за день
  const tmp = `${file()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next));
  renameSync(tmp, file());
  cache = next;
}

/** Записать доску с заменённой (или добавленной) задачей; null — задачу удалить */
function commit(st: TasksState, id: number, task: Task | null): void {
  const tasks = task ? (st.tasks.some((t) => t.id === id) ? st.tasks.map((t) => (t.id === id ? task : t)) : [...st.tasks, task]) : st.tasks.filter((t) => t.id !== id);
  persist({ ...st, rev: st.rev + 1, tasks });
}

// ---------- проверка данных ----------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const bad = (what: string): never => {
  throw new HttpError(400, what);
};
const newId = () => randomBytes(9).toString('base64url');

function text(v: unknown, max: number, what: string): string {
  if (typeof v !== 'string') return bad(`${what} — строка`);
  if (v.length > max) bad(`${what}: не длиннее ${max.toLocaleString('ru-RU')} знаков`);
  return v.replace(/\r\n?/g, '\n');
}

function title(v: unknown): string {
  const s = text(v, TASK_LIMITS.title * 2, 'Заголовок').replace(/\s+/g, ' ').trim();
  if (!s) bad('Заголовок задачи пустой');
  if (s.length > TASK_LIMITS.title) bad(`Заголовок: не длиннее ${TASK_LIMITS.title} знаков`);
  return s;
}

function actorOf(v: { by?: unknown; agent?: unknown }): { by: string; agent: boolean } {
  const by = cleanName(v.by);
  if (!by) bad('Не указано, кто вносит изменение (by) — представьтесь на доске');
  return { by, agent: v.agent === true };
}

const assigneeOf = (v: unknown): string | null => (v == null || v === '' ? null : cleanName(v) || null);

function event(actor: { by: string; agent: boolean }, text: string, at: string): TaskEvent {
  return actor.agent ? { at, author: actor.by, agent: true, text } : { at, author: actor.by, text };
}

const withEvents = (t: Task, evs: TaskEvent[]): TaskEvent[] => [...t.events, ...evs].slice(-TASK_LIMITS.events);

function findTask(st: TasksState, id: number): Task {
  const t = st.tasks.find((x) => x.id === id);
  if (!t) throw new HttpError(404, `Задачи #${id} нет — её удалили`);
  return t;
}

/** Люди на доске (авторы, исполнители, комментаторы; без агентов) — недавние первыми */
export function peopleOf(tasks: readonly Task[]): string[] {
  const last = new Map<string, string>();
  const see = (name: string | null | undefined, at: string, agent?: boolean) => {
    if (!name || agent) return;
    if ((last.get(name) ?? '') < at) last.set(name, at);
  };
  for (const t of tasks) {
    see(t.author, t.createdAt, t.agent);
    for (const c of t.comments) see(c.author, c.at, c.agent);
    for (const e of t.events) see(e.author, e.at, e.agent);
  }
  return [...last.entries()].sort((a, b) => b[1].localeCompare(a[1])).map(([n]) => n);
}

// ---------- операции ----------

function createTask(st: TasksState, body: unknown): Task {
  if (!isObj(body)) return bad('Ожидался объект задачи');
  if (st.tasks.length >= TASK_LIMITS.tasks) throw new HttpError(409, `На доске уже ${st.tasks.length} задач — это предел; удалите старые`);
  const actor = actorOf(body);
  const status = body.status == null ? 'backlog' : isStatus(body.status) ? body.status : bad('Неизвестная колонка');
  const now = new Date().toISOString();
  const id = st.seq + 1;
  const col = st.tasks.filter((t) => t.status === status);
  const task: Task = {
    id,
    title: title(body.title),
    description: body.description == null ? '' : text(body.description, TASK_LIMITS.description, 'Описание').trim(),
    status,
    kind: body.kind == null ? 'improvement' : isKind(body.kind) ? body.kind : bad('Неизвестный тип задачи'),
    priority: body.priority == null ? 'normal' : isPriority(body.priority) ? body.priority : bad('Неизвестный приоритет'),
    rank: col.length ? Math.max(...col.map((t) => t.rank)) + 1 : 0,
    author: actor.by,
    assignee: assigneeOf(body.assignee),
    createdAt: now,
    updatedAt: now,
    version: 1,
    comments: [],
    events: [event(actor, `Создана в колонке «${STATUS_LABEL[status]}»`, now)],
    files: [],
  };
  if (actor.agent) task.agent = true;
  st.seq = id;
  return task;
}

/** Правка и перенос. Текст правили с другой версии (base не совпал с текущим) — 409 с актуальной задачей */
function patchTask(st: TasksState, t: Task, body: unknown, res: ServerResponse): { task: Task; ranks: Map<number, number> | null } | null {
  if (!isObj(body)) return bad('Ожидался объект изменений');
  const actor = actorOf(body);
  const now = new Date().toISOString();
  const base = isObj(body.base) ? body.base : null;
  if (base) {
    const changedBySomeone = (k: 'title' | 'description') => typeof base[k] === 'string' && k in body && (base[k] as string).trim() !== t[k].trim();
    if (changedBySomeone('title') || changedBySomeone('description')) {
      send(res, 409, { error: 'Пока вы правили, текст задачи изменил кто-то ещё — показываем свежую версию', task: t });
      return null;
    }
  }
  // ожидаемое состояние (CLI take): задачу уже взял другой агент или её перенесли — 409, а не тихая перезапись
  const expect = isObj(body.expect) ? body.expect : null;
  if (expect) {
    const statusDiffers = 'status' in expect && expect.status !== t.status;
    const assigneeDiffers = 'assignee' in expect && assigneeOf(expect.assignee) !== t.assignee;
    if (statusDiffers || assigneeDiffers) {
      send(res, 409, { error: `Задачу #${t.id} уже изменили: «${STATUS_LABEL[t.status]}»${t.assignee ? `, исполнитель ${t.assignee}` : ''}`, task: t });
      return null;
    }
  }
  const next: Task = { ...t };
  const evs: TaskEvent[] = [];
  const edited: string[] = [];
  if ('title' in body) {
    const v = title(body.title);
    if (v !== t.title) {
      next.title = v;
      edited.push('заголовок');
    }
  }
  if ('description' in body) {
    const v = text(body.description, TASK_LIMITS.description, 'Описание').trim();
    if (v !== t.description) {
      next.description = v;
      edited.push('описание');
    }
  }
  if (edited.length) evs.push(event(actor, `Изменено: ${edited.join(', ')}`, now));
  if ('kind' in body) {
    if (!isKind(body.kind)) bad('Неизвестный тип задачи');
    if (body.kind !== t.kind) {
      next.kind = body.kind as Task['kind'];
      evs.push(event(actor, `Тип: ${KIND_LABEL[next.kind]}`, now));
    }
  }
  if ('priority' in body) {
    if (!isPriority(body.priority)) bad('Неизвестный приоритет');
    if (body.priority !== t.priority) {
      next.priority = body.priority as Task['priority'];
      evs.push(event(actor, `Приоритет: ${PRIORITY_LABEL[next.priority]}`, now));
    }
  }
  if ('question' in body && typeof body.question === 'boolean' && body.question !== !!t.question) {
    if (body.question) next.question = true;
    else delete next.question;
    evs.push(event(actor, body.question ? 'Ждёт ответа на вопрос' : 'Вопрос снят', now));
  }
  let ranks: Map<number, number> | null = null;
  const status = 'status' in body ? (isStatus(body.status) ? body.status : bad('Неизвестная колонка')) : t.status;
  // место в колонке: before — задача, перед которой встать (null — в конец; так перенос не промахнётся, если доска
  // у браузера устарела); index — номер места (CLI --index)
  let index: number | null = null;
  if ('before' in body) {
    const col = columnTasks(st.tasks, status).filter((x) => x.id !== t.id);
    const at = typeof body.before === 'number' ? col.findIndex((x) => x.id === body.before) : -1;
    index = at >= 0 ? at : col.length;
  } else if (typeof body.index === 'number' && Number.isFinite(body.index)) index = body.index;
  if (status !== t.status || index != null) {
    next.status = status;
    ranks = placeTask(st.tasks, next, status, index);
    next.rank = ranks.get(t.id)!;
    if (status !== t.status) {
      evs.push(event(actor, `Колонка: ${STATUS_LABEL[t.status]} → ${STATUS_LABEL[status]}`, now));
      // взяли в работу без исполнителя — исполнитель тот, кто взял
      if (status === 'doing' && !t.assignee && !('assignee' in body)) next.assignee = actor.by;
    }
  }
  if ('assignee' in body) next.assignee = assigneeOf(body.assignee);
  if (next.assignee !== t.assignee) evs.push(event(actor, next.assignee ? `Исполнитель: ${next.assignee}` : 'Исполнитель снят', now));

  const reordered = ranks != null && [...ranks].some(([id, r]) => id !== t.id && st.tasks.find((x) => x.id === id)?.rank !== r);
  if (!evs.length && next.rank === t.rank && !reordered) return { task: t, ranks: null };
  next.events = withEvents(t, evs);
  if (evs.length) {
    next.updatedAt = now;
    next.version = t.version + 1;
  }
  return { task: next, ranks };
}

// ---------- вложения ----------

/** Тип по первым байтам: показываем в браузере только то, что действительно картинка или PDF */
export function sniffType(b: Buffer, name: string): string {
  const head = (n: number) => b.subarray(0, n).toString('latin1');
  if (b.length >= 8 && b[0] === 0x89 && head(4).slice(1) === 'PNG') return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (head(6) === 'GIF87a' || head(6) === 'GIF89a') return 'image/gif';
  if (head(4) === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (head(5) === '%PDF-') return 'application/pdf';
  if (/\.(txt|md|log|csv|json|dxf)$/i.test(name) && !b.subarray(0, 4096).includes(0)) return 'text/plain';
  return 'application/octet-stream';
}

const INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain']);

function fileName(v: string | null): string {
  const s = (v ?? '')
    .replace(/[\u0000-\u001f\u007f/\\]/g, '_')
    .trim()
    .slice(0, TASK_LIMITS.fileName);
  return s || 'файл';
}

const disposition = (kind: 'inline' | 'attachment', name: string) =>
  `${kind}; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;

/** Файл — потоком с диска: десяток крупных скриншотов не держим в памяти контейнера (256 МБ) */
function sendFile(req: IncomingMessage, res: ServerResponse, f: TaskFile, path: string, download: boolean): void {
  const inline = !download && INLINE.has(f.type);
  res.writeHead(200, {
    'Content-Type': f.type === 'text/plain' ? 'text/plain; charset=utf-8' : inline ? f.type : 'application/octet-stream',
    'Content-Length': String(statSync(path).size),
    'Content-Disposition': disposition(inline ? 'inline' : 'attachment', f.name),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=86400',
  });
  if (req.method === 'HEAD') return void res.end();
  const stream = createReadStream(path);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

const filesTotal = (st: TasksState) => st.tasks.reduce((n, t) => n + t.files.reduce((m, f) => m + f.size, 0), 0);
const MB = (n: number) => `${Math.round(n / 1024 / 1024)} МБ`;

// ---------- HTTP ----------

const TASK = /^\/api\/tasks\/(\d{1,7})(?:\/(comments|files)(?:\/([A-Za-z0-9_-]{6,40}))?)?$/;

export async function handleTasks(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  const wrong = () => new HttpError(405, 'Метод не поддерживается');
  const json = async () => parseJson(await readRaw(req, TASK_LIMITS.bodyBytes));
  const queryActor = () => actorOf({ by: url.searchParams.get('by'), agent: url.searchParams.get('agent') === '1' });

  if (path === '/api/tasks') {
    if (method === 'GET') {
      const st = load();
      const rev = revOf(st);
      if (url.searchParams.get('rev') === rev) return send(res, 200, { rev, unchanged: true });
      return send(res, 200, { rev, tasks: st.tasks, people: peopleOf(st.tasks) });
    }
    if (method === 'POST') {
      const body = await json();
      // дальше до записи — без await: другой запрос не вклинится между чтением доски и записью
      const st = { ...load() };
      const task = createTask(st, body);
      commit(st, task.id, task);
      return send(res, 201, task);
    }
    throw wrong();
  }

  const m = TASK.exec(path);
  if (!m) throw new HttpError(404, 'Нет такого метода');
  const id = Number(m[1]);
  const sub = m[2] as 'comments' | 'files' | undefined;
  const subId = m[3];

  if (!sub) {
    if (method === 'GET') return send(res, 200, findTask(load(), id));
    if (method === 'PATCH') {
      const body = await json();
      const st = load();
      const out = patchTask(st, findTask(st, id), body, res);
      if (!out) return; // 409 уже отправлен
      if (out.task === findTask(st, id)) return send(res, 200, out.task);
      const ranks = out.ranks;
      const tasks = st.tasks.map((t) => (t.id === id ? out.task : ranks?.has(t.id) ? { ...t, rank: ranks.get(t.id)! } : t));
      persist({ ...st, rev: st.rev + 1, tasks });
      return send(res, 200, out.task);
    }
    if (method === 'DELETE') {
      queryActor();
      const st = load();
      const t = findTask(st, id);
      commit(st, id, null);
      rmSync(filesDir(id), { recursive: true, force: true });
      console.log(`[tasks] задачу #${id} «${t.title}» удалил(а) ${url.searchParams.get('by')}`);
      return send(res, 200, t);
    }
    throw wrong();
  }

  if (sub === 'comments') {
    if (method === 'POST' && !subId) {
      const body = await json();
      if (!isObj(body)) return bad('Ожидался комментарий');
      const actor = actorOf(body);
      const st = load();
      const t = findTask(st, id);
      if (t.comments.length >= TASK_LIMITS.comments) throw new HttpError(409, 'У задачи слишком много комментариев');
      const msg = text(body.text, TASK_LIMITS.comment, 'Комментарий').trim();
      if (!msg) bad('Комментарий пустой');
      const now = new Date().toISOString();
      const next: Task = { ...t, comments: [...t.comments, { id: newId(), author: actor.by, ...(actor.agent ? { agent: true } : {}), text: msg, at: now }], updatedAt: now, version: t.version + 1 };
      // вопрос агента: задача ждёт ответа; ответил человек — вопрос снят
      if (actor.agent && body.question === true) {
        next.question = true;
        next.events = withEvents(t, [event(actor, 'Задан вопрос — ждёт ответа', now)]);
      } else if (!actor.agent && t.question) {
        delete next.question;
        next.events = withEvents(t, [event(actor, 'Ответ на вопрос агента', now)]);
      }
      commit(st, id, next);
      return send(res, 201, next);
    }
    if (method === 'DELETE' && subId) {
      const actor = queryActor();
      const st = load();
      const t = findTask(st, id);
      const c = t.comments.find((x) => x.id === subId);
      if (!c) throw new HttpError(404, 'Комментария нет — его уже удалили');
      const now = new Date().toISOString();
      const next: Task = {
        ...t,
        comments: t.comments.filter((x) => x.id !== subId),
        events: withEvents(t, [event(actor, `Удалён комментарий: ${c.author}`, now)]),
        updatedAt: now,
        version: t.version + 1,
      };
      commit(st, id, next);
      return send(res, 200, next);
    }
    throw wrong();
  }

  // вложения
  if (method === 'POST' && !subId) {
    const actor = queryActor();
    // проверки — до тела (не тратим память на заведомо лишний файл) и ещё раз после: пока шёл файл, шли и другие
    const check = (st: TasksState, size: number): Task => {
      const t = findTask(st, id); // могли удалить, пока шёл файл
      if (t.files.length >= TASK_LIMITS.files) throw new HttpError(409, `У задачи уже ${t.files.length} вложений — это предел`);
      if (filesTotal(st) + size > TASK_LIMITS.totalFileBytes) throw new HttpError(507, `Место для вложений кончилось (${MB(TASK_LIMITS.totalFileBytes)}) — удалите старые вложения или задачи`);
      return t;
    };
    check(load(), Number(req.headers['content-length']) || 0);
    const bytes = await readRaw(req, TASK_LIMITS.fileBytes);
    if (!bytes.length) bad('Файл пустой');
    const st = load();
    const t = check(st, bytes.length);
    const name = fileName(url.searchParams.get('name'));
    const now = new Date().toISOString();
    const f: TaskFile = { id: newId(), name, type: sniffType(bytes, name), size: bytes.length, at: now, author: actor.by };
    const p = join(filesDir(id), f.id);
    mkdirSync(filesDir(id), { recursive: true });
    writeFileSync(p, bytes);
    const next: Task = { ...t, files: [...t.files, f], events: withEvents(t, [event(actor, `Вложение: ${name}`, now)]), updatedAt: now, version: t.version + 1 };
    try {
      commit(st, id, next);
    } catch (e) {
      rmSync(p, { force: true }); // запись доски не удалась — файл без записи о нём не оставляем
      throw e;
    }
    return send(res, 201, next);
  }
  if (subId && (method === 'GET' || method === 'HEAD' || method === 'DELETE')) {
    const st = load();
    const t = findTask(st, id);
    const f = t.files.find((x) => x.id === subId);
    if (!f) throw new HttpError(404, 'Вложения нет — его удалили');
    const p = join(filesDir(id), f.id);
    if (method === 'DELETE') {
      const actor = queryActor();
      const now = new Date().toISOString();
      const next: Task = { ...t, files: t.files.filter((x) => x.id !== f.id), events: withEvents(t, [event(actor, `Удалено вложение: ${f.name}`, now)]), updatedAt: now, version: t.version + 1 };
      commit(st, id, next);
      rmSync(p, { force: true });
      return send(res, 200, next);
    }
    if (!existsSync(p)) throw new HttpError(404, 'Файл вложения пропал с диска');
    return sendFile(req, res, f, p, url.searchParams.get('download') === '1');
  }
  throw wrong();
}
