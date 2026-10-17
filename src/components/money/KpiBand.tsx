// Итог заказа формулой: Себестоимость + Наценка = Цена клиенту │ Выручка (ui-spec §2.6).
// «Цена клиенту» — quote.total: ровно эта сумма в КП, тексте для письма, таблице и CSV. Внизу — доли затрат и объёмы.
// Все три суммы — одним форматом (clientMoney: «коп.» — с копейками, иначе целые рубли): Цена − Себестоимость = Выручка и на экране.
// Когда блок уходит вверх, его заменяет полоса MoneyStrip; на телефоне внизу — кнопка «Скопировать для клиента».
import { useState, type ReactElement, type ReactNode } from 'react';
import { Badge } from '@/components/ui/badge.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx';
import { CATS, CatDot, CostBar, type CatKey } from '@/components/common/CostBar.tsx';
import { NumInput } from '@/components/common/NumInput.tsx';
import { Info, TriangleAlert } from '@/components/common/icons.ts';
import { cn } from '@/lib/utils.ts';
import { kg, n0, n1, NBSP, pct1, plural, rub0, rub2, signedRub } from '@/format.ts';
import { clientMoney, ROUNDING_HINT } from '@/quote.ts';
import { setDelivery, setFilter, setTab } from '@/store/actions.ts';
import { useDerived } from '@/store/derived.tsx';
import { useStore } from '@/store/store.ts';
import { marginLine, MarkupControl } from './MarkupControl.tsx';
import { MobileCopyBar } from './MobileCopyBar.tsx';
import { MoneyStrip, useStripWatch } from './MoneyStrip.tsx';
import { ScenariosPopover } from './ScenariosPopover.tsx';

/** Подсказка «что это за число»: наведение, фокус или нажатие (на планшете наведения нет; закрывается касанием вне) */
function InfoTip({ label, children }: { label: string; children: ReactNode }): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`Пояснение: ${label}`}
          onClick={() => setOpen(true)}
          className="inline-grid size-5 place-items-center rounded-sm text-muted-foreground/70 hover:text-foreground focus-ring pointer-coarse:size-7"
        >
          <Info aria-hidden className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" align="start" className="block max-w-sm text-pretty leading-relaxed">
        {children}
      </TooltipContent>
    </Tooltip>
  );
}

function KpiCard(props: { label: string; tip: ReactNode; className?: string; children: ReactNode }): ReactElement {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1 p-4 max-sm:px-3', props.className)}>
      <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
        <span>{props.label}</span>
        <InfoTip label={props.label}>{props.tip}</InfoTip>
      </div>
      {props.children}
    </div>
  );
}

/** Большое число карточки; пока цены не загружены — заглушка */
function Value({ loading, stale, big, children }: { loading: boolean; stale: boolean; big?: boolean; children: ReactNode }): ReactElement {
  if (loading) return <Skeleton className="my-0.5 h-9 w-40 max-w-full" />;
  return (
    <div
      className={cn(
        'truncate font-semibold tabular-nums transition-opacity',
        // на телефоне боковые карточки — в полэкрана: 20 px, чтобы и 8-значная сумма не обрезалась
        big ? 'text-3xl leading-10 tracking-tight sm:text-4xl' : 'text-xl leading-8 sm:text-[28px]',
        stale && 'opacity-70',
      )}
    >
      {children}
    </div>
  );
}

function Glyph({ children }: { children: string }): ReactElement {
  return (
    <div aria-hidden className="hidden items-center px-1 text-2xl text-muted-foreground xl:flex">
      {children}
    </div>
  );
}

const Sub = ({ children, className }: { children: ReactNode; className?: string }) => (
  <p className={cn('text-xs leading-5 text-muted-foreground', className)}>{children}</p>
);

/** Множитель наценки: 1,5 / 1,333 */
const kText = (m: number) => String(Math.round((1 + m / 100) * 1000) / 1000).replace('.', ',');

export function KpiBand(): ReactElement {
  const d = useDerived();
  const loaded = useStore((s) => s.prices.loaded);
  const delivery = useStore((s) => s.order.delivery);
  const hasAi = useStore((s) => !!s.order.ai);
  const q = d.quote;
  const T = d.res.totals;
  const m = q.markupPct;
  const vatK = 1 + q.vatPct / 100;
  const money = (v: number) => clientMoney(q, v); // один формат для карточек и подсказок
  const loading = !loaded;
  const stale = d.stale;
  const exact = q.total - q.roundingDiff; // точная цена (без округления цены за шт) тех же строк
  const watch = useStripWatch(); // «Цена клиенту» ушла под шапку — полоса MoneyStrip

  const parts: Record<CatKey, number> = { material: T.material, cut: T.cutting, bend: T.bending, extras: T.extras, delivery: T.delivery };
  const legend = CATS.filter((c) => parts[c.key] > 0 || c.key === 'material' || c.key === 'cut');
  const share = (v: number) => (T.cost > 0 ? `${Math.round((v / T.cost) * 100)}${NBSP}%` : `0${NBSP}%`);
  const enabled = d.positions.filter((p) => !p.disabled).length;
  const sheets = d.res.groups.reduce((a, g) => a + g.chosen.sheetsCharged, 0);
  const sheetsWord = Number.isInteger(sheets) ? plural(sheets, 'лист', 'листа', 'листов') : 'листа';

  return (
    <>
      <section aria-label="Итог заказа" className="rounded-xl border bg-card text-card-foreground">
        <div className="grid grid-cols-2 xl:grid-cols-[minmax(0,1fr)_auto_minmax(0,1.15fr)_auto_minmax(0,1.3fr)_1px_minmax(0,1fr)]">
          <KpiCard
            label="Себестоимость"
            className="max-md:order-2"
            tip={
              <>
                Что мы заплатим цехам и за металл, с НДС {q.vatPct}
                {NBSP}%: металл по ценам mc.ru, резка и гибка по «Расценкам», доп. работы, доставка. Без НДС — {money(q.cost / vatK)}.
                {delivery > 0
                  ? ` Доставка входит в себестоимость, наценка начисляется и на неё: клиенту доставка ${money(q.delivery)}.`
                  : ' Доставка входит в себестоимость, наценка начисляется и на неё.'}
              </>
            }
          >
            <Value loading={loading} stale={stale}>
              {money(q.cost)}
            </Value>
            <Sub>металл, резка, гибка, доп. работы, доставка</Sub>
            <Sub>без НДС {money(q.cost / vatK)}</Sub>
            <label className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              доставка
              <NumInput value={delivery} onChange={setDelivery} allowEmpty placeholder="0" suffix="₽" aria-label="Доставка, ₽" size="sm" className="w-28" />
            </label>
          </KpiCard>

          <Glyph>+</Glyph>

          <KpiCard
            label="Наценка"
            className="max-md:order-4 max-md:col-span-2 max-md:border-t"
            tip="Наценка к себестоимости. По умолчанию 50 %. Наценку часто путают с маржой: при наценке 50 % маржа — 33,3 % от цены."
          >
            <MarkupControl className="mt-0.5" />
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
              <Sub>{marginLine(m)}</Sub>
              <ScenariosPopover />
            </div>
          </KpiCard>

          <Glyph>=</Glyph>

          <KpiCard
            label="Цена клиенту"
            className="max-md:order-first max-md:col-span-2 max-md:border-b xl:my-2 xl:rounded-lg xl:bg-muted/50 xl:py-2"
            tip={
              <>
                Столько платит клиент — ровно эта сумма будет в КП и в тексте для письма. Себестоимость × {kText(m)}; цена за шт округлена{' '}
                {ROUNDING_HINT[q.settings.rounding]}. Точно — {rub2(exact)} (разница {signedRub(q.roundingDiff, true)}).
              </>
            }
          >
            <div ref={watch}>
              <Value loading={loading} stale={stale} big>
                {money(q.total)}
              </Value>
            </div>
            <Sub>эту сумму платит клиент, с НДС</Sub>
            <Sub>
              с наценкой {n1(m)}
              {NBSP}% · в т.ч. НДС {q.vatPct}
              {NBSP}% — {rub2(q.vat)}
            </Sub>
            <Sub>без НДС {rub2(q.total - q.vat)}</Sub>
            {(!hasAi || q.unpriced > 0) && (
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                {!hasAi && <Badge variant="outline">без проверки ИИ</Badge>}
                {q.unpriced > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setFilter('unpriced');
                      setTab('positions');
                    }}
                    className="inline-flex items-center gap-1 rounded-sm text-left text-xs text-warn hover:underline focus-ring"
                  >
                    <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
                    Итог неполный: {q.unpriced} {plural(q.unpriced, 'позиция', 'позиции', 'позиций')} без размеров
                  </button>
                )}
              </div>
            )}
          </KpiCard>

          <div aria-hidden className="my-4 hidden w-px bg-border xl:block" />

          <KpiCard
            label="Выручка"
            className="max-md:order-3"
            tip={
              <>
                Сколько заказ приносит нам сверх затрат: {money(q.total)} − {money(q.cost)} = {money(q.revenue)}. Маржа = выручка ÷ цена
                клиенту. Клиент платит «Цену клиенту» — {money(q.total)}.
              </>
            }
          >
            <Value loading={loading} stale={stale}>
              {money(q.revenue)}
            </Value>
            <Sub>цена клиенту − себестоимость</Sub>
            <Sub>
              маржа {pct1(q.marginPct)} · без НДС {money(q.revenue / vatK)}
            </Sub>
          </KpiCard>
        </div>

        <div className={cn('flex flex-wrap items-center gap-x-6 gap-y-2 border-t px-4 py-3 max-sm:px-3', stale && 'opacity-70')}>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <CostBar parts={parts} className="h-2.5 w-56 max-w-full" />
            <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" aria-label="Из чего складывается себестоимость">
              {legend.map((c) => (
                <li key={c.key} className="flex items-center gap-1.5 whitespace-nowrap">
                  <CatDot cat={c.key} />
                  <span>{c.label}</span>
                  <span className="font-medium tabular-nums">{loading ? '…' : rub0(parts[c.key])}</span>
                  <span className="text-muted-foreground tabular-nums">· {share(parts[c.key])}</span>
                </li>
              ))}
            </ul>
          </div>
          <p className="text-xs text-muted-foreground tabular-nums">
            {enabled} {plural(enabled, 'позиция', 'позиции', 'позиций')} · {n0(T.pieces)}
            {NBSP}шт · {kg(T.kg)} металла в деталях · рез {n1(T.cutM)}
            {NBSP}м · {n0(T.bends)} {plural(T.bends, 'гиб', 'гиба', 'гибов')} · {n1(sheets)} {sheetsWord} в раскрое
          </p>
        </div>
      </section>
      <MoneyStrip />
      <MobileCopyBar />
    </>
  );
}
