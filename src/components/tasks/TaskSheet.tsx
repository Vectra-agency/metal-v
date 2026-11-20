// Карточка задачи справа: заголовок и описание (правка с защитой от затирания чужой правки), колонка, тип,
// приоритет, исполнитель, вложения (кнопка, вставка Ctrl+V, перетаскивание), комментарии, журнал изменений,
// «Скопировать для агента» — задача текстом Markdown с командой для CLI.
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type ReactElement } from 'react';
import { toast } from 'sonner';
import { Bot, Download, FileText, Link, MessageCircleQuestionMark, Paperclip, Send, Trash } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible.tsx';
import { Kbd } from '@/components/ui/kbd.tsx';
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select.tsx';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { Textarea } from '@/components/ui/textarea.tsx';
import { ChevronDown, Copy, Pencil } from '@/components/common/icons.ts';
import { isEditable } from '@/components/common/dom.ts';
import { MOD } from '@/components/shell/useShortcuts.ts';
import { cn } from '@/lib/utils.ts';
import { ago, date } from '@/format.ts';
import {
  DEFAULT_AGENT_NAME,
  KIND_LABEL,
  PRIORITY_LABEL,
  STATUS_LABEL,
  TASK_KINDS,
  TASK_LIMITS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  taskMarkdown,
  type Task,
  type TaskKind,
  type TaskPriority,
  type TaskStatus,
} from '@/core/tasks.ts';
import { fileUrl } from '@/tasks/api.ts';
import { addComment, moveTask, openTask, removeComment, removeFile, removeTask, saveText, updateTask, uploadFiles, useTasks } from '@/tasks/store.ts';
import { copiedFromOffice, fileSize, KindBadge, Person, RichText, useAgentNames } from './shared.tsx';

const NONE = '*none*';
const isSend = (e: React.KeyboardEvent) => e.key === 'Enter' && (e.metaKey || e.ctrlKey);
const filesOf = (dt: DataTransfer | null) => [...(dt?.files ?? [])];

// ---------- заголовок и описание ----------

function TitleField({ t }: { t: Task }): ReactElement {
  const [draft, setDraft] = useState<string | null>(null);
  const base = useRef(t.title);
  const save = async () => {
    if (draft == null) return;
    const v = draft.replace(/\s+/g, ' ').trim();
    if (!v || v === t.title) return setDraft(null);
    const r = await saveText(t.id, { title: v }, { title: base.current, description: t.description });
    if (r.ok) setDraft(null);
    else if (r.conflict) {
      toast.error('Заголовок изменили, пока вы правили — показан новый', { description: `Ваш вариант: «${v}»` });
      setDraft(null);
    }
  };
  return (
    <Textarea
      value={draft ?? t.title}
      rows={1}
      maxLength={TASK_LIMITS.title}
      aria-label="Заголовок задачи"
      onFocus={() => {
        base.current = t.title;
        setDraft(t.title);
      }}
      onChange={(e) => setDraft(e.target.value.replace(/\n/g, ' '))}
      onBlur={() => void save()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          (e.target as HTMLTextAreaElement).blur();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          setDraft(null);
          requestAnimationFrame(() => (e.target as HTMLTextAreaElement).blur());
        }
      }}
      className="-mx-2.5 min-h-0 resize-none border-transparent bg-transparent px-2.5 py-1 text-lg leading-snug font-semibold shadow-none hover:border-input md:text-lg dark:bg-transparent"
    />
  );
}

function DescriptionField({ t }: { t: Task }): ReactElement {
  const [draft, setDraft] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Task | null>(null);
  const base = useRef(t.description);
  const start = () => {
    base.current = t.description;
    setConflict(null);
    setDraft(t.description);
  };
  const cancel = () => {
    setDraft(null);
    setConflict(null);
  };
  const save = async () => {
    if (draft == null) return;
    if (draft.trim() === t.description.trim()) return cancel();
    const r = await saveText(t.id, { description: draft }, { title: t.title, description: base.current });
    if (r.ok) return cancel();
    if (r.conflict) {
      // свежий текст — сверху; ваш остаётся в поле, повторное сохранение заменит свежий
      base.current = r.conflict.description;
      setConflict(r.conflict);
    }
  };
  if (draft == null)
    return (
      <div className="group/desc relative">
        {t.description ? (
          <RichText text={t.description} className="pe-8" />
        ) : (
          <button type="button" onClick={start} className="w-full rounded-lg border border-dashed px-3 py-4 text-left text-sm text-muted-foreground hover:bg-muted">
            Описания нет. Что не так или что нужно сделать, как проверить — так задачу сможет взять и ИИ-агент.
          </button>
        )}
        {t.description && (
          <Button size="icon-xs" variant="ghost" className="absolute top-0 right-0 opacity-60 group-hover/desc:opacity-100" aria-label="Изменить описание" title="Изменить описание" onClick={start}>
            <Pencil />
          </Button>
        )}
      </div>
    );
  return (
    <div className="flex flex-col gap-2">
      {conflict && (
        <div role="alert" className="flex flex-col gap-1 rounded-lg border border-warn/40 bg-warn-soft p-2.5 text-sm">
          <span className="font-medium text-warn">Пока вы правили, описание изменили. Свежая версия:</span>
          <RichText text={conflict.description || '— пусто —'} className="max-h-40 overflow-y-auto text-foreground" />
          <span className="text-muted-foreground">Ваш текст — в поле ниже. «Сохранить» заменит свежую версию вашей.</span>
        </div>
      )}
      <Textarea
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        maxLength={TASK_LIMITS.description}
        rows={8}
        aria-label="Описание задачи"
        className="max-h-[50vh] min-h-32"
        onKeyDown={(e) => {
          if (isSend(e)) {
            e.preventDefault();
            void save();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
          }
        }}
      />
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => void save()}>
          Сохранить
        </Button>
        <Button size="sm" variant="ghost" onClick={cancel}>
          Отмена
        </Button>
        <span className="ms-auto text-xs text-muted-foreground">
          <Kbd>{MOD} Enter</Kbd> — сохранить, <Kbd>Esc</Kbd> — отмена
        </span>
      </div>
    </div>
  );
}

// ---------- поля ----------

function Field({ label, children }: { label: string; children: ReactElement }): ReactElement {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function MetaFields({ t }: { t: Task }): ReactElement {
  const me = useTasks((s) => s.me);
  const people = useTasks((s) => s.board?.people);
  const agents = useAgentNames();
  const names = [...new Set([...(me ? [me] : []), ...(people ?? []), DEFAULT_AGENT_NAME, ...agents, ...(t.assignee ? [t.assignee] : [])])];
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-2.5 sm:grid-cols-4">
      <Field label="Колонка">
        <Select value={t.status} onValueChange={(v) => moveTask(t.id, v as TaskStatus, null)}>
          <SelectTrigger size="sm" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            {TASK_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS_LABEL[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label="Тип">
        <Select value={t.kind} onValueChange={(v) => void updateTask(t.id, { kind: v as TaskKind })}>
          <SelectTrigger size="sm" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            {TASK_KINDS.map((k) => (
              <SelectItem key={k} value={k}>
                {KIND_LABEL[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label="Приоритет">
        <Select value={t.priority} onValueChange={(v) => void updateTask(t.id, { priority: v as TaskPriority })}>
          <SelectTrigger size="sm" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            {TASK_PRIORITIES.map((p) => (
              <SelectItem key={p} value={p}>
                {PRIORITY_LABEL[p]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label="Исполнитель">
        <Select value={t.assignee ?? NONE} onValueChange={(v) => void updateTask(t.id, { assignee: v === NONE ? null : v })}>
          <SelectTrigger size="sm" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectItem value={NONE}>Не назначен</SelectItem>
            <SelectSeparator />
            {names.map((n) => (
              <SelectItem key={n} value={n}>
                {agents.has(n) || n === DEFAULT_AGENT_NAME ? <Bot aria-hidden className="text-ai" /> : null}
                {n === me ? `${n} (я)` : n}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    </div>
  );
}

// ---------- вложения ----------

function Files({ t, busy }: { t: Task; busy: boolean }): ReactElement {
  const input = useRef<HTMLInputElement>(null);
  return (
    <section aria-labelledby="task-files" className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h3 id="task-files" className="text-sm font-semibold">
          Вложения{t.files.length ? ` · ${t.files.length}` : ''}
        </h3>
        <Button size="xs" variant="outline" className="ms-auto" disabled={busy} onClick={() => input.current?.click()}>
          <Paperclip data-icon="inline-start" />
          {busy ? 'Загружаю…' : 'Приложить'}
        </Button>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const fs = [...(e.target.files ?? [])];
            e.target.value = '';
            if (fs.length) void uploadFiles(t.id, fs);
          }}
        />
      </div>
      {t.files.length ? (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {t.files.map((f) => {
            const img = f.type.startsWith('image/');
            return (
              <li key={f.id} className="group/file relative overflow-hidden rounded-lg border bg-card">
                <a href={fileUrl(t.id, f.id)} target="_blank" rel="noreferrer" className="flex flex-col" title={`${f.name} — открыть`}>
                  {img ? (
                    <img src={fileUrl(t.id, f.id)} alt={f.name} loading="lazy" className="h-24 w-full bg-muted object-cover" />
                  ) : (
                    <span className="grid h-24 place-items-center bg-muted text-muted-foreground">
                      <FileText aria-hidden className="size-8" />
                    </span>
                  )}
                  <span className="truncate px-2 pt-1 text-xs font-medium">{f.name}</span>
                  <span className="px-2 pb-1.5 text-xs text-muted-foreground">
                    {fileSize(f.size)} · {f.author}
                  </span>
                </a>
                <div className="absolute top-1 right-1 flex gap-0.5 opacity-0 transition group-focus-within/file:opacity-100 group-hover/file:opacity-100 pointer-coarse:opacity-100">
                  <Button asChild size="icon-xs" variant="secondary" aria-label={`Скачать ${f.name}`} title="Скачать">
                    <a href={fileUrl(t.id, f.id, true)} download={f.name}>
                      <Download />
                    </a>
                  </Button>
                  <Button size="icon-xs" variant="secondary" aria-label={`Удалить ${f.name}`} title="Удалить вложение" onClick={() => void removeFile(t.id, f.id)}>
                    <Trash />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">Скриншот — Ctrl+V прямо здесь; чертёж PDF или DXF — перетащите на карточку.</p>
      )}
    </section>
  );
}

// ---------- комментарии и журнал ----------

function Comments({ t }: { t: Task }): ReactElement {
  const me = useTasks((s) => s.me);
  const agents = useAgentNames();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    const v = text.trim();
    if (!v || busy) return;
    setBusy(true);
    const ok = await addComment(t.id, v);
    setBusy(false);
    if (ok) setText('');
  };
  return (
    <section aria-labelledby="task-comments" className="flex flex-col gap-3">
      <h3 id="task-comments" className="text-sm font-semibold">
        Комментарии{t.comments.length ? ` · ${t.comments.length}` : ''}
      </h3>
      {t.comments.length > 0 && (
        <ol className="flex flex-col gap-3">
          {t.comments.map((c) => (
            <li key={c.id} className="group/comment flex gap-2.5">
              <Person name={c.author} agent={c.agent || agents.has(c.author)} size="md" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2 text-xs">
                  <span className="font-medium">{c.author}</span>
                  {c.agent && !/агент/i.test(c.author) && <span className="text-ai">ИИ-агент</span>}
                  <span className="text-muted-foreground" title={date(c.at)}>
                    {ago(c.at)}
                  </span>
                  {c.author === me && !c.agent && (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      className="ms-auto opacity-0 group-focus-within/comment:opacity-100 group-hover/comment:opacity-100 pointer-coarse:opacity-100"
                      aria-label="Удалить комментарий"
                      title="Удалить комментарий"
                      onClick={() => void removeComment(t.id, c.id)}
                    >
                      <Trash />
                    </Button>
                  )}
                </div>
                <RichText text={c.text} className={cn('mt-0.5 rounded-lg px-2.5 py-1.5', c.agent ? 'bg-ai-soft/60' : 'bg-muted')} />
              </div>
            </li>
          ))}
        </ol>
      )}
      <div className="flex flex-col gap-2">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={TASK_LIMITS.comment}
          rows={2}
          placeholder={t.question ? 'Ответ агенту — после ответа задачу снова можно брать в работу' : 'Комментарий: уточнение, ответ, результат проверки…'}
          aria-label="Новый комментарий"
          className="max-h-60"
          onKeyDown={(e) => {
            if (isSend(e)) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            <Kbd>{MOD} Enter</Kbd> — отправить
          </span>
          <Button size="sm" className="ms-auto" disabled={!text.trim() || busy} onClick={() => void send()}>
            <Send data-icon="inline-start" />
            {t.question ? 'Ответить' : 'Отправить'}
          </Button>
        </div>
      </div>
    </section>
  );
}

function Journal({ t }: { t: Task }): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-1 text-sm font-semibold">
        <ChevronDown aria-hidden className={cn('size-4 transition-transform', !open && '-rotate-90')} />
        Журнал изменений · {t.events.length}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ol className="mt-2 flex flex-col gap-1.5 text-xs">
          {[...t.events].reverse().map((e, i) => (
            <li key={i} className="flex gap-2">
              <span className="w-24 shrink-0 text-muted-foreground tabular-nums">{date(e.at).replace(',', '')}</span>
              <span>
                <span className="font-medium">{e.author}</span>
                {e.agent ? ' (агент)' : ''}: {e.text}
              </span>
            </li>
          ))}
        </ol>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ---------- панель ----------

function DeleteButton({ t }: { t: Task }): ReactElement {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="ghost" className="text-destructive">
          <Trash data-icon="inline-start" />
          Удалить
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent className="data-[size=default]:sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Удалить задачу #{t.id}?</AlertDialogTitle>
          <AlertDialogDescription>
            «{t.title}» — вместе с комментариями и вложениями. Вернуть нельзя; если задача просто сделана, перенесите её в «Готово».
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Отмена</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => void removeTask(t.id)}>
            Удалить
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

const taskLink = (id: number) => new URL(`./tasks?task=${id}`, location.href).href;

async function copy(text: string, ok: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(ok);
  } catch {
    toast.error('Не удалось скопировать — браузер не дал доступ к буферу обмена');
  }
}

function Body({ t }: { t: Task }): ReactElement {
  const agents = useAgentNames();
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const upload = async (files: File[]) => {
    setBusy(true);
    await uploadFiles(t.id, files);
    setBusy(false);
  };
  const onPaste = (e: ClipboardEvent) => {
    const fs = filesOf(e.clipboardData);
    if (!fs.length || copiedFromOffice(e.clipboardData)) return;
    e.preventDefault();
    void upload(fs);
  };
  const onDrop = (e: DragEvent) => {
    const fs = filesOf(e.dataTransfer);
    setOver(false);
    if (!fs.length) return;
    e.preventDefault();
    void upload(fs);
  };
  return (
    <div
      className={cn('flex min-h-0 flex-1 flex-col', over && 'ring-2 ring-ring ring-inset')}
      onPaste={onPaste}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setOver(false)}
      onDrop={onDrop}
    >
      <SheetHeader className="gap-1.5 border-b pe-12">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground tabular-nums">#{t.id}</span>
          <KindBadge kind={t.kind} />
          <span className="flex items-center gap-1">
            <Person name={t.author} agent={t.agent || agents.has(t.author)} />
            {t.author} · {date(t.createdAt)}
          </span>
        </div>
        <SheetTitle className="sr-only">{t.title}</SheetTitle>
        <TitleField t={t} />
        <SheetDescription className="sr-only">Задача #{t.id}: колонка, описание, вложения и комментарии</SheetDescription>
      </SheetHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
        <MetaFields t={t} />
        {t.question && (
          <div role="status" className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn-soft p-2.5 text-sm">
            <MessageCircleQuestionMark aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" />
            <div className="flex-1">
              <span className="font-medium text-warn">ИИ-агент задал вопрос и ждёт ответа.</span> Ответьте комментарием — вопрос снимется, и задачу снова можно будет брать в работу.
            </div>
            <Button size="xs" variant="ghost" onClick={() => void updateTask(t.id, { question: false })}>
              Снять
            </Button>
          </div>
        )}
        <section aria-label="Описание">
          <DescriptionField t={t} />
        </section>
        <Files t={t} busy={busy} />
        <Comments t={t} />
        <Journal t={t} />
      </div>
      <SheetFooter className="flex-row flex-wrap items-center gap-2 border-t">
        <Button
          size="sm"
          variant="outline"
          title="Задача текстом Markdown: вставьте в чат ИИ-агента"
          onClick={() => void copy(`${taskMarkdown(t, { url: taskLink(t.id) })}\nВзять в работу: node scripts/tasks.ts take ${t.id}\n`, 'Задача скопирована — вставьте агенту')}
        >
          <Copy data-icon="inline-start" />
          Для агента
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void copy(taskLink(t.id), 'Ссылка на задачу скопирована')}>
          <Link data-icon="inline-start" />
          Ссылка
        </Button>
        <span className="ms-auto" />
        <DeleteButton t={t} />
      </SheetFooter>
    </div>
  );
}

export function TaskSheet(): ReactElement {
  const openId = useTasks((s) => s.openId);
  const task = useTasks((s) => s.board?.tasks.find((t) => t.id === s.openId) ?? null);
  const loaded = useTasks((s) => !!s.board);
  // задачу удалили, пока она была открыта у вас
  const [gone, setGone] = useState(false);
  useEffect(() => setGone(loaded && openId != null && !task), [loaded, openId, task]);
  const content = useRef<HTMLDivElement>(null);
  return (
    <Sheet open={openId != null} onOpenChange={(o) => !o && openTask(null)}>
      <SheetContent
        ref={content}
        side="right"
        className="gap-0 outline-none data-[side=right]:w-full data-[side=right]:sm:max-w-[720px]"
        onEscapeKeyDown={(e) => isEditable(e.target) && e.preventDefault()}
        // фокус — на саму панель, а не в заголовок: иначе он сразу выглядит как поле правки
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          content.current?.focus();
        }}
      >
        {task ? (
          <Body key={task.id} t={task} />
        ) : (
          <div className="flex flex-col gap-3 p-4">
            <SheetTitle>{gone ? `Задачи #${openId} нет` : 'Загрузка…'}</SheetTitle>
            <SheetDescription>{gone ? 'Её удалили или номер неверный.' : 'Загружаем доску.'}</SheetDescription>
            {!gone && <Skeleton className="h-40" />}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
