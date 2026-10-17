// «Не найдено в файле»: жёлтая пунктирная рамка, значок «?» и подсказка — одинаково у всех полей.
import { useId, type ReactElement, type ReactNode } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx';
import { CircleHelp } from './icons.ts';

export const GUESSED_HINT = 'Не найдено в файле — стоит значение по умолчанию. Проверьте.';
/** Классы поля с угаданным значением */
export const GUESSED_CLASS = 'border-dashed border-guessed bg-guessed-soft dark:bg-guessed-soft';
/** Классы поля со значением, изменённым ИИ */
export const AI_CLASS = 'border-ai';

export function GuessedIcon({ className }: { className?: string }): ReactElement {
  return <CircleHelp aria-hidden className={className ?? 'size-3 shrink-0 text-guessed'} />;
}

/** Подсказка над полем, если значение угадано; иначе — само поле без обёртки */
export function GuessedTooltip({ guessed, children }: { guessed?: boolean; children: ReactElement }): ReactNode {
  if (!guessed) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{GUESSED_HINT}</TooltipContent>
    </Tooltip>
  );
}

/** Скрытое пояснение для экранного диктора (id → aria-describedby) */
export function useGuessedDescription(guessed?: boolean): { id: string | undefined; node: ReactNode } {
  const id = useId();
  if (!guessed) return { id: undefined, node: null };
  return {
    id,
    node: (
      <span id={id} className="sr-only">
        {GUESSED_HINT}
      </span>
    ),
  };
}
