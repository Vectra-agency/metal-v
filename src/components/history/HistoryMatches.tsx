// Деталь в прошлых заказах: значок ↺ в строке позиции (та же деталь — цена по счёту цеха) и раздел
// «В прошлых заказах» в карточке позиции (та же деталь и похожие, с фактом по счёту и нашим расчётом).
import type { ReactElement } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx';
import { Money } from '@/components/common/Money.tsx';
import { bestSame, type HistoryMatch } from '@/core/history.ts';
import { getMaterial } from '@/core/materials.ts';
import { dateDay, n0, NBSP, rub0, thick } from '@/format.ts';
import { openPosition } from '@/store/actions.ts';
import { useStore } from '@/store/store.ts';
import { DiffBadge, invoiceTitle, supplierName } from './shared.tsx';

const EMPTY: HistoryMatch[] = [];

function whereText(m: HistoryMatch): string {
  if (m.invoiceNumber != null) return `счёт ${invoiceTitle({ number: m.invoiceNumber, date: m.date })}${m.supplier ? ` · ${supplierName(m.supplier)}` : ''}`;
  return `заказ ${m.orderTitle ? `«${m.orderTitle}» ` : ''}от ${dateDay(m.date)}, счёта цеха нет`;
}

/** Значок в строке позиции: та же деталь уже была в прошлых заказах */
export function HistoryBadge({ id }: { id: string }): ReactElement | null {
  const m = useStore((s) => bestSame(s.history.matches[id]));
  if (!m) return null;
  const text = m.fact != null ? `${m.factShared ? `≈${NBSP}` : ''}${rub0(m.fact)}` : 'было';
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => openPosition(id, { focus: 'history' })}
          className="inline-flex h-4 shrink-0 items-center gap-0.5 rounded bg-muted px-1 text-[11px] whitespace-nowrap text-muted-foreground tabular-nums hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          aria-label={m.fact != null ? `В прошлом заказе цех взял ${rub0(m.fact)} за штуку — подробнее` : 'Деталь уже была в прошлом заказе — подробнее'}
        >
          ↺{NBSP}
          {text}
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-80">
        Та же деталь — {whereText(m)}:{' '}
        {m.fact != null ? `цех взял ${rub0(m.fact)}/шт${m.factShared ? ' (доля строки счёта на группу деталей)' : ''}` : 'факта нет'}
        {m.calc != null ? `, наш расчёт тогда ${rub0(m.calc)}/шт` : ''}, {n0(m.qty)}
        {NBSP}шт. Подробнее — в карточке позиции.
      </TooltipContent>
    </Tooltip>
  );
}

/** То же без кнопки и подсказки — внутри карточки-кнопки на телефоне (подробности — в карточке позиции) */
export function HistoryMark({ id }: { id: string }): ReactElement | null {
  const m = useStore((s) => bestSame(s.history.matches[id]));
  if (!m) return null;
  return (
    <span className="rounded-sm bg-muted px-1 text-[11px] whitespace-nowrap tabular-nums">
      ↺{NBSP}
      {m.fact != null ? `${m.factShared ? `≈${NBSP}` : ''}${rub0(m.fact)}` : 'было'}
      <span className="sr-only">{m.fact != null ? ' — цена в прошлом заказе' : ' — деталь была в прошлом заказе'}</span>
    </span>
  );
}

/** Раздел карточки позиции; piece — себестоимость 1 шт по текущему расчёту; материал и толщина — текущие (раньше были другие — подсветка) */
export function HistorySection({ id, piece, materialId, thickness }: { id: string; piece: number | null; materialId: string; thickness: number }): ReactElement | null {
  const ms = useStore((s) => s.history.matches[id] ?? EMPTY);
  if (!ms.length) return null;
  return (
    <section aria-labelledby="hist-h" className="space-y-2">
      <h3 id="hist-h" className="text-sm font-semibold">
        В прошлых заказах
      </h3>
      <ul className="divide-y rounded-lg border text-sm">
        {ms.map((m) => (
          <li key={`${m.orderId}|${m.name}|${m.qty}`} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="font-medium">
                {m.kind === 'same' ? 'Та же деталь' : `Похожая: ${m.name}`}
                <span className="font-normal text-muted-foreground">
                  {' '}
                  ·{' '}
                  {m.kind === 'same' && (m.materialId !== materialId || Math.abs(m.thickness - thickness) > 1e-6) ? (
                    <span className="text-warn" title={`Сейчас в расчёте ${getMaterial(materialId).short} ${thick(thickness)}`}>
                      {getMaterial(m.materialId).short} {thick(m.thickness)} (сейчас {getMaterial(materialId).short} {thick(thickness)})
                    </span>
                  ) : (
                    <>
                      {getMaterial(m.materialId).short} {thick(m.thickness)}
                    </>
                  )}{' '}
                  · {n0(m.qty)}
                  {NBSP}шт
                  {m.kind === 'similar' ? ` · ${n0(m.width)}×${n0(m.height)}${NBSP}мм · гибов ${m.bends}` : ''}
                </span>
              </div>
              <div className="text-xs text-muted-foreground">{whereText(m)}</div>
            </div>
            <div className="flex flex-col items-end gap-0.5 text-right">
              {m.fact != null ? (
                <span className="flex items-center gap-1.5">
                  <span className="text-xs text-muted-foreground">по счёту</span>
                  <Money value={m.fact} approx={m.factShared} className="font-medium" />
                  {m.kind === 'same' && piece != null && (
                    <DiffBadge
                      calc={piece}
                      fact={m.fact}
                      title={`Сейчас по расчёту ${rub0(piece)}/шт — ${piece >= m.fact ? 'выше' : 'ниже'} прошлого счёта на ${Math.abs(Math.round(((piece - m.fact) / m.fact) * 100))}${NBSP}%`}
                    />
                  )}
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">счёта цеха нет</span>
              )}
              {m.calc != null && <span className="text-xs text-muted-foreground">наш расчёт тогда {rub0(m.calc)}</span>}
            </div>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        Цены за 1 шт с НДС. «≈» — строка счёта на несколько деталей («набор пластин»): доля детали — по нашему расчёту. Похожие — тот же материал и толщина,
        габарит и рез в пределах 30 %.
      </p>
    </section>
  );
}
