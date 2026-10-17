// Статус — всегда значок + слово или число, не только цвет; для диктора — слово статуса.
import type { ReactElement } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils.ts';
import { CircleCheck, CircleHelp, Info, OctagonAlert, Sparkles, TriangleAlert } from './icons.ts';

export type StatusKind = 'problem' | 'check' | 'ok' | 'info' | 'guessed' | 'ai';

export interface StatusIconProps {
  kind: StatusKind;
  label?: string; // видимое слово
  count?: number; // видимое число
  className?: string; // размер значка — от размера шрифта (1.1em) или [&>svg]:size-3
}

export const STATUS: Record<StatusKind, { icon: LucideIcon; tone: string; word: string }> = {
  problem: { icon: OctagonAlert, tone: 'text-danger', word: 'ошибка' },
  check: { icon: TriangleAlert, tone: 'text-warn', word: 'проверить' },
  ok: { icon: CircleCheck, tone: 'text-ok', word: 'в порядке' },
  info: { icon: Info, tone: 'text-muted-foreground', word: 'для сведения' },
  guessed: { icon: CircleHelp, tone: 'text-guessed', word: 'не найдено в файле' },
  ai: { icon: Sparkles, tone: 'text-ai', word: 'ИИ' },
};

export function StatusIcon({ kind, label, count, className }: StatusIconProps): ReactElement {
  const { icon: Icon, tone, word } = STATUS[kind];
  const visible = count != null || !!label;
  return (
    <span className={cn('inline-flex items-center gap-1', tone, className)}>
      <Icon aria-hidden className="size-[1.1em] shrink-0" />
      <span className="sr-only">{visible ? `${word}: ` : word}</span>
      {count != null && <span className="tabular-nums">{count}</span>}
      {label && <span>{label}</span>}
    </span>
  );
}
