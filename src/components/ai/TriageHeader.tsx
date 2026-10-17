// «Замечание k из N» с переходами назад/далее и «Закончить» — над карточкой во время разбора по очереди.
// Клавиши (↓/J, ↑/K, Esc) подключает карточка позиции (P4).
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { ChevronDown, ChevronUp } from '@/components/common/icons.ts';
import { closeSheet } from '@/store/actions.ts';
import { endTriage, triageNext, triagePrev } from '@/store/aiActions.ts';
import { useDerived } from '@/store/derived.tsx';
import { useStore } from '@/store/store.ts';

export function TriageHeader(): ReactElement | null {
  const triage = useStore((s) => s.ui.triage);
  const { attention } = useDerived();
  if (!triage) return null;
  const open = new Set(attention.open.map((x) => x.id));
  const hasPrev = triage.ids.slice(0, triage.index).some((id) => open.has(id));
  // «Далее» ведёт к любому другому открытому: дальше по списку, пропущенным раньше или появившимся во время разбора
  const current = triage.ids[triage.index];
  const hasNext = attention.open.some((x) => x.id !== current);
  const resolved = triage.ids.filter((id) => !open.has(id)).length;
  return (
    <div role="group" aria-label="Разбор замечаний по очереди" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-ai-soft/60 px-5 py-2">
      <span className="text-sm font-medium tabular-nums">
        Замечание {triage.index + 1} из {triage.ids.length}
      </span>
      <span className="text-xs text-muted-foreground tabular-nums">решено {resolved}</span>
      <div className="ml-auto flex items-center gap-1">
        <Button variant="ghost" size="sm" onClick={triagePrev} disabled={!hasPrev} aria-label="Предыдущее замечание (K)">
          <ChevronUp aria-hidden />
          Назад
        </Button>
        <Button variant="outline" size="sm" onClick={triageNext} disabled={!hasNext} aria-label="Следующее замечание (J)">
          Далее
          <ChevronDown aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            endTriage('user');
            closeSheet();
          }}
        >
          Закончить
        </Button>
      </div>
    </div>
  );
}
