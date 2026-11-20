// Запросы к доске задач на сервере (server/tasks.ts).
import type { Task, TaskActor, TaskDraft, TaskPatch, TasksBoard } from '../core/tasks.ts';

/** Ошибка API доски; status 0 — нет связи. task — свежая задача при конфликте правки (409) */
export class TasksApiError extends Error {
  readonly status: number;
  readonly task: Task | null;
  constructor(message: string, status: number, task: Task | null = null) {
    super(message);
    this.name = 'TasksApiError';
    this.status = status;
    this.task = task;
  }
}

async function call<T>(url: string, init: RequestInit = {}): Promise<T> {
  let r: Response;
  try {
    const json = typeof init.body === 'string';
    r = await fetch(url, { cache: 'no-store', ...init, headers: json ? { 'Content-Type': 'application/json', ...init.headers } : init.headers });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new TasksApiError('Нет связи с сервером', 0);
  }
  const isJson = (r.headers.get('content-type') ?? '').includes('json');
  const j = isJson ? ((await r.json().catch(() => null)) as (T & { error?: string; task?: Task }) | null) : null;
  if (r.status === 413) throw new TasksApiError('Файл слишком большой для сервера (без настройки nginx — до 1 МБ)', 413);
  if (!r.ok || !j) throw new TasksApiError(j?.error ?? (r.status === 404 && !isJson ? 'Доска задач доступна только на сервере' : `Ошибка ${r.status}`), isJson ? r.status : 0, j?.task ?? null);
  return j;
}

const enc = encodeURIComponent;
const q = (a: TaskActor) => `by=${enc(a.by)}${a.agent ? '&agent=1' : ''}`;

export type BoardResponse = TasksBoard | { rev: string; unchanged: true };

export const loadBoard = (rev: string | null, signal?: AbortSignal) => call<BoardResponse>(`/api/tasks${rev != null ? `?rev=${encodeURIComponent(rev)}` : ''}`, { signal });
export const createTask = (d: TaskDraft, a: TaskActor) => call<Task>('/api/tasks', { method: 'POST', body: JSON.stringify({ ...d, ...a }) });
export const patchTask = (id: number, p: TaskPatch & { base?: { title?: string; description?: string } }, a: TaskActor) =>
  call<Task>(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ ...p, ...a }) });
export const deleteTask = (id: number, a: TaskActor) => call<Task>(`/api/tasks/${id}?${q(a)}`, { method: 'DELETE' });
export const addComment = (id: number, text: string, a: TaskActor) => call<Task>(`/api/tasks/${id}/comments`, { method: 'POST', body: JSON.stringify({ text, ...a }) });
export const deleteComment = (id: number, cid: string, a: TaskActor) => call<Task>(`/api/tasks/${id}/comments/${enc(cid)}?${q(a)}`, { method: 'DELETE' });
export const uploadFile = (id: number, file: Blob, name: string, a: TaskActor) =>
  call<Task>(`/api/tasks/${id}/files?name=${enc(name)}&${q(a)}`, { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' } });
export const deleteFile = (id: number, fid: string, a: TaskActor) => call<Task>(`/api/tasks/${id}/files/${enc(fid)}?${q(a)}`, { method: 'DELETE' });
export const fileUrl = (id: number, fid: string, download = false) => `/api/tasks/${id}/files/${enc(fid)}${download ? '?download=1' : ''}`;
