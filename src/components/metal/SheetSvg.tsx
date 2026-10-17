// Лист раскроя (перенесено из SheetsSection): лист, занятая часть, детали по габаритам. Деталь — с клавиатуры
// (Tab, Enter): наведение и фокус подсвечивают её и строку списка «Позиции группы», щелчок открывает карточку.
import { memo, type KeyboardEvent, type ReactElement } from 'react';
import { cn } from '@/lib/utils.ts';
import type { Sheet } from '@/core/nesting.ts';
import { n0 } from '@/format.ts';
import { openPosition, setHighlight } from '@/store/actions.ts';

export interface SheetSvgProps {
  sheet: Sheet;
  index: number; // 0-based
  w: number; // длинная сторона листа, мм
  h: number;
  showUsed: boolean; // последний лист при списании «по раскрою»: занятая часть
  names: Map<string, string>; // id позиции → обозначение
  highlight: string | null;
  truncated: boolean; // раскладка по выборке — «*» в подписи
}

function onPartKey(e: KeyboardEvent<SVGRectElement>, id: string) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  openPosition(id);
}

export const SheetSvg = memo(function SheetSvg({ sheet, index, w, h, showUsed, names, highlight, truncated }: SheetSvgProps): ReactElement {
  return (
    <figure className="flex min-w-0 flex-col gap-1">
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid meet" role="group" aria-label={`Лист ${index + 1}`} className="h-auto w-full overflow-visible">
        <rect x={0} y={0} width={w} height={h} className="fill-muted stroke-border" vectorEffect="non-scaling-stroke" strokeWidth={1} />
        {showUsed && <rect x={0} y={0} width={sheet.usedLength} height={sheet.usedWidth} className="fill-secondary" />}
        {sheet.placed.map((pl, k) => {
          const on = highlight === pl.key;
          const name = names.get(pl.key) ?? pl.key;
          return (
            <rect
              key={k}
              x={pl.x}
              y={pl.y}
              width={pl.w}
              height={pl.h}
              tabIndex={0}
              role="button"
              aria-label={`${name} — ${n0(pl.w)}×${n0(pl.h)} мм`}
              data-part={pl.key}
              vectorEffect="non-scaling-stroke"
              strokeWidth={on ? 2 : 1}
              className={cn(
                'cursor-pointer outline-none',
                on ? 'fill-cut/25 stroke-cut' : 'fill-metal/15 stroke-metal',
                'focus-visible:fill-cut/25 focus-visible:stroke-ring focus-visible:[stroke-width:3]',
              )}
              onMouseEnter={() => setHighlight(pl.key)}
              onMouseLeave={() => setHighlight(null)}
              onFocus={() => setHighlight(pl.key)}
              onBlur={() => setHighlight(null)}
              onClick={() => openPosition(pl.key)}
              onKeyDown={(e) => onPartKey(e, pl.key)}
            >
              <title>
                {name} — {n0(pl.w)}×{n0(pl.h)} мм
              </title>
            </rect>
          );
        })}
      </svg>
      <figcaption className="text-xs text-muted-foreground tabular-nums">
        Лист {index + 1}
        {truncated ? '*' : ''} · {sheet.placed.length} шт
      </figcaption>
    </figure>
  );
});
