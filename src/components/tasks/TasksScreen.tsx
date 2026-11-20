// Экран «Задачи и доработки» (/tasks): канбан-доска на всю высоту окна. Карточки перетаскиваются мышью между
// колонками и внутри колонки; с клавиатуры и на телефоне колонка меняется в карточке задачи.
// Доска общая для всех, кто вошёл: перечитывается раз в 15 с и при возврате во вкладку.
import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactElement } from 'react';
import { Bot, MessageCircleQuestionMark, MessageSquare, Paperclip, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx';
import { Search } from '@/components/common/icons.ts';
import { isEditable } from '@/components/common/dom.ts';
import { cn } from '@/lib/utils.ts';
import { ago, date, plural } from '@/format.ts';
import { columnTasks, KIND_LABEL, STATUS_HINT, STATUS_LABEL, TASK_KINDS, TASK_STATUSES, type Task, type TaskStatus } from '@/core/tasks.ts';
import { getTasks, moveTask, openTask, patchTasks, refreshBoard, useTasks, type TaskFilter } from '@/tasks/store.ts';
import { AgentDialog } from './AgentDialog.tsx';
import { NameDialog } from './NameDialog.tsx';
import { NewTaskDialog } from './NewTaskDialog.tsx';
import { TaskSheet } from './TaskSheet.tsx';
import { isAgentTask, KindBadge, Person, PriorityMark, useAgentNames } from './shared.tsx';

const POLL_MS = 15_000;
const DONE_DAYS = 14;
const MIME = 'application/x-metal-task';

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е');

function matches(t: Task, f: TaskFilter): boolean {
  if (f.kind !== 'all' && t.kind !== f.kind) return false;
  if (f.person && t.author !== f.person && t.assignee !== f.person) return false;
  const q = norm(f.q.trim());
  if (!q) return true;
  if (/^#?\d+$/.test(q)) return String(t.id) === q.replace('#', '');
  return norm(`${t.title}\n${t.description}`).includes(q);
}

// ---------- карточка ----------

function TaskCard({ t, agents, dragging, onDragStart, onDragEnd }: { t: Task; agents: Set<string>; dragging: boolean; onDragStart: (id: number) => void; onDragEnd: () => void }): ReactElement {
  const agent = isAgentTask(t, agents);
  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      data-card={t.id}
      aria-label={`${t.title}, задача #${t.id}`}
      onDragStart={(e) => {
        e.dataTransfer.setData(MIME, String(t.id));
        e.dataTransfer.effectAllowed = 'move';
        onDragStart(t.id);
      }}
      onDragEnd={onDragEnd}
      onClick={() => openTask(t.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openTask(t.id);
        }
      }}
      className={cn(
        'group flex cursor-grab flex-col gap-1.5 rounded-lg border bg-card p-2.5 text-left shadow-xs transition outline-none select-none',
        'hover:border-foreground/25 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:cursor-grabbing',
        dragging && 'opacity-40',
        t.question && 'border-warn/50',
      )}
    >
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="font-medium tabular-nums">#{t.id}</span>
        <KindBadge kind={t.kind} />
        <PriorityMark priority={t.priority} className="ms-auto" />
      </div>
      <div className="line-clamp-4 text-sm leading-snug font-medium">{t.title}</div>
      {t.question && (
        <span className="inline-flex w-fit items-center gap-1 rounded-md bg-warn-soft px-1.5 py-0.5 text-xs font-medium text-warn">
          <MessageCircleQuestionMark aria-hidden className="size-3.5" />
          Агент ждёт ответа
        </span>
      )}
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        {t.assignee ? (
          <span className="flex min-w-0 items-center gap-1" title={`Исполнитель: ${t.assignee}`}>
            <Person name={t.assignee} agent={agent} />
            <span className={cn('truncate', agent && t.status === 'doing' && 'text-ai')}>{t.assignee}</span>
          </span>
        ) : (
          <span className="truncate" title={`Автор: ${t.author}`}>
            от {t.author}
          </span>
        )}
        {t.comments.length > 0 && (
          <span className="inline-flex shrink-0 items-center gap-0.5" title={`${t.comments.length} ${plural(t.comments.length, 'комментарий', 'комментария', 'комментариев')}`}>
            <MessageSquare aria-hidden className="size-3.5" />
            {t.comments.length}
          </span>
        )}
        {t.files.length > 0 && (
          <span className="inline-flex shrink-0 items-center gap-0.5" title={`${t.files.length} ${plural(t.files.length, 'вложение', 'вложения', 'вложений')}`}>
            <Paperclip aria-hidden className="size-3.5" />
            {t.files.length}
          </span>
        )}
        <span className="ms-auto shrink-0 whitespace-nowrap" title={`Изменена ${date(t.updatedAt)}`}>
          {ago(t.updatedAt)}
        </span>
      </div>
    </div>
  );
}

// ---------- колонка ----------

interface ColumnProps {
  status: TaskStatus;
  all: Task[]; // вся колонка (для места при переносе)
  shown: Task[]; // после фильтров
  hiddenDone: number;
  agents: Set<string>;
  dragId: number | null;
  setDragId: (id: number | null) => void;
}

function Column({ status, all, shown, hiddenDone, agents, dragId, setDragId }: ColumnProps): ReactElement {
  const [drop, setDrop] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const visible = shown.filter((t) => t.id !== dragId);

  /** Место среди видимых карточек под курсором */
  const visibleIndexAt = (y: number): number => {
    let i = 0;
    for (const el of listRef.current?.querySelectorAll<HTMLElement>('[data-card]') ?? []) {
      if (el.dataset.card === String(dragId)) continue;
      const r = el.getBoundingClientRect();
      if (y > r.top + r.height / 2) i++;
      else break;
    }
    return i;
  };
  /** Видимое место → задача, перед которой встать (часть карточек может быть скрыта фильтром); null — в конец */
  const beforeAt = (vi: number, moved: number): number | null => {
    if (vi < visible.length) return visible[vi].id;
    if (!visible.length) return null;
    const full = all.filter((t) => t.id !== moved);
    return full[full.findIndex((t) => t.id === visible[visible.length - 1].id) + 1]?.id ?? null;
  };
  const isTaskDrag = (e: DragEvent) => e.dataTransfer.types.includes(MIME);

  return (
    <section
      aria-labelledby={`col-${status}`}
      className={cn(
        'flex max-h-full w-[min(85vw,19rem)] shrink-0 snap-start flex-col rounded-xl bg-muted/60 xl:w-auto xl:min-w-0 xl:flex-1',
        drop != null && 'ring-2 ring-ring/40',
      )}
      onDragOver={(e) => {
        if (!isTaskDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const i = visibleIndexAt(e.clientY);
        if (i !== drop) setDrop(i);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null);
      }}
      onDrop={(e) => {
        if (!isTaskDrag(e)) return;
        e.preventDefault();
        const id = Number(e.dataTransfer.getData(MIME));
        const vi = visibleIndexAt(e.clientY);
        setDrop(null);
        setDragId(null);
        if (id) moveTask(id, status, beforeAt(vi, id));
      }}
    >
      <header className="flex min-h-11 items-center gap-2 px-3 pt-2 pb-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <h2 id={`col-${status}`} className="cursor-default text-sm font-semibold" tabIndex={0}>
              {STATUS_LABEL[status]}
            </h2>
          </TooltipTrigger>
          <TooltipContent className="max-w-64">{STATUS_HINT[status]}</TooltipContent>
        </Tooltip>
        <span className="text-xs text-muted-foreground tabular-nums">{shown.length}</span>
        {status !== 'done' && (
          <Button
            size="icon-xs"
            variant="ghost"
            className="ms-auto"
            aria-label={`Новая задача в «${STATUS_LABEL[status]}»`}
            title={`Новая задача в «${STATUS_LABEL[status]}»`}
            onClick={() => patchTasks({ creating: { status } })}
          >
            <Plus />
          </Button>
        )}
      </header>
      <div ref={listRef} className="flex min-h-16 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        {shown.map((t, i) => {
          const before = drop != null && visible.indexOf(t) === drop && t.id !== dragId;
          return (
            <div key={t.id} className="flex flex-col gap-2">
              {before && <DropLine />}
              <TaskCard t={t} agents={agents} dragging={t.id === dragId} onDragStart={setDragId} onDragEnd={() => (setDragId(null), setDrop(null))} />
              {i === shown.length - 1 && drop === visible.length && <DropLine />}
            </div>
          );
        })}
        {!shown.length && (drop != null ? <DropLine /> : <p className="px-1 py-3 text-center text-xs text-muted-foreground">{status === 'todo' ? 'Перетащите сюда то, что можно делать' : 'Пусто'}</p>)}
        {status === 'done' && hiddenDone > 0 && (
          <Button size="xs" variant="ghost" className="self-center text-muted-foreground" onClick={() => patchTasks({ allDone: true })}>
            Показать старше {DONE_DAYS} дней: {hiddenDone}
          </Button>
        )}
      </div>
    </section>
  );
}

const DropLine = () => <div aria-hidden className="h-1 shrink-0 rounded-full bg-ring" />;

// ---------- панель фильтров ----------

function Toolbar({ total, shown }: { total: number; shown: number }): ReactElement {
  const f = useTasks((s) => s.filter);
  const me = useTasks((s) => s.me);
  const people = useTasks((s) => s.board?.people);
  const set = (p: Partial<TaskFilter>) => patchTasks({ filter: { ...getTasks().filter, ...p } });
  const filtered = !!(f.q.trim() || f.kind !== 'all' || f.person);
  const names = useMemo(() => [...new Set([...(me ? [me] : []), ...(people ?? [])])], [me, people]);
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 pt-3 pb-2 lg:px-6">
      <div className="me-auto flex items-baseline gap-2">
        <h1 className="text-base font-semibold">Задачи и доработки</h1>
        <span className="text-sm text-muted-foreground tabular-nums">{filtered ? `${shown} из ${total}` : total}</span>
      </div>
      <div className="relative w-full sm:w-56">
        <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          id="tasks-search"
          type="search"
          value={f.q}
          onChange={(e) => set({ q: e.target.value })}
          placeholder="Поиск или #номер"
          aria-label="Поиск задач"
          className="h-8 ps-8"
        />
      </div>
      <Select value={f.kind} onValueChange={(v) => set({ kind: v as TaskFilter['kind'] })}>
        <SelectTrigger size="sm" aria-label="Тип задач" className="w-36">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper">
          <SelectItem value="all">Все типы</SelectItem>
          {TASK_KINDS.map((k) => (
            <SelectItem key={k} value={k}>
              {KIND_LABEL[k]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={f.person || '*'} onValueChange={(v) => set({ person: v === '*' ? '' : v })}>
        <SelectTrigger size="sm" aria-label="Чьи задачи" className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper">
          <SelectItem value="*">Все люди</SelectItem>
          {names.length > 0 && <SelectSeparator />}
          {names.map((n) => (
            <SelectItem key={n} value={n}>
              {n === me ? `Мои (${n})` : n}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {filtered && (
        <Button size="sm" variant="ghost" onClick={() => set({ q: '', kind: 'all', person: '' })}>
          Сбросить
        </Button>
      )}
      <Button size="sm" variant="outline" onClick={() => patchTasks({ agentHelp: true })}>
        <Bot data-icon="inline-start" />
        ИИ-агенты
      </Button>
      <Button size="sm" onClick={() => patchTasks({ creating: { status: 'backlog' } })}>
        <Plus data-icon="inline-start" />
        Новая задача
      </Button>
    </div>
  );
}

// ---------- экран ----------

function useBoardSync(): void {
  useEffect(() => {
    void refreshBoard(true);
    const tick = () => {
      if (document.visibilityState === 'visible') void refreshBoard();
    };
    const timer = setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('focus', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
      window.removeEventListener('focus', tick);
    };
  }, []);
}

/** Файл, брошенный мимо карточки задачи, браузер открыл бы вместо доски — не даём */
function useSwallowFileDrops(): void {
  useEffect(() => {
    const stop = (e: globalThis.DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    };
    window.addEventListener('dragover', stop);
    window.addEventListener('drop', stop);
    return () => {
      window.removeEventListener('dragover', stop);
      window.removeEventListener('drop', stop);
    };
  }, []);
}

/** «/» — к поиску, «n» (или «т») — новая задача */
function useBoardKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.ctrlKey || e.metaKey || e.altKey || isEditable(e.target)) return;
      const s = getTasks();
      if (s.openId != null || s.creating || s.naming || s.agentHelp) return;
      if (e.key === '/' || e.code === 'Slash') {
        e.preventDefault();
        document.getElementById('tasks-search')?.focus();
      } else if (e.code === 'KeyN') {
        e.preventDefault();
        patchTasks({ creating: { status: 'backlog' } });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export function TasksScreen(): ReactElement {
  const board = useTasks((s) => s.board);
  const loading = useTasks((s) => s.loading);
  const error = useTasks((s) => s.error);
  const filter = useTasks((s) => s.filter);
  const allDone = useTasks((s) => s.allDone);
  const agents = useAgentNames();
  const [dragId, setDragId] = useState<number | null>(null);
  useBoardSync();
  useSwallowFileDrops();
  useBoardKeys();

  useEffect(() => {
    const prev = document.title;
    document.title = 'Задачи — Расчёт деталей';
    return () => {
      document.title = prev;
    };
  }, []);

  const cols = useMemo(() => {
    const tasks = board?.tasks ?? [];
    const since = new Date(Date.now() - DONE_DAYS * 864e5).toISOString();
    return TASK_STATUSES.map((status) => {
      const all = columnTasks(tasks, status);
      let shown = all.filter((t) => matches(t, filter));
      let hiddenDone = 0;
      if (status === 'done' && !allDone) {
        const recent = shown.filter((t) => t.updatedAt >= since);
        hiddenDone = shown.length - recent.length;
        shown = recent;
      }
      return { status, all, shown, hiddenDone };
    });
  }, [board, filter, allDone]);

  // доска — relative: подписи sr-only (position: absolute) в дальних колонках иначе отсчитываются от окна
  // и на телефоне раздвигают страницу вбок
  const total = board?.tasks.length ?? 0;
  const shown = cols.reduce((n, c) => n + c.shown.length + c.hiddenDone, 0);

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <Toolbar total={total} shown={shown} />
      {error && (
        <p role="alert" className="mx-4 mb-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger lg:mx-6">
          {board ? `Не удалось обновить доску: ${error}. Показана последняя загруженная версия.` : `Не удалось загрузить доску: ${error}`}
        </p>
      )}
      {!board && loading ? (
        <div className="flex gap-3 px-4 lg:px-6" aria-busy="true" aria-label="Загрузка доски">
          {TASK_STATUSES.map((s) => (
            <Skeleton key={s} className="h-64 w-[min(85vw,19rem)] shrink-0 xl:flex-1" />
          ))}
        </div>
      ) : (
        <div className="relative flex min-h-0 flex-1 snap-x gap-3 overflow-x-auto px-4 pb-4 lg:px-6" onDragEnd={() => setDragId(null)}>
          {cols.map((c) => (
            <Column key={c.status} {...c} agents={agents} dragId={dragId} setDragId={setDragId} />
          ))}
        </div>
      )}
      <TaskSheet />
      <NewTaskDialog />
      <NameDialog />
      <AgentDialog />
    </main>
  );
}
