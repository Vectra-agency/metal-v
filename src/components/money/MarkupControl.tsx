// Наценка: пресеты 30/50/70/100 % и своя (поле %). Своё значение — ни один пресет не нажат.
import type { ReactElement } from 'react';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group.tsx';
import { NumInput } from '@/components/common/NumInput.tsx';
import { cn } from '@/lib/utils.ts';
import { NBSP, pct1 } from '@/format.ts';
import { setMarkup } from '@/store/actions.ts';
import { useStore } from '@/store/store.ts';

export const MARKUP_PRESETS: readonly number[] = [30, 50, 70, 100];

/** Нажатый пункт переключателя — заливкой (бледный bg-muted почти не виден): наценка, округление цены за шт */
export const TOGGLE_ON =
  'pointer-coarse:h-9 data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:hover:bg-primary/90';

/** Маржа от цены при наценке m: m / (100 + m) — «33,3 %» при 50 % */
export const marginOf = (m: number): number => (m > -100 ? (m / (100 + m)) * 100 : 0);

/** «= маржа 33,3 % от цены» */
export const marginLine = (m: number): string => `= маржа ${pct1(marginOf(m))} от цены`;

export function MarkupControl({ className }: { className?: string }): ReactElement {
  const m = useStore((s) => s.order.markupPct);
  const preset = MARKUP_PRESETS.includes(m) ? String(m) : '';
  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        spacing={0}
        value={preset}
        onValueChange={(v) => v && setMarkup(Number(v))}
        aria-label="Наценка, пресеты"
      >
        {MARKUP_PRESETS.map((p) => (
          <ToggleGroupItem
            key={p}
            value={String(p)}
            aria-label={`Наценка ${p} %`}
            className={cn('tabular-nums group-data-[spacing=0]/toggle-group:px-1.5', TOGGLE_ON)}
          >
            {`${p}${NBSP}%`}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <NumInput value={m} onChange={setMarkup} max={1000} suffix="%" aria-label="Своя наценка, %" size="sm" className="w-16" />
    </div>
  );
}
