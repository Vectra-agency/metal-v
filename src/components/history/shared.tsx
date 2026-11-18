// Общее для истории заказов: отклонение расчёта от счёта цеха, название цеха, подпись счёта.
import type { ReactElement } from 'react';
import { cn } from '@/lib/utils.ts';
import { dateDay, NBSP } from '@/format.ts';

/** Отклонение нашего расчёта от счёта, % (+ — расчёт выше счёта); null — сравнивать не с чем */
export function diffPct(calc: number | null | undefined, fact: number | null | undefined): number | null {
  if (calc == null || fact == null || !(fact > 0) || !Number.isFinite(calc)) return null;
  return ((calc - fact) / fact) * 100;
}

/** «−4 %» с цветом: до 10 % — сходится, до 25 % — заметно, больше — расчёт неверен */
export function DiffBadge({ calc, fact, className, title }: { calc: number | null | undefined; fact: number | null | undefined; className?: string; title?: string }): ReactElement | null {
  const d = diffPct(calc, fact);
  if (d == null) return null;
  const a = Math.abs(d);
  const r = Math.round(d);
  const tone = a <= 10 ? 'bg-ok-soft text-ok' : a <= 25 ? 'bg-warn-soft text-warn' : 'bg-danger-soft text-danger';
  const text = r === 0 ? `0${NBSP}%` : `${r > 0 ? '+' : '−'}${Math.abs(r)}${NBSP}%`;
  const hint = title ?? (r === 0 ? 'Расчёт совпал со счётом цеха' : `Наш расчёт ${r > 0 ? 'выше' : 'ниже'} счёта цеха на ${Math.abs(r)}${NBSP}%`);
  return (
    <span className={cn('inline-flex h-5 items-center rounded-md px-1.5 text-xs font-medium whitespace-nowrap tabular-nums', tone, className)} title={hint}>
      {text}
      <span className="sr-only">: {hint}</span>
    </span>
  );
}

/** «ООО "ЛАЗЕРНАЯ РЕЗКА СПБ"» → «ЛАЗЕРНАЯ РЕЗКА СПБ» */
export function supplierName(s: string | null | undefined): string {
  return (s ?? '')
    .replace(/^(ООО|ОАО|ЗАО|ПАО|АО|ИП)\s+/i, '')
    .replace(/^["«]|["»]$/g, '')
    .replace(/[«»"]/g, '')
    .trim();
}

/** «№ 9885 от 05.10.2026» */
export function invoiceTitle(inv: { number: string; date: string | null }): string {
  return `№${NBSP}${inv.number || 'б/н'}${inv.date ? ` от ${dateDay(inv.date)}` : ''}`;
}
