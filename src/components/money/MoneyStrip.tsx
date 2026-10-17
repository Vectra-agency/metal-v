// Полоса итогов под шапкой: появляется, когда «Цена клиенту» в блоке «Итог заказа» уходит вверх под шапку
// (IntersectionObserver). Широкий экран — формула целиком («Себестоимость + наценка 50 % = Цена клиенту»), наценка
// и копирование; узкий — цена и выручка. Суммы — тем же форматом, что в «Итоге заказа» (clientMoney).
import { useEffect, useRef, type ReactElement, type RefObject } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.tsx';
import { Money } from '@/components/common/Money.tsx';
import { cn } from '@/lib/utils.ts';
import { createStore, useSelector } from '@/store/createStore.ts';
import { n1, NBSP, pct1 } from '@/format.ts';
import { clientMoney, type Quote } from '@/quote.ts';
import { setMarkup } from '@/store/actions.ts';
import { useDerived } from '@/store/derived.tsx';
import { useStore } from '@/store/store.ts';
import { CopyButton } from '@/components/quote/CopyButton.tsx';
import { MARKUP_PRESETS } from './MarkupControl.tsx';

// видна ли полоса («Цена клиенту» ушла под шапку)
const strip = createStore(false);

/** Высота шапки в px (--header-h, по умолчанию 3.5rem = 56 px) */
function headerPx(): number {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--header-h').trim();
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return 56;
  return v.endsWith('rem') ? n * parseFloat(getComputedStyle(document.documentElement).fontSize || '16') : n;
}

/** Следить за «Ценой клиенту» в KpiBand: когда число уходит под шапку, появляется полоса.
 *  (Не по низу всего блока: на «Позициях» страница короткая — таблица прокручивается сама, — и блок целиком не уходит,
 *  а числа уже под шапкой.) */
export function useStripWatch(): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    let io: IntersectionObserver | null = null;
    let top = -1;
    // шапка может стать выше (на телефоне — вторая строка): наблюдатель пересоздаётся под её высоту
    const attach = () => {
      const h = Math.round(headerPx());
      if (h === top) return;
      top = h;
      io?.disconnect();
      io = new IntersectionObserver(
        ([e]) => {
          // большая часть числа ушла вверх под шапку (а не вниз за край экрана)
          const gone = e.intersectionRatio < 0.6 && e.boundingClientRect.top < (e.rootBounds?.top ?? h);
          strip.set(() => gone);
        },
        { rootMargin: `-${h}px 0px 0px 0px`, threshold: [0, 0.6, 1] },
      );
      io.observe(el);
    };
    attach();
    const timer = setTimeout(attach, 400);
    window.addEventListener('resize', attach);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', attach);
      io?.disconnect();
      strip.set(() => false);
    };
  }, []);
  return ref;
}

function Label({ children }: { children: string }): ReactElement {
  return <span className="text-xs text-muted-foreground">{children}</span>;
}

/** Сумма как в «Итоге заказа»: «коп.» — с копейками, иначе целые рубли; цены не загружены — «—» */
function Amount({ q, v, loaded, className }: { q: Quote; v: number; loaded: boolean; className?: string }): ReactElement {
  if (!loaded) return <Money value={null} className={className} />;
  return <span className={cn('whitespace-nowrap tabular-nums', className)}>{clientMoney(q, v)}</span>;
}

export function MoneyStrip(): ReactElement | null {
  const visible = useSelector(strip, (v) => v);
  const d = useDerived();
  const m = useStore((s) => s.order.markupPct);
  const loaded = useStore((s) => s.prices.loaded);
  if (!visible) return null;
  const q = d.quote;
  const preset = MARKUP_PRESETS.includes(m);
  return (
    <div
      role="region"
      aria-label="Итог заказа, кратко"
      className={cn(
        'fixed inset-x-0 top-(--header-h) z-30 h-(--strip-h) border-b bg-background/95 backdrop-blur',
        'duration-200 animate-in fade-in-0 slide-in-from-top-2',
      )}
    >
      <div className="mx-auto flex h-full w-full max-w-[1920px] items-center gap-3 px-4 max-sm:gap-2 max-sm:px-3 lg:px-6">
        {/* группы не рвутся: что не помещается в строку, уходит на скрытую вторую строку целиком (а не обрезается посреди числа) */}
        <div
          className={cn(
            'flex h-6 min-w-0 flex-1 flex-wrap items-baseline gap-x-2 overflow-hidden text-sm whitespace-nowrap tabular-nums max-sm:gap-x-1.5',
            d.stale && 'opacity-70',
          )}
        >
          {/* формула целиком — от 1280 px */}
          <span className="hidden items-baseline gap-x-2 xl:inline-flex">
            <Label>Себестоимость</Label>
            <Amount q={q} v={q.cost} loaded={loaded} className="font-semibold" />
            <span className="text-muted-foreground">+</span>
            <Label>наценка</Label>
            <span className="font-semibold">{`${n1(m)}${NBSP}%`}</span>
            <span className="text-muted-foreground">=</span>
          </span>
          <span className="inline-flex items-baseline gap-x-2 max-sm:gap-x-1">
            <Label>Цена клиенту</Label>
            <Amount q={q} v={q.total} loaded={loaded} className="text-base font-semibold max-sm:text-sm" />
          </span>
          {/* на телефоне — без «·», цена мельче, промежутки уже: выручка с копейками («коп.») остаётся в строке */}
          <span className="inline-flex items-baseline gap-x-2 max-sm:gap-x-1">
            <span aria-hidden className="mx-1 text-border max-lg:hidden">
              │
            </span>
            <span className="text-muted-foreground max-sm:hidden lg:hidden" aria-hidden>
              ·
            </span>
            <Label>Выручка</Label>
            <Amount q={q} v={q.revenue} loaded={loaded} className="font-semibold" />
            <span className="text-muted-foreground max-lg:hidden">· маржа {pct1(q.marginPct)}</span>
          </span>
        </div>
        <Select value={preset ? String(m) : 'own'} onValueChange={(v) => v !== 'own' && setMarkup(Number(v))}>
          <SelectTrigger size="sm" aria-label="Наценка" className="w-[8.75rem] max-lg:hidden">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" align="end">
            {MARKUP_PRESETS.map((p) => (
              <SelectItem key={p} value={String(p)}>
                {`Наценка ${p}${NBSP}%`}
              </SelectItem>
            ))}
            {!preset && <SelectItem value="own">{`своя: ${n1(m)}${NBSP}%`}</SelectItem>}
          </SelectContent>
        </Select>
        <CopyButton size="sm" compact="auto" className="max-sm:hidden" />
        <CopyButton size="sm" compact="icon" withMenu={false} className="sm:hidden" />
      </div>
    </div>
  );
}
