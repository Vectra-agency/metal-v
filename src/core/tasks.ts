// Доска задач и доработок сервиса: формат задачи (общий для сервера, браузера и CLI для ИИ-агентов) и
// чистые помощники — подписи, порядок в колонке, задача текстом Markdown для агента.
// Хранение и HTTP — server/tasks.ts, доска — src/components/tasks/, CLI — scripts/tasks.ts.

export const TASKS_VERSION = 1;

/** Колонки доски слева направо. ИИ-агенты берут задачи только из «К работе» */
export const TASK_STATUSES = ['backlog', 'todo', 'doing', 'review', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: 'Бэклог',
  todo: 'К работе',
  doing: 'В работе',
  review: 'На проверке',
  done: 'Готово',
};

export const STATUS_HINT: Record<TaskStatus, string> = {
  backlog: 'Идеи и задачи, которые ещё не описаны до конца',
  todo: 'Описано и можно делать — отсюда задачи берут и люди, и ИИ-агенты',
  doing: 'Кто-то делает задачу прямо сейчас',
  review: 'Сделано — нужно проверить и принять (или вернуть с комментарием)',
  done: 'Проверено и принято',
};

export const TASK_KINDS = ['feature', 'improvement', 'bug'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
export const KIND_LABEL: Record<TaskKind, string> = { feature: 'Новое', improvement: 'Доработка', bug: 'Ошибка' };

export const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export const PRIORITY_LABEL: Record<TaskPriority, string> = { low: 'Низкий', normal: 'Обычный', high: 'Высокий', urgent: 'Срочно' };

export const TASK_LIMITS = {
  tasks: 5000,
  title: 200,
  description: 20_000,
  comment: 10_000,
  name: 60,
  comments: 500,
  events: 300,
  files: 30,
  fileName: 200,
  /** Вложение на сервере; nginx без своей настройки пропускает тело до 1 МБ (DEPLOY.md, «Задачи») */
  fileBytes: 10 * 1024 * 1024,
  /** Все вложения доски вместе: VPS общий с другими проектами */
  totalFileBytes: 500 * 1024 * 1024,
  bodyBytes: 100_000,
} as const;

/** Имя по умолчанию для записей из CLI (scripts/tasks.ts), если агент не назвался */
export const DEFAULT_AGENT_NAME = 'ИИ-агент';

export interface TaskComment {
  id: string;
  author: string;
  agent?: boolean; // написал ИИ-агент (через CLI)
  text: string;
  at: string;
}

/** Запись в журнале задачи: кто и что сделал («перенёс: К работе → В работе») */
export interface TaskEvent {
  at: string;
  author: string;
  agent?: boolean;
  text: string;
}

export interface TaskFile {
  id: string;
  name: string;
  type: string;
  size: number;
  at: string;
  author: string;
}

export interface Task {
  id: number; // #12 — сквозной номер, не переиспользуется
  title: string;
  description: string;
  status: TaskStatus;
  kind: TaskKind;
  priority: TaskPriority;
  rank: number; // порядок в колонке (меньше — выше)
  author: string;
  agent?: boolean; // задачу завёл ИИ-агент
  assignee: string | null;
  question?: boolean; // ИИ-агент задал вопрос и ждёт ответа; снимается комментарием человека
  createdAt: string;
  updatedAt: string;
  version: number; // растёт с каждым изменением — защита от затирания чужой правки текста
  comments: TaskComment[];
  events: TaskEvent[];
  files: TaskFile[];
}

/** Ответ GET /api/tasks. unchanged — доска не менялась с переданной ревизии (тогда без задач) */
export interface TasksBoard {
  rev: string; // непрозрачная метка: «запуск сервера.номер изменения»
  tasks: Task[];
  people: string[];
}

/** Тело POST /api/tasks */
export interface TaskDraft {
  title: string;
  description?: string;
  kind?: TaskKind;
  priority?: TaskPriority;
  status?: TaskStatus;
  assignee?: string | null;
}

/**
 * Тело PATCH /api/tasks/<id>: только изменённые поля. Место в колонке: before — номер задачи, перед которой встать
 * (null — в конец), или index — номер места (0 — наверх). expect — ожидаемые колонка и исполнитель: не совпали — 409
 */
export interface TaskPatch {
  title?: string;
  description?: string;
  kind?: TaskKind;
  priority?: TaskPriority;
  assignee?: string | null;
  status?: TaskStatus;
  before?: number | null;
  index?: number;
  question?: boolean;
  expect?: { status?: TaskStatus; assignee?: string | null };
  version?: number; // версия, с которой начали править текст: изменилась — 409
}

/** Кто пишет: имя человека (запомнено в браузере) или агента; agent — запись из CLI */
export interface TaskActor {
  by: string;
  agent?: boolean;
}

export const isStatus = (v: unknown): v is TaskStatus => typeof v === 'string' && (TASK_STATUSES as readonly string[]).includes(v);
export const isKind = (v: unknown): v is TaskKind => typeof v === 'string' && (TASK_KINDS as readonly string[]).includes(v);
export const isPriority = (v: unknown): v is TaskPriority => typeof v === 'string' && (TASK_PRIORITIES as readonly string[]).includes(v);

export const taskRef = (id: number): string => `#${id}`;

/** Имя без лишних пробелов и управляющих символов, до TASK_LIMITS.name знаков */
export function cleanName(v: unknown): string {
  if (typeof v !== 'string') return '';
  return v
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TASK_LIMITS.name);
}

const PRIORITY_ORDER: Record<TaskPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

/** Задачи одной колонки в порядке доски */
export function columnTasks(tasks: readonly Task[], status: TaskStatus): Task[] {
  return tasks.filter((t) => t.status === status).sort((a, b) => a.rank - b.rank || a.id - b.id);
}

/**
 * Место задачи в колонке: новые ранги 0…n-1 всей колонки status, где задача moved стоит на месте index
 * (null — в конец), остальные — в прежнем порядке. Так переносит сервер, и так же доска показывает перенос сразу.
 */
export function placeTask(tasks: readonly Task[], moved: Task, status: TaskStatus, index: number | null): Map<number, number> {
  const col = columnTasks(tasks, status).filter((t) => t.id !== moved.id);
  const at = index == null ? col.length : Math.max(0, Math.min(col.length, Math.floor(index)));
  col.splice(at, 0, moved);
  return new Map(col.map((t, i) => [t.id, i]));
}

/** Следующая задача для агента: из «К работе», без вопроса без ответа; сверху колонки, срочные раньше */
export function nextTask(tasks: readonly Task[]): Task | null {
  const todo = columnTasks(tasks, 'todo').filter((t) => !t.question);
  if (!todo.length) return null;
  return todo.reduce((best, t) => (PRIORITY_ORDER[t.priority] < PRIORITY_ORDER[best.priority] ? t : best), todo[0]);
}

/** Транслитерация для имени файла и ветки: «Ошибка в PDF» → «oshibka-v-pdf» */
export function slug(s: string, max = 40): string {
  const map: Record<string, string> = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o',
    п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  };
  const out = [...s.toLowerCase()]
    .map((c) => map[c] ?? c)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return out.slice(0, max).replace(/-+$/, '') || 'task';
}

const dt = (iso: string) => iso.slice(0, 16).replace('T', ' ');
/** «Claude (ИИ-агент)»; имя агента по умолчанию уже говорит само за себя */
const who = (name: string, agent?: boolean) => (agent && !/агент/i.test(name) ? `${name} (ИИ-агент)` : name);

/**
 * Задача целиком текстом Markdown — для ИИ-агента (CLI pull/show) и кнопки «Скопировать для агента».
 * files — пути к уже скачанным вложениям (CLI) вместо ссылок.
 */
export function taskMarkdown(t: Task, o: { files?: Record<string, string>; url?: string } = {}): string {
  const lines: string[] = [];
  lines.push(`# ${taskRef(t.id)} ${t.title}`, '');
  lines.push(`- Колонка: ${STATUS_LABEL[t.status]} (\`${t.status}\`)`);
  lines.push(`- Тип: ${KIND_LABEL[t.kind]} · приоритет: ${PRIORITY_LABEL[t.priority]}`);
  lines.push(`- Автор: ${who(t.author, t.agent)} · создана ${dt(t.createdAt)} UTC`);
  lines.push(`- Исполнитель: ${t.assignee ?? 'не назначен'}`);
  if (t.question) lines.push('- **Ждёт ответа на вопрос агента** — пока ответа нет, задачу не берём');
  if (o.url) lines.push(`- Ссылка: ${o.url}`);
  lines.push('', '## Описание', '', t.description.trim() || '_Описания нет — только заголовок._');
  if (t.files.length) {
    lines.push('', '## Вложения', '');
    for (const f of t.files) lines.push(`- ${f.name} (${Math.max(1, Math.round(f.size / 1024))} КБ)${o.files?.[f.id] ? ` → \`${o.files[f.id]}\`` : ''}`);
  }
  if (t.comments.length) {
    lines.push('', '## Комментарии', '');
    for (const c of t.comments) {
      lines.push(`### ${who(c.author, c.agent)} · ${dt(c.at)} UTC`, '', c.text.trim(), '');
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
