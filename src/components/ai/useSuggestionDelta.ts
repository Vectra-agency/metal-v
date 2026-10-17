// Насколько предложение ИИ меняет цену клиенту (≈ Δ): считается лениво — только когда открыта подсказка,
// всплывающее окно или раздел карточки. Одна из двух сумм — текущая, поэтому это один лишний computeOrder.
// Δ разных предложений не складываются (взаимодействуют через раскрой) — показываются по одному.
import { useMemo } from 'react';
import { aiStateFrom, decisionOf, effectivePositions, pendingOffers, toggleSuggestion } from '@/ai/apply.ts';
import type { AiState } from '@/core/ai.ts';
import { computeOrder, type OrderResult } from '@/core/pricing.ts';
import { orderSettings } from '@/order.ts';
import { buildQuote, pricedPositions } from '@/quote.ts';
import { selectCalcInput, useDerived, type CalcInput } from '@/store/derived.tsx';
import type { PendingAi } from '@/store/types.ts';
import { useStore } from '@/store/store.ts';

// кэш по расчёту; в ключе — и округление цены за шт (его нет в OrderResult, а итог КП от него зависит)
const cache = new WeakMap<OrderResult, Map<string, number>>();

/** Итог КП при другом состоянии решений ИИ (деньги — без позиций без размеров, как в derived) */
function totalWith(input: CalcInput, ai: AiState | undefined): number {
  const { order, book, settings, quote } = input;
  const positions = effectivePositions(order.positions, ai);
  const res = computeOrder(pricedPositions(positions), book, orderSettings(order, settings));
  return buildQuote({ order: { ...order, ai }, positions, res, settings, quote, book }).total;
}

function cached(input: CalcInput, res: OrderResult, key: string, fn: () => number | null): number | null {
  let m = cache.get(res);
  if (!m) cache.set(res, (m = new Map()));
  const k = `${input.quote.rounding}|${key}`;
  if (m.has(k)) return m.get(k)!;
  const v = fn();
  if (v != null) m.set(k, v);
  return v;
}

/** Δ одного предложения: «с ним» − «без него» */
export function suggestionDelta(input: CalcInput, res: OrderResult, currentTotal: number, id: string): number | null {
  const ai = input.order.ai;
  if (!ai) return null;
  return cached(input, res, `s|${id}|${decisionOf(ai, id)}`, () => {
    const on = decisionOf(ai, id) === 'applied';
    const alt = toggleSuggestion(ai, id, !on);
    if (alt === ai) return null;
    const other = totalWith(input, alt);
    return on ? currentTotal - other : other - currentTotal;
  });
}

/** ≈ Δ клиенту для предложения; null — не считали (закрыто, идёт пересчёт) */
export function useSuggestionDelta(id: string, enabled: boolean): number | null {
  const d = useDerived();
  const input = useStore(selectCalcInput);
  return useMemo(() => (enabled && !d.stale ? suggestionDelta(input, d.res, d.quote.total, id) : null), [enabled, d.stale, d.res, d.quote.total, input, id]);
}

/** «Принять все предложения (M) · Δ»: все ждущие решения, по одному на поле позиции */
export function useAcceptAllDelta(enabled: boolean): number | null {
  const d = useDerived();
  const input = useStore(selectCalcInput);
  return useMemo(() => {
    const ai = input.order.ai;
    if (!enabled || d.stale || !ai) return null;
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const { positionId, s } of pendingOffers(ai, input.order.positions)) {
      const k = `${positionId}|${s.kind}`;
      if (s.kind !== 'extra' && seen.has(k)) continue;
      seen.add(k);
      ids.push(s.id);
    }
    if (!ids.length) return null;
    return cached(
      input,
      d.res,
      `all|${ids.join(',')}`,
      () =>
        totalWith(
          input,
          ids.reduce((x, id) => toggleSuggestion(x, id, true), ai),
        ) - d.quote.total,
    );
  }, [enabled, d.stale, d.res, d.quote.total, input]);
}

/** Поздний результат: сколько предложений включит политика по умолчанию (кроме перенесённых) и Δ итога */
export function usePendingSummary(p: PendingAi | null): { n: number; delta: number | null } {
  const d = useDerived();
  const input = useStore(selectCalcInput);
  return useMemo(() => {
    if (!p) return { n: 0, delta: null };
    const { order } = input;
    const full = aiStateFrom(p.analysis, order.positions, p.contextHash, { prev: order.ai });
    const carried = aiStateFrom(p.analysis, order.positions, p.contextHash, { prev: order.ai, defaults: false });
    const n = Object.keys(full.accepted).filter((id) => full.accepted[id] === true && carried.accepted[id] !== true).length;
    if (d.stale) return { n, delta: null };
    return { n, delta: cached(input, d.res, `pending|${p.receivedAt}`, () => totalWith(input, full) - d.quote.total) };
  }, [p, input, d.stale, d.res, d.quote.total]);
}
