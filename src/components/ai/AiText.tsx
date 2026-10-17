// Текст ИИ: обозначения деталей — ссылки на позиции, служебные id заменены названиями, после каждой цитаты «…» —
// отметка: ✓ найдено в тексте чертежа/заявке/документе, ? — цитаты нет в текстах (могла быть прочитана с изображения).
import { useMemo, type ReactElement, type ReactNode } from 'react';
import type { Evidence } from '@/attention.ts';
import { checkQuote, evidenceHint, evidenceSources, normalize, quoteSpans, type EvidenceSources } from '@/evidence.ts';
import type { OrderPosition } from '@/order.ts';
import { desigKey } from '@/pdfImport.ts';
import { cn } from '@/lib/utils.ts';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx';
import { CircleCheck, CircleHelp } from '@/components/common/icons.ts';
import { openPosition } from '@/store/actions.ts';
import { useStore } from '@/store/store.ts';

export interface AiTextProps {
  text: string;
  positionId?: string; // чья это запись: своё обозначение — без ссылки, свой чертёж — первым при поиске цитат
  evidence?: boolean; // отметки у цитат
  className?: string;
  plainMarks?: boolean; // отметки без всплывающих подсказок (внутри подсказки или кнопки)
  as?: 'span' | 'p' | 'div';
}

/** Тексты для сверки цитат: то, что ушло модели (в памяти), иначе — из заказа */
export function useEvidenceSources(): EvidenceSources {
  const order = useStore((s) => s.order);
  const ctx = useStore((s) => s.ai.lastContext);
  return evidenceSources(order, ctx);
}

/** Отметка цитаты: ✓ найдено (где) / ? нет в текстах */
export function EvidenceMark({ e, plain }: { e: Evidence; plain?: boolean }): ReactElement {
  const hint = evidenceHint(e);
  const icon = e.found ? <CircleCheck aria-hidden className="size-3 text-ok" /> : <CircleHelp aria-hidden className="size-3 text-warn" />;
  if (plain) {
    return (
      <span className="mx-0.5 inline-flex align-[-1px]">
        {icon}
        <span className="sr-only">{hint}</span>
      </span>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} role="img" aria-label={hint} className="focus-ring mx-0.5 inline-flex cursor-help rounded-full align-[-1px]">
          {icon}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">{hint}</TooltipContent>
    </Tooltip>
  );
}

// обозначение детали (как findDesignation в pdfAnalyze, но все вхождения)
const DESIG = /[A-Za-zА-Яа-яЁё]{1,10}[.-]?[\dA-Za-zА-Яа-я]*\d[\dA-Za-zА-Яа-я]*(?:[.-][\dA-Za-zА-Яа-я]+)+/g;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface Index {
  ids: RegExp | null;
  names: Map<string, string>; // id → название
  byDesig: Map<string, string>; // ключ обозначения → id
}

let lastIndex: { positions: OrderPosition[]; v: Index } | null = null;

function indexOf(positions: OrderPosition[]): Index {
  if (lastIndex?.positions === positions) return lastIndex.v;
  const names = new Map(positions.map((p) => [p.id, p.name || p.fileName || p.id]));
  const byDesig = new Map<string, string>();
  for (const p of positions) {
    const k = desigKey(p.name);
    if (k && !byDesig.has(k)) byDesig.set(k, p.id);
  }
  const ids = positions.length ? new RegExp(`\\b(?:${positions.map((p) => escapeRe(p.id)).join('|')})\\b`, 'g') : null;
  const v = { ids, names, byDesig };
  lastIndex = { positions, v };
  return v;
}

/** Разметка текста: ссылки на позиции и отметки цитат */
export function renderAiText(
  text: string,
  o: { positions: OrderPosition[]; positionId?: string; src?: EvidenceSources | null; plainMarks?: boolean },
): ReactNode[] {
  const ix = indexOf(o.positions);
  const t = ix.ids ? text.replace(ix.ids, (id) => ix.names.get(id) ?? id) : text;
  // отметки — сразу после закрывающей »
  const marks = new Map<number, Evidence>();
  if (o.src) for (const q of quoteSpans(t)) if (normalize(q.inner).length >= 4) marks.set(q.end, checkQuote(q.inner, o.src, o.positionId));
  // ссылки на другие позиции
  const links: { start: number; end: number; id: string }[] = [];
  for (const m of t.matchAll(DESIG)) {
    const id = ix.byDesig.get(desigKey(m[0]));
    if (id && id !== o.positionId) links.push({ start: m.index, end: m.index + m[0].length, id });
  }
  const bounds = [...new Set([0, t.length, ...marks.keys(), ...links.flatMap((l) => [l.start, l.end])])].sort((a, b) => a - b);
  const nodes: ReactNode[] = [];
  for (let k = 0; k < bounds.length; k++) {
    const at = bounds[k];
    const e = marks.get(at);
    if (e) nodes.push(<EvidenceMark key={`m${at}`} e={e} plain={o.plainMarks} />);
    const next = bounds[k + 1];
    if (next === undefined) break;
    const link = links.find((l) => l.start === at);
    if (link) {
      const name = ix.names.get(link.id) ?? '';
      nodes.push(
        <button
          key={`l${at}`}
          type="button"
          onClick={(ev) => {
            ev.stopPropagation();
            openPosition(link.id, { reveal: true });
          }}
          title={`Открыть позицию ${name}`}
          className="focus-ring rounded-sm font-medium text-foreground underline decoration-foreground/30 decoration-dotted underline-offset-2 hover:decoration-solid"
        >
          {t.slice(link.start, link.end)}
        </button>,
      );
    } else nodes.push(t.slice(at, next));
  }
  return nodes;
}

export function AiText({ text, positionId, evidence, className, plainMarks, as = 'span' }: AiTextProps): ReactElement {
  const positions = useStore((s) => s.order.positions);
  const src = useEvidenceSources();
  const nodes = useMemo(
    () => renderAiText(text, { positions, positionId, src: evidence ? src : null, plainMarks }),
    [text, positions, positionId, evidence, src, plainMarks],
  );
  const Tag = as;
  return <Tag className={cn('whitespace-pre-line', className)}>{nodes}</Tag>;
}
