// «ИИ-агенты»: как подключить доску к агентам, которые работают с кодом локально (CLI scripts/tasks.ts
// и навык Claude Code .claude/skills/tasks). Команды — с кнопкой «Скопировать».
import type { ReactElement, ReactNode } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button.tsx';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx';
import { Copy } from '@/components/common/icons.ts';
import { patchTasks, useTasks } from '@/tasks/store.ts';

const PROD = 'https://metal.vectra-agency.tech';

function Cmd({ children }: { children: string }): ReactElement {
  return (
    <div className="flex items-center gap-1 rounded-md bg-muted py-1 ps-2.5 pe-1 font-mono text-xs">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre">{children}</code>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={`Скопировать: ${children}`}
        onClick={() =>
          void navigator.clipboard.writeText(children).then(
            () => toast.success('Команда скопирована'),
            () => toast.error('Не удалось скопировать'),
          )
        }
      >
        <Copy />
      </Button>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }): ReactElement {
  return (
    <li className="flex gap-3">
      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">{n}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="text-sm font-medium">{title}</span>
        {children}
      </div>
    </li>
  );
}

export function AgentDialog(): ReactElement {
  const open = useTasks((s) => s.agentHelp);
  const origin = typeof location === 'undefined' ? PROD : location.origin;
  const urlFlag = origin === PROD ? '' : ` --url ${origin}`;
  return (
    <Dialog open={open} onOpenChange={(o) => patchTasks({ agentHelp: o })}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>ИИ-агенты и доска</DialogTitle>
          <DialogDescription>
            Агент работает с кодом на вашем компьютере: забирает задачу из «К работе», делает её в отдельной ветке и возвращает в «На проверке» с отчётом в
            комментарии.
          </DialogDescription>
        </DialogHeader>
        <ol className="flex flex-col gap-4">
          <Step n={1} title="Один раз: войти из папки проекта (calc)">
            <Cmd>{`npm run tasks -- login${urlFlag}`}</Cmd>
            <p className="text-xs text-muted-foreground">Спросит пароль сайта; вход на 30 дней хранится в .tasks/ (в git не попадает).</p>
          </Step>
          <Step n={2} title="Claude Code: взять задачу">
            <Cmd>/tasks</Cmd>
            <p className="text-xs text-muted-foreground">
              Следующая задача из «К работе» (срочные — раньше). Конкретная — <code>/tasks 12</code>. Разбирать очередь, пока не кончится, — <code>/loop /tasks</code>.
            </p>
          </Step>
          <Step n={3} title="Любой другой агент (Codex, Cursor…)">
            <Cmd>npm run tasks -- pull</Cmd>
            <p className="text-xs text-muted-foreground">
              Доска — в .tasks/BOARD.md, по файлу на задачу, вложения рядом. Дальше <code>next</code>, <code>take</code>, <code>ask</code>, <code>review</code> — список:{' '}
              <code>npm run tasks -- help</code>.
            </p>
          </Step>
          <Step n={4} title="Вопросы и проверка">
            <p className="text-sm text-muted-foreground">
              Если агенту что-то неясно, он спрашивает в комментарии — на карточке появится «Агент ждёт ответа». Ответьте комментарием, и задачу снова можно брать.
              Сделанное агент переносит в «На проверке»: выкладка на сайт (push в main) — только после вашей проверки.
            </p>
          </Step>
        </ol>
      </DialogContent>
    </Dialog>
  );
}
