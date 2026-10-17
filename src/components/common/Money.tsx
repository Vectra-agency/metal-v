// Деньги: моноширинные цифры, без переноса; нет значения — «—» (диктор: «нет цены»).
import type { ReactElement } from 'react';
import { cn } from '@/lib/utils.ts';
import { NBSP, rub, rub2, signedRub } from '@/format.ts';

export interface MoneyProps {
  value: number | null | undefined;
  kop?: boolean; // всегда с копейками
  sign?: boolean; // «+1 240 ₽» / «−1 240 ₽»
  approx?: boolean; // «≈ » впереди
  className?: string;
}

export function Money({ value, kop, sign, approx, className }: MoneyProps): ReactElement {
  if (value == null || !Number.isFinite(value)) {
    return (
      <span className={cn('whitespace-nowrap text-muted-foreground tabular-nums', className)} title="нет цены">
        <span aria-hidden>—</span>
        <span className="sr-only">нет цены</span>
      </span>
    );
  }
  const text = sign ? signedRub(value, kop) : kop ? rub2(value) : rub(value);
  return (
    <span className={cn('whitespace-nowrap tabular-nums', className)}>
      {approx ? `≈${NBSP}` : ''}
      {text}
    </span>
  );
}
