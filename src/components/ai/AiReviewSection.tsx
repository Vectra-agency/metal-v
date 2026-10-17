// Раздел «Анализ ИИ» в карточке позиции: статус, комментарий с цитатами, операции, предложения с решениями
// (ждёт решения — «Принять»/«Отклонить»; применено/отклонено — переключатель «Учитывать») и ≈ Δ клиенту.
// Нет анализа — раздел скрыт.
import { useId, type ReactElement } from 'react';
import { aiDisabled, decisionOf, FIELD_OF, isApplicable, reviewFor } from '@/ai/apply.ts';
import type { AiStatus, AiSuggestion } from '@/core/ai.ts';
import type { OrderPosition } from '@/order.ts';
import { cn } from '@/lib/utils.ts';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Switch } from '@/components/ui/switch.tsx';
import { fieldLabel, formatAiValue, suggestionLabel } from '@/components/common/aiFormat.ts';
import { StatusIcon } from '@/components/common/StatusIcon.tsx';
import { acceptSuggestions, rejectSuggestions, setSuggestion } from '@/store/aiActions.ts';
import { useStore } from '@/store/store.ts';
import { AiText } from './AiText.tsx';
import { DeltaLine } from './OfferChip.tsx';
import { useSuggestionDelta } from './useSuggestionDelta.ts';

export interface AiReviewSectionProps {
  positionId: string;
}

const STATUS: Record<AiStatus, { kind: 'problem' | 'check' | 'ok'; label: string }> = {
  problem: { kind: 'problem', label: 'проблема' },
  check: { kind: 'check', label: 'проверить' },
  ok: { kind: 'ok', label: 'в порядке' },
};

/** «Количество: 1 шт → 5 шт», «+ Покраска 377 ₽/шт», «Исключить из расчёта» */
function suggestionText(s: AiSuggestion, base: OrderPosition): string {
  if (s.kind === 'disable') return 'Исключить из расчёта';
  if (s.kind === 'extra') return `${suggestionLabel(s)}/шт`;
  const f = FIELD_OF[s.kind] as 'materialId' | 'thickness' | 'qty' | 'bends';
  return `${fieldLabel(f)}: ${formatAiValue(f, base[f])} → ${suggestionLabel(s)}`;
}

function SuggestionRow({ s, base, positionId, locked }: { s: AiSuggestion; base: OrderPosition; positionId: string; locked: boolean }): ReactElement {
  const decision = useStore((st) => decisionOf(st.order.ai, s.id));
  const delta = useSuggestionDelta(s.id, !locked);
  const switchId = useId();
  const text = suggestionText(s, base);
  return (
    <li className="space-y-1 rounded-md border px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span
          className={cn('min-w-0 flex-1 text-sm font-medium', decision === 'rejected' && 'text-muted-foreground line-through decoration-muted-foreground/50')}
        >
          {text}
        </span>
        {locked ? null : decision === 'pending' ? (
          <span className="flex items-center gap-1">
            <span className="mr-1 text-xs text-ai">ждёт решения</span>
            <Button variant="outline" size="xs" className="text-ai hover:text-ai" onClick={() => acceptSuggestions([s.id])}>
              {s.kind === 'disable' ? 'Исключить' : 'Принять'}
            </Button>
            <Button variant="ghost" size="xs" onClick={() => rejectSuggestions([s.id])}>
              Отклонить
            </Button>
          </span>
        ) : (
          <span className="flex items-center gap-2">
            <Switch
              id={switchId}
              size="sm"
              checked={decision === 'applied'}
              onCheckedChange={(on) => setSuggestion(s.id, on)}
              aria-label={`Учитывать: ${text}`}
            />
            <label htmlFor={switchId} className="text-xs">
              Учитывать
            </label>
            <span className={cn('text-xs', decision === 'applied' ? 'text-ai' : 'text-muted-foreground')}>
              {decision === 'applied' ? 'применено' : 'отклонено'}
            </span>
          </span>
        )}
      </div>
      {s.reason && <AiText as="p" text={s.reason} positionId={positionId} evidence className="text-xs text-muted-foreground" />}
      {!locked && <DeltaLine delta={delta} className="block text-xs text-muted-foreground" />}
    </li>
  );
}

export function AiReviewSection({ positionId }: AiReviewSectionProps): ReactElement | null {
  const ai = useStore((s) => s.order.ai);
  const base = useStore((s) => s.order.positions.find((p) => p.id === positionId));
  const scope = useStore((s) => s.order.aiScope);
  const headingId = useId();
  if (!ai || !base) return null;
  const review = reviewFor(ai, positionId);
  const inScope = !scope?.length || scope.includes(positionId);
  const status = review ? STATUS[review.status] : inScope ? STATUS.ok : null;
  const offers = review?.suggestions.filter(isApplicable) ?? [];
  const locked = !!base.disabled; // исключена вручную — предложения не применяются
  const aiOff = !locked && aiDisabled(ai, positionId); // исключена по предложению ИИ — решается только само исключение
  return (
    <section aria-labelledby={headingId} data-sheet-focus="ai" className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={headingId} tabIndex={-1} className="text-sm font-semibold outline-none">
          Анализ ИИ
        </h3>
        {status && (
          <Badge variant="outline" className="gap-1">
            <StatusIcon kind={status.kind} />
            {status.label}
          </Badge>
        )}
      </div>
      {!review &&
        (inScope ? (
          <p className="text-sm text-muted-foreground">ИИ: замечаний нет</p>
        ) : (
          <p className="text-sm text-muted-foreground">ИИ эту позицию не проверял (добавлена после анализа или за пределами 150 позиций)</p>
        ))}
      {review?.comment && <AiText as="p" text={review.comment} positionId={positionId} evidence className="text-sm leading-relaxed" />}
      {review && review.operations.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="mr-1 text-xs text-muted-foreground">Операции:</span>
          {review.operations.map((op) => (
            <Badge key={op} variant="outline" className="font-normal">
              {op}
            </Badge>
          ))}
        </div>
      )}
      {offers.length > 0 && (
        <div className="space-y-1.5">
          <h4 className="text-xs font-medium text-muted-foreground">Предложения</h4>
          {locked && <p className="text-xs text-muted-foreground">Позиция исключена из расчёта — предложения ИИ не применяются.</p>}
          {aiOff && offers.length > 1 && (
            <p className="text-xs text-muted-foreground">Позиция исключена по предложению ИИ — остальные предложения не применяются, пока она не в расчёте.</p>
          )}
          <ul className="space-y-1.5">
            {offers.map((s) => (
              <SuggestionRow key={s.id} s={s} base={base} positionId={positionId} locked={locked || (aiOff && s.kind !== 'disable')} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
