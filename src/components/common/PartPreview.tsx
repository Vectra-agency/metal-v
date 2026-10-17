// Эскиз детали: контур, отверстия, линии гиба; отброшенное (рамки, обрывки) — серым пунктиром.
import type { ReactElement } from 'react';
import { cn } from '@/lib/utils.ts';
import type { Preview } from '@/order.ts';

const path = (a: number[], closed: boolean) => {
  if (a.length < 4) return '';
  let d = `M${a[0]} ${a[1]}`;
  for (let i = 2; i < a.length; i += 2) d += `L${a[i]} ${a[i + 1]}`;
  return closed ? d + 'Z' : d;
};

export interface PartPreviewProps {
  preview?: Preview;
  size?: 'thumb' | 'large'; // thumb — 40×32 в таблице; large — на всю ширину, h-64
  showIgnored?: boolean;
  dims?: { w: number; h: number }; // подписи габарита (только large)
  className?: string;
}

export function PartPreview({ preview, size = 'thumb', showIgnored = false, dims, className }: PartPreviewProps): ReactElement {
  const thumb = size === 'thumb';
  if (!preview || !preview.outer.length) {
    return (
      <div
        className={cn(
          'grid shrink-0 place-items-center rounded-md border border-dashed text-center text-muted-foreground',
          thumb ? 'h-8 w-10 text-[9px] leading-tight' : 'h-64 w-full text-xs',
          className,
        )}
      >
        нет контура
      </div>
    );
  }
  let [x0, y0, x1, y1] = preview.bbox;
  if (showIgnored && preview.ignored.length) {
    for (const a of preview.ignored)
      for (let i = 0; i < a.length; i += 2) {
        x0 = Math.min(x0, a[i]);
        x1 = Math.max(x1, a[i]);
        y0 = Math.min(y0, a[i + 1]);
        y1 = Math.max(y1, a[i + 1]);
      }
  }
  const w = Math.max(x1 - x0, 1);
  const h = Math.max(y1 - y0, 1);
  const pad = Math.max(w, h) * (thumb ? 0.04 : 0.07);
  const fs = Math.max(w, h) * 0.035;
  // DXF: ось Y вверх — переворачиваем
  const vb = `${x0 - pad} ${-y1 - pad} ${w + 2 * pad} ${h + 2 * pad}`;
  const outerD = preview.outer.map((a) => path(a, true)).join('') + preview.holes.map((a) => path(a, true)).join('');
  return (
    <svg
      className={cn('block shrink-0', thumb ? 'h-8 w-10' : 'h-64 w-full rounded-md bg-muted', className)}
      viewBox={vb}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Эскиз детали"
    >
      <g transform="scale(1,-1)">
        {showIgnored &&
          preview.ignored.map((a, i) => (
            <path
              key={'i' + i}
              d={path(a, false)}
              className="fill-none stroke-muted-foreground"
              strokeWidth={0.8}
              strokeDasharray="3 3"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        <path d={outerD} className="fill-metal/15 stroke-metal" strokeWidth={thumb ? 1 : 1.3} fillRule="evenodd" vectorEffect="non-scaling-stroke" />
        {preview.bends.map((a, i) => (
          <path key={'b' + i} d={path(a, false)} className="fill-none stroke-bend" strokeWidth={1.6} strokeDasharray="6 4" vectorEffect="non-scaling-stroke" />
        ))}
      </g>
      {!thumb && dims && (
        <>
          <text x={x0 + w / 2} y={-y0 + pad * 0.85} className="fill-muted-foreground" textAnchor="middle" style={{ fontSize: fs }}>
            {Math.round(dims.w)} мм
          </text>
          <text
            x={x1 + pad * 0.6}
            y={-y0 - h / 2}
            className="fill-muted-foreground"
            textAnchor="middle"
            style={{ fontSize: fs }}
            transform={`rotate(-90 ${x1 + pad * 0.6} ${-y0 - h / 2})`}
          >
            {Math.round(dims.h)} мм
          </text>
        </>
      )}
    </svg>
  );
}
