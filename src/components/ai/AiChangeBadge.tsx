// Применённое изменение ИИ: значок «✦ ИИ» у поля; во всплывающем окне — «было → стало», причина с цитатами,
// ≈ Δ клиенту и «Вернуть {было}» (для исключённой позиции — «Вернуть в расчёт»).
import { useState, type ReactElement } from 'react';
import type { AiChange } from '@/ai/apply.ts';
import { Button } from '@/components/ui/button.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx';
import { formatAiValue } from '@/components/common/aiFormat.ts';
import { rejectSuggestions } from '@/store/aiActions.ts';
import { AiText } from './AiText.tsx';
import { DeltaLine } from './OfferChip.tsx';
import { useSuggestionDelta } from './useSuggestionDelta.ts';

export interface AiChangeBadgeProps {
  change: AiChange;
  positionId: string;
}

/** «Изменено ИИ: 1 шт → 5 шт» / «Добавлено ИИ: …» / «Исключено ИИ из расчёта» */
export function changeHeading(c: AiChange): string {
  if (c.field === 'disabled') return 'Исключено ИИ из расчёта';
  if (c.field === 'extras') return `Добавлено ИИ: ${formatAiValue('extras', c.to)}/шт`;
  return `Изменено ИИ: ${formatAiValue(c.field, c.from)} → ${formatAiValue(c.field, c.to)}`;
}

/** «Вернуть 1 шт», «Вернуть в расчёт», «Убрать» */
export function changeRevertLabel(c: AiChange): string {
  if (c.field === 'disabled') return 'Вернуть в расчёт';
  if (c.field === 'extras') return 'Убрать';
  return `Вернуть ${formatAiValue(c.field, c.from)}`;
}

export function AiChangeBadge({ change, positionId }: AiChangeBadgeProps): ReactElement {
  const [open, setOpen] = useState(false);
  const delta = useSuggestionDelta(change.suggestion.id, open);
  const disable = change.field === 'disabled';
  const heading = changeHeading(change);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          aria-label={`${heading}. Подробнее`}
          className="focus-ring inline-flex h-5 shrink-0 items-center gap-0.5 rounded-full bg-ai-soft px-1.5 text-[11px] leading-none font-medium whitespace-nowrap text-ai hover:bg-ai/15"
        >
          <span aria-hidden>✦</span> ИИ{disable ? ': исключена' : ''}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80" onClick={(e) => e.stopPropagation()}>
        <div className="font-medium">{heading}</div>
        {change.suggestion.reason && (
          <AiText as="p" text={change.suggestion.reason} positionId={positionId} evidence className="text-xs text-muted-foreground" />
        )}
        <DeltaLine delta={delta} className="text-xs" />
        <div>
          <Button
            variant="outline"
            size="xs"
            onClick={() => {
              setOpen(false);
              rejectSuggestions([change.suggestion.id], { message: 'Изменение ИИ отменено' });
            }}
          >
            {changeRevertLabel(change)}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
