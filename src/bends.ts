// Откуда у позиции число гибов и какие линии гиба найдены — с причинами: для карточки позиции («Гибы»)
// и для ИИ (src/ai/context.ts). Линии DXF — в координатах DXF (эскиз позиции), линии PDF — на виде чертежа (мм листа).
import type { OrderPosition, Preview } from './order.ts';

export interface BendLine {
  pts: number[]; // плоский массив x0,y0,x1,y1… в координатах эскиза
  len: number; // мм детали (0 — неизвестно)
  why: string;
}

export interface BendSource {
  kind: 'dxf' | 'pdf' | 'twin' | 'none';
  text: string; // «8 линий гиба на чертеже PDF (стр. 1, М 1:10)»
  preview: Preview | null; // контур с линиями для показа
  lines: BendLine[]; // засчитанные гибом (по порядку — номера на эскизе)
  rejected: BendLine[]; // не засчитанные — с причиной
  twin?: string; // обозначение исполнения, с которого взяты гибы
}

const plen = (a: number[]) => {
  let l = 0;
  for (let i = 2; i + 1 < a.length; i += 2) l += Math.hypot(a[i] - a[i - 2], a[i + 1] - a[i - 1]);
  return l;
};

const linesText = (n: number) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'линия' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'линии' : 'линий'} гиба`;

/** Эскиз вида PDF (мм листа) с линиями гиба */
function pdfPreview(p: OrderPosition): Preview | null {
  const b = p.pdf?.meta.base;
  if (!b?.outer.length) return null;
  return {
    outer: [b.outer],
    holes: b.holes,
    bends: b.bends,
    ignored: [],
    bbox: [b.bbox.minX, b.bbox.minY, b.bbox.maxX, b.bbox.maxY],
    ...(b.bendWhy ? { bendWhy: b.bendWhy } : {}),
    ...(b.notBends ? { notBends: b.notBends } : {}),
  };
}

function fromPdf(p: OrderPosition): Omit<BendSource, 'kind' | 'text'> | null {
  const meta = p.pdf?.meta;
  const pv = pdfPreview(p);
  if (!meta || !pv) return null;
  const real = p.bendLengths && p.bendLengths.length === pv.bends.length ? p.bendLengths : null;
  return {
    preview: pv,
    lines: pv.bends.map((a, i) => ({ pts: a, len: real?.[i] ?? plen(a) * meta.scale, why: pv.bendWhy?.[i] ?? 'линия сгиба на чертеже' })),
    rejected: (pv.notBends ?? []).map((r) => ({ pts: r.pts, len: plen(r.pts) * meta.scale, why: r.why })),
  };
}

function fromDxf(p: OrderPosition): Omit<BendSource, 'kind' | 'text'> | null {
  const pv = p.preview;
  if (!pv) return null;
  const real = p.bendLengths && p.bendLengths.length === pv.bends.length ? p.bendLengths : null;
  return {
    preview: pv,
    lines: pv.bends.map((a, i) => ({ pts: a, len: real?.[i] ?? plen(a), why: pv.bendWhy?.[i] ?? 'прямая внутри детали' })),
    rejected: (pv.notBends ?? []).map((r) => ({ pts: r.pts, len: plen(r.pts), why: r.why })),
  };
}

/**
 * Откуда гибы позиции. all — позиции заказа: для гибов «с исполнения …» показать линии того исполнения.
 * null — у позиции нет ни линий гиба, ни отвергнутых линий (показывать нечего).
 */
export function bendSource(p: OrderPosition, all?: OrderPosition[]): BendSource | null {
  const from = p.bendsFrom ?? (p.source === 'dxf' && p.preview?.bends.length ? 'dxf' : p.pdf?.meta.base.bends.length ? 'pdf' : undefined);
  if (from === 'twin') {
    const twin = all?.find((q) => q.id !== p.id && q.name === p.bendsNote);
    const src = twin ? bendSource({ ...twin, bendsFrom: twin.bendsFrom === 'twin' ? undefined : twin.bendsFrom }) : null;
    return {
      kind: 'twin',
      text: `с исполнения ${p.bendsNote ?? 'того же чертежа'} — на виде этой детали линий гиба нет`,
      preview: src?.preview ?? null,
      lines: src?.lines ?? [],
      rejected: src?.rejected ?? [],
      twin: p.bendsNote,
    };
  }
  if (from === 'pdf') {
    const r = fromPdf(p);
    if (r) {
      const meta = p.pdf!.meta;
      const where = `стр. ${meta.page + 1}, М ${meta.scale >= 1 ? `1:${meta.scale}` : `${1 / meta.scale}:1`}`;
      return { kind: 'pdf', text: `${linesText(r.lines.length)} на чертеже PDF (${where})${p.bendsNote ? `, ${p.bendsNote}` : ''}`, ...r };
    }
  }
  if (from === 'dxf') {
    const r = fromDxf(p);
    if (r) return { kind: 'dxf', text: `${linesText(r.lines.length)} в DXF`, ...r };
  }
  // линий нет: может быть, есть отвергнутые — показать, почему они не гибы
  const r = (p.source === 'dxf' ? fromDxf(p) : null) ?? fromPdf(p);
  if (r?.rejected.length) return { kind: 'none', text: 'Линий гиба не найдено', ...r, lines: [] };
  return null;
}
