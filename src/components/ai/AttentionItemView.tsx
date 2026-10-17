// Одно замечание: значок важности, заголовок-ссылка (к позиции или к месту в заказе), пояснение с отметками цитат,
// кнопки действий: основное — обведённое, остальные — без рамки, «Верно» — последней. dense — строка в списке
// (пояснение в 2 строки), иначе — полностью (в боковой панели).
import type { ReactElement, ReactNode } from 'react';
import { focusOf, type AttentionAction, type AttentionItem } from '@/attention.ts';
import { checkQuote, normalize, quoteSpans } from '@/evidence.ts';
import { hhmm } from '@/format.ts';
import { cn } from '@/lib/utils.ts';
import { Button } from '@/components/ui/button.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx';
import { StatusIcon } from '@/components/common/StatusIcon.tsx';
import { X } from '@/components/common/icons.ts';
import { openPosition } from '@/store/actions.ts';
import { runAttentionAction } from '@/store/aiActions.ts';
import { useStore } from '@/store/store.ts';
import { AiText, EvidenceMark, useEvidenceSources } from './AiText.tsx';

export interface AttentionItemViewProps {
  item: AttentionItem;
  dense?: boolean;
  current?: boolean; // текущее в разборе по очереди
}

const AI_KINDS = new Set<AttentionItem['kind']>(['aiProblem', 'aiCheck', 'aiOffer', 'aiAuto']);

function labelOf(item: AttentionItem, a: AttentionAction): string {
  switch (a.kind) {
    case 'open':
      return a.label ?? 'Открыть';
    case 'ack':
      return item.ackLabel ?? 'Верно';
    case 'accept':
    case 'revert':
    case 'group':
    case 'filter':
      return a.label;
    case 'reject':
      return 'Отклонить';
    case 'setDims':
      return 'Задать габарит';
    case 'drawing':
      return 'Чертёж';
    case 'addPart':
      return '+ Добавить деталь';
    case 'refreshPrices':
      return 'Обновить цены';
    case 'runAi':
      return 'Запустить анализ ИИ';
  }
}

/** Куда ведёт заголовок: позиция — её карточка; замечание заказа — его первое действие (кроме «Верно») */
function navigate(item: AttentionItem): (() => void) | null {
  if (item.positionId) {
    const id = item.positionId;
    return () => openPosition(id, { reveal: true, focus: focusOf(item) });
  }
  const first = item.actions.find((a) => a.kind !== 'ack');
  return first ? () => runAttentionAction(item, first) : null;
}

export function AttentionItemView({ item, dense = true, current }: AttentionItemViewProps): ReactElement {
  const configured = useStore((s) => !!s.ai.server?.configured);
  const blockedUntil = useStore((s) => s.prices.blockedUntil);
  const pricesBusy = useStore((s) => !!s.prices.busy);
  const src = useEvidenceSources();
  const ai = AI_KINDS.has(item.kind);
  // цитаты в заголовке: отметка сразу после «…» (без подсказки — заголовок сам кнопка)
  const title: ReactNode[] = [];
  if (ai) {
    let at = 0;
    for (const q of quoteSpans(item.title)) {
      if (normalize(q.inner).length < 4) continue;
      title.push(item.title.slice(at, q.end), <EvidenceMark key={q.end} e={checkQuote(q.inner, src, item.positionId)} plain />);
      at = q.end;
    }
    title.push(item.title.slice(at));
  } else title.push(item.title);
  const go = navigate(item);
  // замечание ИИ с ждущим предложением решают «Принять»/«Отклонить»: «Верно» закрыло бы его, а предложение
  // (например, «Исключить») осталось бы висеть, и позиция молча осталась бы в расчёте
  const deciding = (item.kind === 'aiProblem' || item.kind === 'aiCheck') && item.actions.some((a) => a.kind === 'reject');
  const actions = item.closed ? [] : item.actions.filter((a) => (a.kind !== 'runAi' || configured) && !(deciding && a.kind === 'ack'));
  const offers = actions.filter((a) => a.kind === 'accept').length;
  const blocked = blockedUntil != null && blockedUntil > Date.now();

  const button = (a: AttentionAction, i: number, primary: boolean): ReactElement => {
    const label = labelOf(item, a);
    // несколько предложений в одном замечании: «Принять …» + ✕ рядом с ним
    if (a.kind === 'reject' && offers > 1) {
      const pair = actions[i - 1];
      const what = pair?.kind === 'accept' ? pair.label.replace(/^Принять\s*/, '') : '';
      return (
        <Button
          key={i}
          variant="ghost"
          size="icon-xs"
          aria-label={`Отклонить ${what}`.trim()}
          title="Отклонить"
          onClick={() => runAttentionAction(item, a)}
          className="-ml-1 text-muted-foreground"
        >
          <X aria-hidden />
        </Button>
      );
    }
    const disabled = a.kind === 'refreshPrices' && (blocked || pricesBusy);
    const el = (
      <Button
        key={i}
        variant={primary ? 'outline' : 'ghost'}
        size="xs"
        disabled={disabled}
        title={a.kind === 'ack' && !item.ackLabel ? 'Проверено — скрыть замечание' : undefined}
        onClick={() => runAttentionAction(item, a)}
        className={cn(a.kind === 'accept' && 'text-ai hover:text-ai')}
      >
        {label}
      </Button>
    );
    if (a.kind === 'refreshPrices' && blocked) {
      return (
        <Tooltip key={i}>
          <TooltipTrigger asChild>
            <span tabIndex={0} className="focus-ring rounded-md">
              {el}
            </span>
          </TooltipTrigger>
          <TooltipContent>Можно повторить в {hhmm(blockedUntil)}</TooltipContent>
        </Tooltip>
      );
    }
    return el;
  };

  return (
    <div
      data-attention-id={item.id}
      className={cn(
        'flex items-start gap-2 rounded-md py-1.5',
        !dense && 'py-2',
        current && '-mx-2 bg-ai-soft/40 px-2 ring-2 ring-ai/40',
        item.closed && 'opacity-70',
      )}
    >
      <StatusIcon kind={item.closed ? 'ok' : item.severity} className="mt-0.75 shrink-0 text-[13px]" />
      <div className="min-w-0 flex-1">
        <div className={cn('leading-snug', dense ? 'text-[13px]' : 'text-sm')}>
          {go ? (
            <button type="button" onClick={go} className="focus-ring rounded-sm text-left font-medium text-foreground underline-offset-2 hover:underline">
              {title}
            </button>
          ) : (
            <span className="font-medium">{title}</span>
          )}
          {item.closed && <span className="ml-1.5 text-xs text-ok">решено</span>}
        </div>
        {item.text && (
          <AiText
            as="p"
            text={item.text}
            positionId={item.positionId}
            evidence={ai}
            className={cn('mt-0.5 text-xs text-muted-foreground', dense && 'line-clamp-2')}
          />
        )}
        {actions.length > 0 && <div className="mt-1 flex flex-wrap items-center gap-1">{actions.map((a, i) => button(a, i, i === 0 && a.kind !== 'ack'))}</div>}
      </div>
    </div>
  );
}
