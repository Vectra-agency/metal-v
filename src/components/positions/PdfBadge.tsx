// Значок «PDF» / «DXF + PDF» со сверкой массы по чертежу: «✓ масса» или «⚠ масса +12,4 %».
import type { ReactElement } from 'react';
import { kg, n1, NBSP } from '@/format.ts';
import { cn } from '@/lib/utils.ts';
import type { OrderPosition } from '@/order.ts';
import { pdfCheck } from '@/pdfImport.ts';

/** Отклонение массы: +12,4 % / −8 % (знак минус U+2212) */
export const massPct = (ratio: number) => `${ratio >= 1 ? '+' : '−'}${n1(Math.abs(ratio - 1) * 100)}${NBSP}%`;

const BASE = 'inline-flex h-4 shrink-0 items-center gap-0.5 rounded-sm border px-1 text-[11px] leading-none font-medium whitespace-nowrap';

export function PdfBadge({ p, className }: { p: OrderPosition; className?: string }): ReactElement | null {
  if (!p.pdf) return null;
  const c = pdfCheck(p);
  const label = !p.pdf.geometryFromPdf && p.source === 'dxf' ? 'DXF + PDF' : 'PDF';
  if (!c || c.status === 'unknown') {
    return (
      <span className={cn(BASE, 'border-border text-muted-foreground', className)} title="Распознано по PDF; массы на чертеже нет">
        {label}
      </span>
    );
  }
  const title = `Масса по контуру ${kg(c.calc)}, по чертежу ${c.drawing ? kg(c.drawing) : '—'}`;
  if (c.status === 'ok') {
    return (
      <span className={cn(BASE, 'border-ok/40 text-ok', className)} title={title}>
        {label} ✓ масса
      </span>
    );
  }
  return (
    <span className={cn(BASE, c.status === 'bad' ? 'border-danger/50 bg-danger-soft text-danger' : 'border-warn/50 bg-warn-soft text-warn', className)} title={title}>
      {label} ⚠ масса {c.ratio ? massPct(c.ratio) : ''}
    </span>
  );
}
