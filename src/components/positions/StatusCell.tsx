// Столбец «Проверка»: значок худшего открытого замечания и их число; проверено ИИ без замечаний — галочка.
// Подсказка перечисляет замечания; для диктора — то же словами.
import { memo, type ReactElement } from 'react';
import type { AttentionItem } from '@/attention.ts';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx';
import { StatusIcon } from '@/components/common/StatusIcon.tsx';
import { plural } from '@/format.ts';
import { cn } from '@/lib/utils.ts';

export interface StatusCellProps {
  items: AttentionItem[]; // открытые замечания позиции
  inScope: boolean; // позицию видел анализ ИИ
  word?: boolean; // со словом: «2 замечания» (шапка карточки)
  className?: string;
}

export const remarksWord = (n: number) => `${n} ${plural(n, 'замечание', 'замечания', 'замечаний')}`;

/** Подпись для диктора и подсказки */
export function statusText(items: AttentionItem[], inScope: boolean): string {
  if (items.length) return `${remarksWord(items.length)}: ${items.map((i) => i.title).join('; ')}`;
  return inScope ? 'Проверено ИИ, замечаний нет' : '';
}

function StatusCellImpl({ items, inScope, word, className }: StatusCellProps): ReactElement | null {
  const n = items.length;
  if (!n && !inScope) return null;
  const problem = items.some((i) => i.severity === 'problem');
  const label = statusText(items, inScope);
  const icon = n ? (
    <StatusIcon kind={problem ? 'problem' : 'check'} count={word ? undefined : n} label={word ? remarksWord(n) : undefined} />
  ) : (
    <StatusIcon kind="ok" label={word ? 'замечаний нет' : undefined} className={cn(!word && 'text-ok/70')} />
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span role="img" aria-label={label} className={cn('inline-flex items-center text-[13px] font-medium', className)}>
          {icon}
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-80">
        {n ? (
          <ul className="space-y-0.5">
            {items.slice(0, 8).map((i) => (
              <li key={i.id}>{i.title}</li>
            ))}
            {n > 8 && <li>и ещё {n - 8}</li>}
          </ul>
        ) : (
          'Проверено ИИ, замечаний нет'
        )}
      </TooltipContent>
    </Tooltip>
  );
}

// замечания пересобираются при каждом пересчёте — сравниваем по содержанию
const sameItems = (a: AttentionItem[], b: AttentionItem[]) =>
  a === b || (a.length === b.length && a.every((x, i) => x.id === b[i].id && x.title === b[i].title && x.severity === b[i].severity));

export const StatusCell = memo(
  StatusCellImpl,
  (a, b) => a.inScope === b.inScope && a.word === b.word && a.className === b.className && sameItems(a.items, b.items),
);
