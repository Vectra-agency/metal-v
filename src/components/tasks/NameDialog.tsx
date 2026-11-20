// «Как вас зовут?»: имя подписывает задачи, комментарии и переносы на общей доске. Спрашиваем при первой записи
// (в диалоге новой задачи — полем прямо в форме) и запоминаем на этом устройстве; сменить — кнопкой с именем в шапке.
import { useState, type ReactElement } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx';
import { Input } from '@/components/ui/input.tsx';
import { cleanName, TASK_LIMITS } from '@/core/tasks.ts';
import { cancelNaming, saveName, useTasks } from '@/tasks/store.ts';

/** Поле имени и «Это я: …» — люди, которые уже писали на доску */
export function NameInput({ value, onChange, autoFocus, id = 'task-me' }: { value: string; onChange: (v: string) => void; autoFocus?: boolean; id?: string }): ReactElement {
  const people = useTasks((s) => s.board?.people ?? null);
  const me = useTasks((s) => s.me);
  const pick = (people ?? []).filter((p) => p !== me).slice(0, 6);
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        Как вас зовут?
      </label>
      <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} maxLength={TASK_LIMITS.name} autoComplete="name" placeholder="Например, Григорий" autoFocus={autoFocus} />
      {pick.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          Это я:
          {pick.map((p) => (
            <Button key={p} type="button" size="xs" variant={cleanName(value) === p ? 'secondary' : 'outline'} onClick={() => onChange(p)}>
              {p}
            </Button>
          ))}
        </div>
      )}
      <p className="text-xs text-muted-foreground">Имя увидят все на доске. Запомним на этом устройстве — больше не спросим.</p>
    </div>
  );
}

export function NameDialog(): ReactElement {
  const open = useTasks((s) => s.naming);
  const me = useTasks((s) => s.me);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && cancelNaming()}>
      <DialogContent className="sm:max-w-md">{open && <Form initial={me} />}</DialogContent>
    </Dialog>
  );
}

function Form({ initial }: { initial: string }): ReactElement {
  const [name, setName] = useState(initial);
  const ok = !!cleanName(name);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        saveName(name);
      }}
    >
      <DialogHeader>
        <DialogTitle>{initial ? 'Сменить имя' : 'Представьтесь'}</DialogTitle>
        <DialogDescription>Учётных записей нет — вход по общему паролю, поэтому на доске подписываемся именем.</DialogDescription>
      </DialogHeader>
      <NameInput value={name} onChange={setName} autoFocus />
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={cancelNaming}>
          Отмена
        </Button>
        <Button type="submit" disabled={!ok}>
          Сохранить
        </Button>
      </DialogFooter>
    </form>
  );
}
