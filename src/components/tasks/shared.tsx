// Общее для доски задач: плашка типа, отметка приоритета, кружок с инициалами (или значок агента), текст со ссылками.
import { Fragment, useMemo, type ReactElement, type ReactNode } from 'react';
import { Bot, Bug, ChevronDown, ChevronsUp, ChevronUp, Lightbulb, Wrench } from 'lucide-react';
import { cn } from '@/lib/utils.ts';
import { KIND_LABEL, PRIORITY_LABEL, type Task, type TaskKind, type TaskPriority } from '@/core/tasks.ts';
import { openTask, useTasks } from '@/tasks/store.ts';

const KIND_TONE: Record<TaskKind, string> = {
  feature: 'bg-ok-soft text-ok',
  improvement: 'bg-secondary text-secondary-foreground',
  bug: 'bg-danger-soft text-danger',
};
const KIND_ICON: Record<TaskKind, typeof Bug> = { feature: Lightbulb, improvement: Wrench, bug: Bug };

export function KindBadge({ kind, className }: { kind: TaskKind; className?: string }): ReactElement {
  const Icon = KIND_ICON[kind];
  return (
    <span className={cn('inline-flex h-5 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs font-medium whitespace-nowrap', KIND_TONE[kind], className)}>
      <Icon aria-hidden className="size-3" />
      {KIND_LABEL[kind]}
    </span>
  );
}

export function KindIcon({ kind, className }: { kind: TaskKind; className?: string }): ReactElement {
  const Icon = KIND_ICON[kind];
  return <Icon aria-hidden className={className} />;
}

/** Приоритет значком; обычный — ничего */
export function PriorityMark({ priority, className }: { priority: TaskPriority; className?: string }): ReactElement | null {
  if (priority === 'normal') return null;
  const Icon = priority === 'urgent' ? ChevronsUp : priority === 'high' ? ChevronUp : ChevronDown;
  const tone = priority === 'urgent' ? 'text-danger' : priority === 'high' ? 'text-warn' : 'text-muted-foreground';
  return (
    <span className={cn('inline-flex items-center', tone, className)} title={`Приоритет: ${PRIORITY_LABEL[priority]}`}>
      <Icon aria-hidden className="size-4" />
      <span className="sr-only">Приоритет: {PRIORITY_LABEL[priority]}</span>
    </span>
  );
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?';

// цвет кружка — от имени: один и тот же человек всегда одного цвета
const TONES = ['bg-chart-1/20', 'bg-chart-2/20', 'bg-chart-3/25', 'bg-chart-4/25', 'bg-chart-5/20', 'bg-ai-soft', 'bg-ok-soft', 'bg-warn-soft'];
const toneOf = (name: string) => TONES[[...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % TONES.length];

export function Person({ name, agent, size = 'sm', className }: { name: string; agent?: boolean; size?: 'sm' | 'md'; className?: string }): ReactElement {
  const box = size === 'md' ? 'size-7 text-xs' : 'size-5 text-[10px]';
  if (agent)
    return (
      <span className={cn('inline-grid shrink-0 place-items-center rounded-full bg-ai-soft text-ai', box, className)} title={`${name} — ИИ-агент`}>
        <Bot aria-hidden className={size === 'md' ? 'size-4' : 'size-3'} />
        <span className="sr-only">{name} (ИИ-агент)</span>
      </span>
    );
  return (
    <span className={cn('inline-grid shrink-0 place-items-center rounded-full font-semibold text-foreground', box, toneOf(name), className)} title={name} aria-hidden>
      {initials(name)}
    </span>
  );
}

/** Имена, которые писали на доску как ИИ-агенты (CLI) — для значка робота вместо инициалов */
export function useAgentNames(): Set<string> {
  const tasks = useTasks((s) => s.board?.tasks);
  return useMemo(() => {
    const out = new Set<string>();
    for (const t of tasks ?? []) {
      if (t.agent) out.add(t.author);
      for (const c of t.comments) if (c.agent) out.add(c.author);
      for (const e of t.events) if (e.agent) out.add(e.author);
    }
    return out;
  }, [tasks]);
}

export const isAgentTask = (t: Task, agents: Set<string>): boolean => !!t.assignee && agents.has(t.assignee);

// ---------- текст ----------

const TOKEN = /(https?:\/\/[^\s<>"'«»]+[^\s<>"'«».,;:!?)\]])|(#\d{1,7})\b|(`[^`\n]+`)/g;

/** Текст как есть (переносы строк сохраняются), с живыми ссылками, #12 — открыть задачу, `код` — моноширинно */
export function RichText({ text, className }: { text: string; className?: string }): ReactElement {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const i = m.index ?? 0;
    if (i > last) parts.push(text.slice(last, i));
    if (m[1])
      parts.push(
        <a key={i} href={m[1]} target="_blank" rel="noreferrer noopener" className="break-all text-primary underline underline-offset-2">
          {m[1]}
        </a>,
      );
    else if (m[2]) {
      const id = Number(m[2].slice(1));
      parts.push(
        <button key={i} type="button" className="font-medium text-primary underline underline-offset-2" onClick={() => openTask(id)}>
          {m[2]}
        </button>,
      );
    } else parts.push(<code key={i} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{m[3]!.slice(1, -1)}</code>);
    last = i + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <div className={cn('text-sm break-words whitespace-pre-wrap', className)}>{parts.map((p, k) => <Fragment key={k}>{p}</Fragment>)}</div>;
}

/** Excel, Word, Таблицы кладут в буфер и текст, и картинку — вставляем текст, а не вложение */
export const copiedFromOffice = (dt: DataTransfer): boolean => !!dt.getData('text/plain').trim() && dt.types.includes('text/html');

/** «12 КБ», «1,4 МБ» */
export function fileSize(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} КБ`;
  return `${(n / 1024 / 1024).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} МБ`;
}
