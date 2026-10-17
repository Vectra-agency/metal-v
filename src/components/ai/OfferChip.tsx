// Предложение ИИ, ждущее решения: пунктирный фиолетовый чип под полем («✦ 5 шт?»). Щелчок — принять
// (уведомление с «Отменить»), ✕ — отклонить (с «Вернуть»). Подсказка: причина с цитатами и ≈ Δ клиенту.
import { useState, type ReactElement } from 'react';
import type { AiSuggestion } from '@/core/ai.ts';
import { FIELD_OF } from '@/ai/apply.ts';
import { signedRub } from '@/format.ts';
import { cn } from '@/lib/utils.ts';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx';
import { fieldLabel, suggestionLabel } from '@/components/common/aiFormat.ts';
import { X } from '@/components/common/icons.ts';
import { acceptSuggestions, rejectSuggestions } from '@/store/aiActions.ts';
import { AiText } from './AiText.tsx';
import { useSuggestionDelta } from './useSuggestionDelta.ts';

export interface OfferChipProps {
  suggestion: AiSuggestion;
  positionId: string;
  size?: 'xs' | 'sm';
}

/** Строка «≈ +1 240 ₽ клиенту» (Δ считается, пока открыта подсказка) */
export function DeltaLine({ delta, className }: { delta: number | null; className?: string }): ReactElement {
  return <span className={cn('tabular-nums', className)}>{delta == null ? 'считаю, как изменится цена…' : `≈ ${signedRub(delta)} клиенту`}</span>;
}

export function OfferChip({ suggestion, positionId, size = 'xs' }: OfferChipProps): ReactElement {
  const [open, setOpen] = useState(false);
  const delta = useSuggestionDelta(suggestion.id, open);
  const label = suggestionLabel(suggestion);
  const what = suggestion.kind === 'disable' ? 'исключить позицию из расчёта' : `${fieldLabel(FIELD_OF[suggestion.kind]).toLowerCase()} ${label}`;
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-stretch rounded-full border border-dashed border-ai bg-background text-ai',
        size === 'xs' ? 'h-5 text-[11px] leading-none' : 'h-6 text-xs leading-none',
      )}
    >
      <Tooltip open={open} onOpenChange={setOpen}>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              acceptSuggestions([suggestion.id]);
            }}
            aria-label={`Принять предложение ИИ: ${what}`}
            className="focus-ring inline-flex min-w-0 items-center gap-0.5 rounded-l-full pr-0.5 pl-1.5 whitespace-nowrap hover:bg-ai-soft"
          >
            <span aria-hidden>✦</span>
            <span className="truncate">{label}?</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-80 flex-col items-start gap-1 text-left">
          <span className="font-medium">Предложение ИИ: {what}</span>
          {suggestion.reason && <AiText text={suggestion.reason} positionId={positionId} evidence plainMarks className="opacity-90" />}
          <DeltaLine delta={delta} />
          <span className="opacity-70">Щелчок — принять, ✕ — отклонить</span>
        </TooltipContent>
      </Tooltip>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          rejectSuggestions([suggestion.id]);
        }}
        aria-label="Отклонить предложение ИИ"
        title="Отклонить"
        className="focus-ring inline-flex items-center rounded-r-full pr-1 pl-0.5 hover:bg-ai-soft"
      >
        <X aria-hidden className="size-3" />
      </button>
    </span>
  );
}
