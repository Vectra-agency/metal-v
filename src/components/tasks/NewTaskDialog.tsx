// «Новая задача»: заголовок, описание, тип, приоритет, колонка, вложения (скриншот — Ctrl+V, файлы — перетащить).
// Кто создаёт первую задачу на этом устройстве — здесь же вводит имя; дальше оно запомнено.
import { useRef, useState, type ReactElement } from 'react';
import { Paperclip, X } from 'lucide-react';
import { Button } from '@/components/ui/button.tsx';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Kbd } from '@/components/ui/kbd.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.tsx';
import { Textarea } from '@/components/ui/textarea.tsx';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group.tsx';
import { MOD } from '@/components/shell/useShortcuts.ts';
import { cn } from '@/lib/utils.ts';
import { cleanName, KIND_LABEL, PRIORITY_LABEL, STATUS_LABEL, TASK_KINDS, TASK_LIMITS, TASK_PRIORITIES, type TaskKind, type TaskPriority, type TaskStatus } from '@/core/tasks.ts';
import { createTask, pastedName, patchTasks, saveName, useTasks } from '@/tasks/store.ts';
import { NameInput } from './NameDialog.tsx';
import { copiedFromOffice, fileSize, KindIcon } from './shared.tsx';

const STATUSES: TaskStatus[] = ['backlog', 'todo', 'doing'];
const KIND_HINT: Record<TaskKind, string> = {
  feature: 'Новая возможность, которой не было',
  improvement: 'Сделать удобнее или точнее то, что уже есть',
  bug: 'Работает не так, как должно',
};

export function NewTaskDialog(): ReactElement {
  const creating = useTasks((s) => s.creating);
  return (
    <Dialog open={!!creating} onOpenChange={(o) => !o && patchTasks({ creating: null })}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">{creating && <Form status={creating.status} />}</DialogContent>
    </Dialog>
  );
}

function Form({ status: initialStatus }: { status: TaskStatus }): ReactElement {
  const me = useTasks((s) => s.me);
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [kind, setKind] = useState<TaskKind>('improvement');
  const [priority, setPriority] = useState<TaskPriority>('normal');
  const [status, setStatus] = useState<TaskStatus>(STATUSES.includes(initialStatus) ? initialStatus : 'backlog');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const needName = !me;
  const ok = !!title.trim() && (!needName || !!cleanName(name)) && !busy;

  const add = (fs: File[]) => setFiles((cur) => [...cur, ...fs.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], pastedName(f, cur.length + i), { type: f.type })))].slice(0, TASK_LIMITS.files));
  const submit = async () => {
    if (!ok) return;
    if (needName && !saveName(name)) return;
    setBusy(true);
    const t = await createTask({ title: title.trim(), description, kind, priority, status }, files);
    if (!t) setBusy(false);
  };

  return (
    <form
      className={cn('flex flex-col gap-4', over && 'rounded-lg ring-2 ring-ring ring-offset-4 ring-offset-popover')}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void submit();
        }
      }}
      onPaste={(e) => {
        const fs = [...e.clipboardData.files];
        if (!fs.length || copiedFromOffice(e.clipboardData)) return;
        e.preventDefault();
        add(fs);
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setOver(false)}
      onDrop={(e) => {
        setOver(false);
        const fs = [...e.dataTransfer.files];
        if (!fs.length) return;
        e.preventDefault();
        add(fs);
      }}
    >
      <DialogHeader>
        <DialogTitle>Новая задача</DialogTitle>
        <DialogDescription>Чем точнее описание, тем быстрее её сделают — человек или ИИ-агент.</DialogDescription>
      </DialogHeader>

      {needName && (
        <div className="rounded-lg border bg-muted/40 p-3">
          <NameInput value={name} onChange={setName} id="new-task-me" autoFocus />
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <label htmlFor="new-task-title" className="text-sm font-medium">
          Заголовок
        </label>
        <Input
          id="new-task-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={TASK_LIMITS.title}
          placeholder="Коротко: что сделать или что сломалось"
          autoFocus={!needName}
          autoComplete="off"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="new-task-desc" className="text-sm font-medium">
          Описание
        </label>
        <Textarea
          id="new-task-desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={TASK_LIMITS.description}
          rows={6}
          className="max-h-[40vh] min-h-28"
          placeholder={'Что сейчас и как должно быть, на каком заказе или чертеже видно, как проверить.\nСкриншот — вставьте Ctrl+V, чертёж — перетащите сюда.'}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <span id="new-task-kind" className="text-sm font-medium">
          Тип
        </span>
        <ToggleGroup type="single" variant="outline" size="sm" spacing={0} value={kind} onValueChange={(v) => v && setKind(v as TaskKind)} aria-labelledby="new-task-kind" className="w-full">
          {TASK_KINDS.map((k) => (
            <ToggleGroupItem key={k} value={k} title={KIND_HINT[k]} className="flex-1 gap-1.5 pointer-coarse:h-9 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">
              <KindIcon kind={k} className="size-3.5" />
              {KIND_LABEL[k]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Приоритет</span>
          <Select value={priority} onValueChange={(v) => setPriority(v as TaskPriority)}>
            <SelectTrigger className="w-full">
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
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Колонка</span>
          <Select value={status} onValueChange={(v) => setStatus(v as TaskStatus)}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              {STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {STATUS_LABEL[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      </div>
      {status === 'todo' && <p className="-mt-2 text-xs text-muted-foreground">Из «К работе» задачу может взять ИИ-агент — опишите её так, чтобы вопросов не осталось.</p>}

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">Вложения</span>
          <Button type="button" size="xs" variant="outline" className="ms-auto" onClick={() => input.current?.click()}>
            <Paperclip data-icon="inline-start" />
            Приложить
          </Button>
          <input
            ref={input}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              add([...(e.target.files ?? [])]);
              e.target.value = '';
            }}
          />
        </div>
        {files.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5">
            {files.map((f, i) => (
              <li key={i} className="flex max-w-full items-center gap-1 rounded-md border bg-muted/50 py-0.5 ps-2 pe-0.5 text-xs">
                <span className="truncate">{f.name}</span>
                <span className="shrink-0 text-muted-foreground">{fileSize(f.size)}</span>
                <Button type="button" size="icon-xs" variant="ghost" aria-label={`Убрать ${f.name}`} onClick={() => setFiles((cur) => cur.filter((_, k) => k !== i))}>
                  <X />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">Скриншот, чертёж PDF или DXF, на котором видна проблема. Большие картинки сожмём.</p>
        )}
      </div>

      <DialogFooter className="items-center">
        <span className="me-auto hidden text-xs text-muted-foreground sm:inline">
          <Kbd>{MOD} Enter</Kbd> — создать
        </span>
        <Button type="button" variant="ghost" onClick={() => patchTasks({ creating: null })}>
          Отмена
        </Button>
        <Button type="submit" disabled={!ok}>
          {busy ? 'Создаю…' : 'Создать задачу'}
        </Button>
      </DialogFooter>
    </form>
  );
}
