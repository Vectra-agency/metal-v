// Поздний результат анализа ИИ (после «Показать расчёт без ИИ» или правок во время анализа): числа не меняются,
// пока менеджер не решит — «Применить рекомендуемые (N) · Δ», «Посмотреть» (всё новое ждёт решения) или ✕.
import type { ReactElement } from 'react';
import { isApplicable } from '@/ai/apply.ts';
import { plural, signedRub } from '@/format.ts';
import { Button } from '@/components/ui/button.tsx';
import { Sparkles, X } from '@/components/common/icons.ts';
import { applyPendingAi, dismissPendingAi, reviewPendingAi } from '@/store/pipelineActions.ts';
import { useStore } from '@/store/store.ts';
import { usePendingSummary } from './useSuggestionDelta.ts';

export function PendingAiBanner(): ReactElement | null {
  const p = useStore((s) => s.ai.pending);
  const { n, delta } = usePendingSummary(p);
  if (!p) return null;
  const reviews = p.analysis.positions;
  const P = reviews.filter((r) => r.status === 'problem').length;
  const C = reviews.filter((r) => r.status === 'check').length;
  const S = reviews.reduce((a, r) => a + r.suggestions.filter(isApplicable).length, 0);
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-ai-soft p-3">
      <Sparkles aria-hidden className="size-4 shrink-0 text-ai" />
      <span className="text-sm">
        Анализ ИИ готов: {P} {plural(P, 'проблема', 'проблемы', 'проблем')}, {C} {plural(C, 'замечание', 'замечания', 'замечаний')}, {S}{' '}
        {plural(S, 'предложение', 'предложения', 'предложений')}
      </span>
      <div className="flex flex-wrap items-center gap-2">
        {/* применять нечего — основная кнопка «Посмотреть» */}
        {n > 0 && (
          <Button size="sm" onClick={applyPendingAi} className="tabular-nums">
            Применить рекомендуемые ({n}){delta != null && Math.abs(delta) >= 0.005 ? ` · ${signedRub(delta)}` : ''}
          </Button>
        )}
        <Button size="sm" variant={n > 0 ? 'outline' : 'default'} onClick={reviewPendingAi}>
          Посмотреть
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="Не применять анализ" title="Не применять анализ" onClick={dismissPendingAi}>
          <X aria-hidden />
        </Button>
      </div>
    </div>
  );
}
