// «Сценарии наценки»: цена клиенту, выручка и маржа при 30/50/70/100 % (и своей наценке) — каждая строка
// считается buildQuote, поэтому строка с текущей наценкой совпадает с KPI. Внизу — «Наценка под цену».
import { useMemo, useRef, useState, type ReactElement } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx';
import { Money } from '@/components/common/Money.tsx';
import { NumInput } from '@/components/common/NumInput.tsx';
import { ChevronDown } from '@/components/common/icons.ts';
import { cn } from '@/lib/utils.ts';
import { n1, NBSP, pct1 } from '@/format.ts';
import { buildQuote, clientMoney, type Quote } from '@/quote.ts';
import { setMarkup } from '@/store/actions.ts';
import { useDerived } from '@/store/derived.tsx';
import { useStore } from '@/store/store.ts';
import { MARKUP_PRESETS } from './MarkupControl.tsx';

/** Наценка с одним знаком после запятой: «41,0 %» */
const pctFixed1 = (v: number) => `${v.toFixed(1).replace('.', ',')}${NBSP}%`;

/** Наценка, при которой цена клиенту ≈ target: round1((target / cost − 1) × 100) */
export const markupForTarget = (target: number, cost: number): number => Math.round((target / cost - 1) * 1000) / 10;

function ScenariosBody(): ReactElement {
  const d = useDerived();
  const order = useStore((s) => s.order);
  const settings = useStore((s) => s.settings);
  const qs = useStore((s) => s.quote);
  const book = useStore((s) => s.prices.book);
  const current = order.markupPct;
  const [target, setTarget] = useState(0);
  const targetRef = useRef(0);

  const quoteAt = useMemo(() => {
    const cache = new Map<number, Quote>();
    return (m: number): Quote => {
      if (m === d.res.markupPct) return d.quote;
      let q = cache.get(m);
      if (!q) {
        q = buildQuote({ order, positions: d.positions, res: d.res, settings, quote: qs, book, markupPct: m });
        cache.set(m, q);
      }
      return q;
    };
  }, [d.quote, d.positions, d.res, order, settings, qs, book]);

  const rows = useMemo(() => {
    const list = MARKUP_PRESETS.includes(current) ? [...MARKUP_PRESETS] : [...MARKUP_PRESETS, current].sort((a, b) => a - b);
    return list.map((m) => ({ m, q: quoteAt(m) }));
  }, [current, quoteAt]);

  const cost = d.quote.cost;
  const money = (v: number) => clientMoney(d.quote, v); // как в «Итоге заказа»
  const fit = target > 0 && cost > 0 ? markupForTarget(target, cost) : null;
  const below = target > 0 && target <= cost;
  const fitQuote = fit != null && !below ? quoteAt(Math.min(1000, fit)) : null;

  const apply = (t = targetRef.current) => {
    if (!(t > cost) || !(cost > 0)) return;
    setMarkup(Math.min(1000, markupForTarget(t, cost)));
  };

  return (
    <>
      <div className="px-3 pt-3">
        <h3 className="text-sm font-semibold">Сценарии наценки</h3>
        <p className="text-xs text-muted-foreground">Строка — выбрать наценку. Цены за шт округлены, как в КП.</p>
      </div>
      {/* на телефоне — мельче и с узкими полями: суммы с копейками помещаются в 358 px */}
      <table className="w-full text-[13px] max-sm:text-xs">
        <thead>
          <tr className="border-b text-xs text-muted-foreground">
            <th className="px-3 py-1.5 text-left font-medium max-sm:px-2">Наценка</th>
            <th className="px-2 py-1.5 text-right font-medium">Цена клиенту</th>
            <th className="px-2 py-1.5 text-right font-medium">Выручка</th>
            <th className="px-3 py-1.5 text-right font-medium max-sm:px-2">Маржа</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ m, q }) => {
            const on = m === current;
            return (
              <tr
                key={m}
                onClick={() => setMarkup(m)}
                className={cn('cursor-pointer border-b last:border-b-0 hover:bg-muted/60', on && 'bg-accent hover:bg-accent font-medium')}
              >
                <td className="px-3 py-1 max-sm:px-2">
                  <button
                    type="button"
                    aria-pressed={on}
                    aria-label={`Наценка ${n1(m)} %: цена клиенту ${clientMoney(q, q.total)}, выручка ${clientMoney(q, q.revenue)}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setMarkup(m);
                    }}
                    className="rounded-sm tabular-nums focus-ring"
                  >
                    {`${n1(m)}${NBSP}%`}
                    {!MARKUP_PRESETS.includes(m) && <span className="ml-1 text-xs font-normal text-muted-foreground">своя</span>}
                  </button>
                </td>
                <td className="px-2 py-1 text-right whitespace-nowrap tabular-nums">{clientMoney(q, q.total)}</td>
                <td className="px-2 py-1 text-right whitespace-nowrap tabular-nums">{clientMoney(q, q.revenue)}</td>
                <td className="px-3 py-1 text-right tabular-nums max-sm:px-2">{pct1(q.marginPct)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="flex flex-col gap-1.5 border-t bg-muted/40 px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          <span>Наценка под цену:</span>
          <NumInput
            value={target}
            allowEmpty
            onChange={(v) => {
              targetRef.current = v;
              setTarget(v);
            }}
            onEnter={() => apply()}
            suffix="₽"
            size="sm"
            placeholder="цена клиенту"
            aria-label="Нужная цена клиенту, ₽"
            className="w-36"
          />
          <span aria-live="polite" className="tabular-nums">
            → {fit != null && !below ? <b className="font-semibold">{pctFixed1(fit)}</b> : '—'}
          </span>
        </div>
        <div className="flex items-end gap-3">
          <p className={cn('min-w-0 flex-1 text-xs', below ? 'text-danger' : 'text-muted-foreground')}>
            {below ? (
              `Цена ниже себестоимости (${money(cost)})`
            ) : fitQuote ? (
              <>
                Итог получится <Money value={fitQuote.total} kop={fitQuote.settings.rounding === 'kop'} className="font-medium text-foreground" />
                {Math.abs(fitQuote.total - target) >= 0.005 ? ` — наценка округлена до 0,1${NBSP}% и цена за шт округлена` : ''}
              </>
            ) : (
              `Себестоимость ${money(cost)}: введите цену клиенту — подберём наценку`
            )}
          </p>
          <Button size="xs" disabled={fit == null || below} onClick={() => apply(target)}>
            Применить
          </Button>
        </div>
      </div>
    </>
  );
}

export function ScenariosPopover(): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="link" size="xs" className="h-auto px-0 text-xs text-muted-foreground hover:text-foreground">
          Сценарии
          <ChevronDown data-icon="inline-end" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[420px] max-w-[calc(100vw-2rem)] gap-2 p-0">
        {open && <ScenariosBody />}
      </PopoverContent>
    </Popover>
  );
}
