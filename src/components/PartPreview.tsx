import type { Preview } from '../order.ts';

const path = (a: number[], closed: boolean) => {
  if (a.length < 4) return '';
  let d = `M${a[0]} ${a[1]}`;
  for (let i = 2; i < a.length; i += 2) d += `L${a[i]} ${a[i + 1]}`;
  return closed ? d + 'Z' : d;
};

interface Props {
  preview?: Preview;
  size?: 'thumb' | 'large';
  showIgnored?: boolean;
  dims?: { w: number; h: number };
}

/** Эскиз детали: контур, отверстия, линии гиба; отброшенное — серым пунктиром */
export function PartPreview({ preview, size = 'thumb', showIgnored = false, dims }: Props) {
  if (!preview || !preview.outer.length) return <div className={`preview preview-${size} preview-empty`}>нет контура</div>;
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
  const pad = Math.max(w, h) * (size === 'large' ? 0.07 : 0.04);
  const fs = Math.max(w, h) * 0.035;
  // DXF: ось Y вверх — переворачиваем
  const vb = `${x0 - pad} ${-y1 - pad} ${w + 2 * pad} ${h + 2 * pad}`;
  const outerD = preview.outer.map((a) => path(a, true)).join('') + preview.holes.map((a) => path(a, true)).join('');
  return (
    <svg className={`preview preview-${size}`} viewBox={vb} preserveAspectRatio="xMidYMid meet" role="img" aria-label="Эскиз детали">
      <g transform="scale(1,-1)">
        {showIgnored &&
          preview.ignored.map((a, i) => <path key={'i' + i} d={path(a, false)} className="pv-ignored" vectorEffect="non-scaling-stroke" />)}
        <path d={outerD} className="pv-part" fillRule="evenodd" vectorEffect="non-scaling-stroke" />
        {preview.bends.map((a, i) => (
          <path key={'b' + i} d={path(a, false)} className="pv-bend" vectorEffect="non-scaling-stroke" />
        ))}
      </g>
      {size === 'large' && dims && (
        <>
          <text x={x0 + w / 2} y={-y0 + pad * 0.85} className="pv-dim" textAnchor="middle" style={{ fontSize: fs }}>
            {Math.round(dims.w)} мм
          </text>
          <text x={x1 + pad * 0.6} y={-y0 - h / 2} className="pv-dim" textAnchor="middle" style={{ fontSize: fs }} transform={`rotate(-90 ${x1 + pad * 0.6} ${-y0 - h / 2})`}>
            {Math.round(dims.h)} мм
          </text>
        </>
      )}
    </svg>
  );
}
