// Полоса долей стоимости по категориям (сегменты с зазором 2 px) и цветная точка категории.
import type { ReactElement } from 'react';
import { cn } from '@/lib/utils.ts';

export type CatKey = 'material' | 'cut' | 'bend' | 'extras' | 'delivery';

/** Категории стоимости: цвет — только для меток (точки, полосы, детали на листах), не для текста */
export const CATS: readonly { key: CatKey; label: string; dot: string }[] = [
  { key: 'material', label: 'Металл', dot: 'bg-metal' },
  { key: 'cut', label: 'Резка', dot: 'bg-cut' },
  { key: 'bend', label: 'Гибка', dot: 'bg-bend' },
  { key: 'extras', label: 'Доп. работы', dot: 'bg-extra' },
  { key: 'delivery', label: 'Доставка', dot: 'bg-delivery' },
];

export interface CostBarProps {
  parts: Partial<Record<CatKey, number>>;
  className?: string; // высота — через h-* (по умолчанию h-1.5)
  title?: string;
}

export function CostBar({ parts, className, title }: CostBarProps): ReactElement {
  const items = CATS.map((c) => ({ ...c, v: Math.max(0, parts[c.key] ?? 0) })).filter((c) => c.v > 0);
  const total = items.reduce((a, c) => a + c.v, 0);
  const shares = items.map((c) => `${c.label} ${Math.round((c.v / total) * 100)} %`).join(', ');
  const label = title ?? (total > 0 ? shares : 'нет данных о стоимости');
  return (
    <div
      role="img"
      aria-label={label}
      title={title}
      className={cn('flex h-1.5 w-full min-w-10 gap-0.5 overflow-hidden rounded-full', total <= 0 && 'bg-muted', className)}
    >
      {items.map((c) => (
        <span key={c.key} className={cn('block h-full min-w-0.5', c.dot)} style={{ flexGrow: c.v / total, flexBasis: 0 }} />
      ))}
    </div>
  );
}

export function CatDot({ cat, className }: { cat: CatKey; className?: string }): ReactElement {
  const dot = CATS.find((c) => c.key === cat)?.dot;
  return <span aria-hidden className={cn('inline-block size-2 shrink-0 rounded-full', dot, className)} />;
}
