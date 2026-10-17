// Подпись «откуда значение» у поля карточки: имя файла, штамп PDF, заявка, ИИ, вручную, по умолчанию.
import type { ReactElement } from 'react';
import { cn } from '@/lib/utils.ts';
import { ORIGIN_LABEL, type Origin } from '@/provenance.ts';

export function ProvenanceTag({ origin, className }: { origin: Origin; className?: string }): ReactElement {
  return (
    <span
      title={`Откуда значение: ${ORIGIN_LABEL[origin]}`}
      className={cn(
        'text-xs whitespace-nowrap',
        origin === 'ai' ? 'text-ai' : origin === 'default' ? 'text-guessed' : 'text-muted-foreground',
        className,
      )}
    >
      {ORIGIN_LABEL[origin]}
    </span>
  );
}
