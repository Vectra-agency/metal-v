// «Гибы» в карточке позиции: сколько в расчёте и откуда (линии DXF, чертёж PDF, исполнение того же чертежа, вручную,
// ИИ), эскиз с каждым гибом своим цветом и номером, почему каждая линия — гиб, какие линии гибом не засчитаны и почему,
// и разбор гибов ИИ (сколько гибов он видит и на чём это основано) — даже если с расчётом совпадает.
import { useMemo, type ReactElement } from 'react';
import type { AiChange } from '@/ai/apply.ts';
import { bendSource } from '@/bends.ts';
import { Badge } from '@/components/ui/badge.tsx';
import { AiText } from '@/components/ai/AiText.tsx';
import { Sparkles } from '@/components/common/icons.ts';
import { bendColor, PartPreview } from '@/components/common/PartPreview.tsx';
import { n0, NBSP, plural } from '@/format.ts';
import type { OrderPosition } from '@/order.ts';
import { useStore } from '@/store/store.ts';

const bendsWord = (n: number) => `${n}${NBSP}${plural(n, 'гиб', 'гиба', 'гибов')}`;

export function BendsSection({ base, pos, changes }: { base: OrderPosition; pos: OrderPosition; changes: AiChange[] }): ReactElement | null {
  const all = useStore((s) => s.order.positions);
  const review = useStore((s) => s.order.ai?.analysis.bends?.find((b) => b.id === base.id));
  const src = useMemo(() => bendSource(base, all), [base, all]);
  const count = pos.bends;
  if (!src && !review && count === 0) return null;

  const found = src && src.kind !== 'none' ? src.lines.length : 0;
  const byAi = changes.some((c) => c.field === 'bends');
  const manual = !byAi && base.bends !== found;
  const origin = byAi
    ? `по предложению ИИ (в файлах — ${found ? bendsWord(found) : 'линий гиба нет'})`
    : manual
      ? found
        ? `вручную: в файлах ${bendsWord(found)}`
        : 'вручную — в файлах линий гиба нет'
      : (src?.text ?? 'линий гиба не найдено');

  return (
    <section aria-labelledby="bends-h" data-sheet-focus="bendlines" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 id="bends-h" className="text-sm font-semibold">
          Гибы
        </h3>
        <span className="text-sm">
          в расчёте <b className="font-semibold tabular-nums">{count}</b>
        </span>
      </div>
      <p className="text-sm text-muted-foreground">Откуда: {origin}</p>
      {src?.kind === 'twin' && manual === false && src.lines.length > 0 && (
        <p className="text-xs text-muted-foreground">Ниже — вид исполнения {src.twin}: линии гиба взяты с него.</p>
      )}

      {src?.preview && (src.lines.length > 0 || src.rejected.length > 0) && (
        <figure className="space-y-1.5">
          <PartPreview preview={src.preview} size="large" numbered notBends />
          <figcaption className="text-xs text-muted-foreground">
            {src.kind === 'dxf' ? 'Контур из DXF' : 'Вид на чертеже PDF'}: гибы — цветом с номером, серым с «×» — линии, которые гибом не засчитаны.
          </figcaption>
        </figure>
      )}

      {src && src.lines.length > 1 && src.lines.every((l) => l.why === src.lines[0].why) ? (
        <div className="space-y-1.5 text-sm">
          <ol className="flex flex-wrap gap-x-3 gap-y-1" aria-label="Линии гиба">
            {src.lines.map((l, i) => (
              <li key={i} className="flex items-center gap-1.5 tabular-nums">
                <span aria-hidden className="grid size-5 place-items-center rounded-full text-[11px] font-semibold text-white" style={{ background: bendColor(i) }}>
                  {i + 1}
                </span>
                <span className="sr-only">Гиб {i + 1}: </span>
                {l.len > 0 ? `${n0(l.len)}${NBSP}мм` : '—'}
              </li>
            ))}
          </ol>
          <p className="text-muted-foreground">Все {src.lines.length}: {src.lines[0].why}</p>
        </div>
      ) : src && src.lines.length > 0 && (
        <ol className="space-y-1.5 text-sm" aria-label="Линии гиба">
          {src.lines.map((l, i) => (
            <li key={i} className="flex items-start gap-2">
              <span
                aria-hidden
                className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold text-white"
                style={{ background: bendColor(i) }}
              >
                {i + 1}
              </span>
              <span>
                {l.len > 0 && (
                  <span className="font-medium tabular-nums">
                    {n0(l.len)}
                    {NBSP}мм —{' '}
                  </span>
                )}
                <span className="text-muted-foreground">{l.why}</span>
              </span>
            </li>
          ))}
        </ol>
      )}

      {src && src.rejected.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Не засчитаны гибом</p>
          <ul className="space-y-1 text-sm" aria-label="Линии, не засчитанные гибом">
            {src.rejected.map((l, i) => (
              <li key={i} className="flex items-start gap-2 text-muted-foreground">
                <span aria-hidden className="mt-0.5 w-5 shrink-0 text-center">
                  ×
                </span>
                <span>
                  {l.len > 0 && (
                    <span className="tabular-nums">
                      {n0(l.len)}
                      {NBSP}мм —{' '}
                    </span>
                  )}
                  {l.why}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {review && (
        <div className="space-y-1 rounded-md bg-ai-soft p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Sparkles aria-hidden className="size-4 text-ai" />
            <span className="font-medium">ИИ: {review.count == null ? 'число гибов по чертежу не определить' : bendsWord(review.count)}</span>
            {review.count != null &&
              (review.count === count ? (
                <Badge variant="outline" className="border-ok/50 text-ok">
                  совпадает с расчётом
                </Badge>
              ) : (
                <Badge variant="outline" className="border-warn/50 text-warn">
                  в расчёте {count}
                </Badge>
              ))}
          </div>
          <AiText as="p" text={review.reasoning} positionId={base.id} evidence className="text-foreground/90" />
        </div>
      )}
    </section>
  );
}
