// Доска задач в браузере: своё маленькое хранилище (отдельно от заказа), экран в адресе (/tasks, ?task=12),
// имя того, кто пишет (спрашиваем при первой записи и запоминаем на устройстве), действия с задачами.
// Доска перечитывается раз в 15 с, пока открыта (сервер отвечает «не менялось», если ревизия та же).
import { toast } from 'sonner';
import {
  cleanName,
  columnTasks,
  placeTask,
  type Task,
  type TaskActor,
  type TaskDraft,
  type TaskKind,
  type TaskPatch,
  type TasksBoard,
  type TaskStatus,
} from '../core/tasks.ts';
import { createStore, useSelector } from '../store/createStore.ts';
import * as api from './api.ts';
import { TasksApiError } from './api.ts';

export type Screen = 'calc' | 'tasks';

export interface TaskFilter {
  q: string;
  kind: 'all' | TaskKind;
  person: string; // '' — все; иначе автор или исполнитель
}

export interface TasksState {
  screen: Screen;
  board: TasksBoard | null;
  loading: boolean;
  error: string | null;
  openId: number | null; // открытая карточка задачи
  creating: { status: TaskStatus } | null; // диалог «Новая задача»
  naming: boolean; // диалог «Как вас зовут?»
  agentHelp: boolean; // диалог «ИИ-агенты»
  me: string; // имя на этом устройстве ('' — ещё не представились)
  filter: TaskFilter;
  allDone: boolean; // показывать все готовые, а не за последние 14 дней
}

const K_ME = 'metalcalc.me.v1';

function loadMe(): string {
  try {
    return cleanName(localStorage.getItem(K_ME));
  } catch {
    return '';
  }
}

// ---------- адрес ----------

// только /tasks без слэша на конце: с ним относительные адреса сборки (base './') ведут в /tasks/assets/ (сервер перенаправляет)
const onTasksPath = (): boolean => typeof location !== 'undefined' && /\/tasks$/.test(location.pathname);
const queryTask = (): number | null => {
  const v = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('task');
  return v && /^\d{1,7}$/.test(v) ? Number(v) : null;
};
// относительно текущего адреса: сайт может жить и не в корне домена
const tasksPath = (id?: number | null) => `${new URL('./tasks', location.href).pathname}${id ? `?task=${id}` : ''}`;
const calcPath = () => new URL('./', location.href).pathname;

export const tasksStore = createStore<TasksState>({
  screen: onTasksPath() ? 'tasks' : 'calc',
  board: null,
  loading: false,
  error: null,
  openId: onTasksPath() ? queryTask() : null,
  creating: null,
  naming: false,
  agentHelp: false,
  me: loadMe(),
  filter: { q: '', kind: 'all', person: '' },
  allDone: false,
});

export const getTasks = (): TasksState => tasksStore.get();
/** Селектор — примитив или существующая ссылка (не новый объект) */
export const useTasks = <T>(sel: (s: TasksState) => T): T => useSelector(tasksStore, sel);
export const patchTasks = (p: Partial<TasksState>): void => tasksStore.set((s) => ({ ...s, ...p }));

export function goTasks(openId: number | null = null): void {
  if (getTasks().screen !== 'tasks') history.pushState(history.state, '', tasksPath(openId));
  else history.replaceState(history.state, '', tasksPath(openId));
  patchTasks({ screen: 'tasks', openId });
  window.scrollTo(0, 0);
}

/** К калькулятору; hash — вкладка расчёта, на которой были (#metal…) */
export function goCalc(hash = ''): void {
  history.pushState(history.state, '', calcPath() + hash);
  patchTasks({ screen: 'calc', openId: null, creating: null });
}

export function openTask(id: number | null): void {
  patchTasks({ openId: id });
  if (getTasks().screen === 'tasks') history.replaceState(history.state, '', tasksPath(id));
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    const tasks = onTasksPath();
    patchTasks({ screen: tasks ? 'tasks' : 'calc', openId: tasks ? queryTask() : null });
  });
}

// ---------- кто пишет ----------

let nameWaiters: ((name: string | null) => void)[] = [];

function settleName(name: string | null): void {
  const w = nameWaiters;
  nameWaiters = [];
  for (const f of w) f(name);
}

/** Имя для записи на доску: уже есть — сразу; нет — спросим (null — отказались) */
export function ensureName(): Promise<string | null> {
  const me = getTasks().me;
  if (me) return Promise.resolve(me);
  patchTasks({ naming: true });
  return new Promise((resolve) => nameWaiters.push(resolve));
}

export function saveName(raw: string): string | null {
  const name = cleanName(raw);
  if (!name) return null;
  try {
    localStorage.setItem(K_ME, name);
  } catch {
    /* хранилище недоступно — имя до перезагрузки */
  }
  patchTasks({ me: name, naming: false });
  settleName(name);
  return name;
}

export function cancelNaming(): void {
  patchTasks({ naming: false });
  settleName(null);
}

// ---------- доска ----------

let pending = 0; // идут записи: ответ опроса может быть старее, чем показанный перенос
let loadSeq = 0;

export async function refreshBoard(full = false): Promise<void> {
  if (pending) return;
  const s = getTasks();
  const seq = ++loadSeq;
  if (!s.board) patchTasks({ loading: true });
  try {
    const r = await api.loadBoard(full || !s.board ? null : s.board.rev);
    if (seq !== loadSeq || pending) return;
    if ('unchanged' in r) patchTasks({ loading: false, error: null });
    else patchTasks({ board: r, loading: false, error: null });
  } catch (e) {
    if (seq !== loadSeq) return;
    patchTasks({ loading: false, error: (e as Error).message });
  }
}

function putTask(t: Task): void {
  const b = getTasks().board;
  if (!b) return;
  const has = b.tasks.some((x) => x.id === t.id);
  patchTasks({ board: { ...b, tasks: has ? b.tasks.map((x) => (x.id === t.id ? t : x)) : [...b.tasks, t] } });
}

function dropTask(id: number): void {
  const b = getTasks().board;
  if (b) patchTasks({ board: { ...b, tasks: b.tasks.filter((x) => x.id !== id) } });
}

/** Запись на доску от имени того, кто за этим устройством; ошибка — уведомлением, затем доска перечитывается */
async function write<T>(fn: (a: TaskActor) => Promise<T>, o: { optimistic?: () => void; quiet409?: boolean } = {}): Promise<T | null> {
  const by = await ensureName();
  if (!by) return null;
  pending++;
  const before = getTasks().board;
  o.optimistic?.();
  const shown = getTasks().board;
  let failed = false;
  try {
    return await fn({ by });
  } catch (e) {
    failed = true;
    const err = e as TasksApiError;
    if (err.task) putTask(err.task);
    // откат показанного сразу — только если с тех пор доска не менялась (иначе затёрли бы чужие ответы); дальше —
    // полное перечитывание
    else if (o.optimistic && before && getTasks().board === shown) patchTasks({ board: before });
    if (!(o.quiet409 && err.status === 409)) toast.error(err.message || 'Не удалось сохранить');
    if (o.quiet409 && err.status === 409) throw err;
    return null;
  } finally {
    pending--;
    if (!pending) void refreshBoard(failed);
  }
}

export async function createTask(draft: TaskDraft, files: File[]): Promise<Task | null> {
  const t = await write((a) => api.createTask(draft, a));
  if (!t) return null;
  putTask(t);
  patchTasks({ creating: null });
  if (files.length) await uploadFiles(t.id, files);
  toast.success(`Задача #${t.id} создана`, { action: { label: 'Открыть', onClick: () => openTask(t.id) } });
  return t;
}

/**
 * Перенос карточки: сразу на доске, затем на сервере. before — задача, перед которой встать (null — в конец колонки):
 * сосед, а не номер места — если доска у вас устарела, карточка всё равно встанет куда бросили
 */
export function moveTask(id: number, status: TaskStatus, before: number | null): void {
  void write((a) => api.patchTask(id, { status, before }, a).then((r) => (putTask(r), r)), {
    // доска — на момент переноса (пока спрашивали имя, её могли перечитать)
    optimistic: () => {
      const b = getTasks().board;
      const t = b?.tasks.find((x) => x.id === id);
      if (!b || !t) return;
      const moved = { ...t, status };
      const col = columnTasks(b.tasks, status).filter((x) => x.id !== id);
      const at = before == null ? -1 : col.findIndex((x) => x.id === before);
      const ranks = placeTask(b.tasks, moved, status, at >= 0 ? at : null);
      patchTasks({ board: { ...b, tasks: b.tasks.map((x) => (x.id === id ? { ...moved, rank: ranks.get(id)! } : ranks.has(x.id) ? { ...x, rank: ranks.get(x.id)! } : x)) } });
    },
  });
}

/** Тип, приоритет, исполнитель, вопрос (колонка — moveTask, текст — saveText) */
export async function updateTask(id: number, p: Pick<TaskPatch, 'kind' | 'priority' | 'assignee' | 'question'>): Promise<void> {
  const t = getTasks().board?.tasks.find((x) => x.id === id);
  await write((a) => api.patchTask(id, p, a).then((r) => (putTask(r), r)), {
    optimistic: t ? () => putTask({ ...t, ...p, assignee: 'assignee' in p ? (p.assignee ?? null) : t.assignee }) : undefined,
  });
}

export type SaveText = { ok: true } | { ok: false; conflict: Task | null };

/** Заголовок и описание: base — текст, с которого начали править (чужая правка за это время — конфликт) */
export async function saveText(id: number, p: { title?: string; description?: string }, base: { title: string; description: string }): Promise<SaveText> {
  try {
    const r = await write((a) => api.patchTask(id, { ...p, base }, a), { quiet409: true });
    if (!r) return { ok: false, conflict: null };
    putTask(r);
    return { ok: true };
  } catch (e) {
    return { ok: false, conflict: (e as TasksApiError).task };
  }
}

export async function addComment(id: number, text: string): Promise<boolean> {
  const r = await write((a) => api.addComment(id, text, a));
  if (r) putTask(r);
  return !!r;
}

export async function removeComment(id: number, cid: string): Promise<void> {
  const r = await write((a) => api.deleteComment(id, cid, a));
  if (r) putTask(r);
}

export async function removeTask(id: number): Promise<void> {
  const r = await write((a) => api.deleteTask(id, a));
  if (!r) return;
  if (getTasks().openId === id) openTask(null);
  dropTask(id);
  toast.success(`Задача #${id} удалена`);
}

// ---------- вложения ----------

const SOFT_LIMIT = 950_000; // nginx без настройки пропускает до 1 МБ

/** Большой скриншот → JPEG поменьше (по длинной стороне до 2400 px, качество 0,85); не вышло — как есть */
async function shrinkImage(f: File): Promise<{ blob: Blob; name: string }> {
  if (f.size <= SOFT_LIMIT || !/^image\/(png|jpeg|webp)$/.test(f.type) || typeof createImageBitmap !== 'function') return { blob: f, name: f.name };
  try {
    const bmp = await createImageBitmap(f);
    let scale = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
    let out: Blob | null = null;
    for (let i = 0; i < 5 && (!out || out.size > SOFT_LIMIT); i++, scale *= 0.75) {
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(bmp.width * scale));
      c.height = Math.max(1, Math.round(bmp.height * scale));
      const g = c.getContext('2d')!;
      g.fillStyle = '#fff'; // прозрачный PNG → белый фон, а не чёрный
      g.fillRect(0, 0, c.width, c.height);
      g.drawImage(bmp, 0, 0, c.width, c.height);
      out = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.85));
    }
    bmp.close();
    return out ? { blob: out, name: f.name.replace(/\.(png|jpe?g|webp)$/i, '') + '.jpg' } : { blob: f, name: f.name };
  } catch {
    return { blob: f, name: f.name };
  }
}

/** Имя для вставленного из буфера скриншота: «скриншот-2026-11-20-14-05.png» */
export function pastedName(f: File, i = 0): string {
  if (f.name && f.name !== 'image.png') return f.name;
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const ext = (f.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg');
  return `скриншот-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}-${p(d.getMinutes())}${i ? `-${i + 1}` : ''}.${ext}`;
}

export async function uploadFiles(id: number, files: File[]): Promise<void> {
  for (const [i, f] of files.entries()) {
    const { blob, name } = await shrinkImage(f);
    const r = await write((a) => api.uploadFile(id, blob, pastedName(new File([], name, { type: f.type }), i), a));
    if (r) putTask(r);
    else break;
  }
}

export async function removeFile(id: number, fid: string): Promise<void> {
  const r = await write((a) => api.deleteFile(id, fid, a));
  if (r) putTask(r);
}
