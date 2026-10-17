// «В расчёте есть ошибки»: перед копированием, CSV или печатью для клиента, пока открыты замечания уровня «ошибка».
// «Вернуться к проверке» — разбор по очереди; «Всё равно …» — действие без проверки ({ force: true }).
import { useRef, type ReactElement } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog.tsx';
import { OctagonAlert } from '@/components/common/icons.ts';
import { plural } from '@/format.ts';
import { closeDialog } from '@/store/actions.ts';
import { startTriage } from '@/store/aiActions.ts';
import { useDerived } from '@/store/derived.tsx';
import { copyForClient, downloadClientCsv, printClient } from '@/store/quoteActions.ts';
import { useStore } from '@/store/store.ts';
import type { GuardAction } from '@/store/types.ts';

const FORCE_LABEL: Record<GuardAction, string> = {
  copy: 'Всё равно скопировать',
  copyTable: 'Всё равно скопировать',
  copyQuestions: 'Всё равно скопировать',
  csv: 'Всё равно скачать',
  print: 'Всё равно напечатать',
};
// куда попадут позиции без размеров
const TARGET: Record<GuardAction, string> = { copy: 'в текст', copyTable: 'в таблицу', copyQuestions: 'в текст', csv: 'в файл', print: 'в КП' };

function runForced(action: GuardAction): void {
  if (action === 'print') printClient({ force: true });
  else if (action === 'csv') downloadClientCsv({ force: true });
  else void copyForClient(action === 'copyTable' ? 'table' : action === 'copyQuestions' ? 'questions' : 'text', { force: true });
}

export function CopyGuardDialog(): ReactElement {
  const dialog = useStore((s) => s.ui.dialog);
  const d = useDerived();
  const current = dialog?.kind === 'guard' ? dialog.action : null;
  // при закрытии текст не должен меняться, пока диалог исчезает
  const last = useRef<GuardAction>('copy');
  if (current) last.current = current;
  const action = current ?? last.current;
  const problems = d.attention.open.filter((i) => i.severity === 'problem');
  const n = problems.length;
  const more = n - 3;

  return (
    <AlertDialog open={!!current} onOpenChange={(o) => !o && closeDialog()}>
      <AlertDialogContent className="data-[size=default]:sm:max-w-md">
        <AlertDialogHeader className="sm:grid-cols-[auto_1fr]">
          <AlertDialogMedia className="bg-danger-soft text-danger">
            <OctagonAlert />
          </AlertDialogMedia>
          <AlertDialogTitle>В расчёте есть ошибки</AlertDialogTitle>
          <AlertDialogDescription>
            {n} {plural(n, 'замечание', 'замечания', 'замечаний')} не разобрано:
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {problems.slice(0, 3).map((i) => (
            <li key={i.id}>{i.title}</li>
          ))}
          {more > 0 && <li className="list-none text-muted-foreground">… ещё {more}</li>}
        </ul>
        {d.quote.unpriced > 0 && (
          <p className="text-sm text-muted-foreground">Позиции без размеров попадут {TARGET[action]} как «цена уточняется» и не войдут в итог.</p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel
            variant="default"
            onClick={() => {
              closeDialog();
              startTriage();
            }}
          >
            Вернуться к проверке
          </AlertDialogCancel>
          <AlertDialogAction
            variant="outline"
            onClick={() => {
              closeDialog();
              runForced(action);
            }}
          >
            {FORCE_LABEL[action]}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
