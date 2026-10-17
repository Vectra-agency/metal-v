// Таблица позиций: своя прокрутка (липкие шапка, итог и первые столбцы), сортировка по заголовкам, выбор строк
// (Shift — диапазон), клавиатура по строкам, «Показать ещё» для больших заказов.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FocusEvent, type ReactElement, type ReactNode, type UIEvent } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { Checkbox } from '@/components/ui/checkbox.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx';
import { CatDot, type CatKey } from '@/components/common/CostBar.tsx';
import { ArrowDown, ArrowUp, ArrowUpDown, TriangleAlert } from '@/components/common/icons.ts';
import { Money } from '@/components/common/Money.tsx';
import { n0, n1, NBSP } from '@/format.ts';
import { cn } from '@/lib/utils.ts';
import { cycleSort, setFilter, setSearch, setSelection, toggleSelected } from '@/store/actions.ts';
import { useDerived } from '@/store/derived.tsx';
import { getState, useStore } from '@/store/store.ts';
import type { SortKey } from '@/store/types.ts';
import { colWidth, STICKY_LEFT, visibleCols, type ColKey } from './columns.ts';
import { PositionRow } from './PositionRow.tsx';
import { rowsFor, visibleRows, type RowModel } from './rowModel.ts';

const PAGE = 300;

/** Сортируемый заголовок: кнопка внутри th, aria-sort на th. Строки не шире столбца (иначе налезают на соседний
 *  заголовок) — обрезаются многоточием, подпись целиком — в подсказке */
function SortHead(props: { k: SortKey; children: ReactNode; sub?: string; align?: 'left' | 'right'; label?: string; className?: string; style?: CSSProperties }) {
  const sort = useStore((s) => s.ui.sort);
  const on = sort.key === props.k;
  const Icon = !on ? ArrowUpDown : sort.dir === 1 ? ArrowUp : ArrowDown;
  const right = props.align === 'right';
  const text = props.label ?? (typeof props.children === 'string' ? props.children : '');
  return (
    <th aria-sort={on ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'} className={props.className} style={props.style}>
      <button
        type="button"
        onClick={() => cycleSort(props.k)}
        aria-label={props.label}
        title={text ? `${text}${props.sub ? ` ${props.sub}` : ''}: сортировать` : undefined}
        className={cn(
          'focus-ring group/sort inline-flex max-w-full items-center gap-1 rounded-sm font-medium hover:text-foreground',
          right && 'text-right',
          on ? 'text-foreground' : 'text-muted-foreground',
        )}
      >
        <span className={cn('flex min-w-0 flex-col', right ? 'items-end' : 'items-start')}>
          <span className="max-w-full truncate">{props.children}</span>
          {props.sub && <span className="max-w-full truncate text-[11px] font-normal text-muted-foreground">{props.sub}</span>}
        </span>
        <Icon aria-hidden className={cn('size-3.5 shrink-0', !on && 'opacity-40 group-hover/sort:opacity-100')} />
      </button>
    </th>
  );
}

const TH = 'h-11 px-1.5 text-left align-middle text-xs font-medium whitespace-nowrap text-muted-foreground';
const TH_STICKY = 'sticky z-2 bg-background';

function MoneyHead({ cat, label, title }: { cat: CatKey; label: string; title: string }): ReactElement {
  return (
    <th className={cn(TH, 'text-right')} title={title}>
      <span className="inline-flex items-center gap-1">
        <CatDot cat={cat} />
        {label}
      </span>
    </th>
  );
}

export function PositionsTable(): ReactElement {
  const d = useDerived();
  const kop = d.quote.settings.rounding === 'kop';
  const order = useStore((s) => s.order);
  const addedIds = useStore((s) => s.pipeline.addedIds);
  const filter = useStore((s) => s.ui.filter);
  const search = useStore((s) => s.ui.search);
  const sort = useStore((s) => s.ui.sort);
  const columns = useStore((s) => s.ui.columns);
  const selection = useStore((s) => s.ui.selection);
  const highlight = useStore((s) => s.ui.highlight);
  const flash = useStore((s) => s.ui.flash);
  const activeId = useStore((s) => (s.ui.sheet?.kind === 'position' ? s.ui.sheet.id : null));

  const rows = rowsFor(order, d, addedIds);
  const visible = visibleRows(rows, filter, search, sort, !!order.ai);
  const [limit, setLimit] = useState(PAGE);
  const shown = visible.length > limit ? visible.slice(0, limit) : visible;
  const selected = useMemo(() => new Set(selection), [selection]);
  const cols = useMemo(() => visibleCols(columns), [columns]);
  const container = useRef<HTMLDivElement>(null);

  // ---------- выбор строк: щелчок — одна, Shift — диапазон от последней ----------
  const anchor = useRef<string | null>(null);
  const visibleRef = useRef<RowModel[]>(visible);
  visibleRef.current = visible;
  const onSelect = useCallback((id: string, shift: boolean) => {
    const ids = visibleRef.current.map((m) => m.base.id);
    const a = shift && anchor.current ? ids.indexOf(anchor.current) : -1;
    const b = ids.indexOf(id);
    if (a >= 0 && b >= 0) {
      const range = ids.slice(Math.min(a, b), Math.max(a, b) + 1);
      setSelection([...new Set([...getState().ui.selection, ...range])]);
      return;
    }
    anchor.current = id;
    toggleSelected(id);
  }, []);
  const visibleIds = visible.map((m) => m.base.id);
  const nSel = visibleIds.filter((id) => selected.has(id)).length;
  const allState: boolean | 'indeterminate' = nSel === 0 ? false : nSel === visibleIds.length ? true : 'indeterminate';
  const toggleAll = () => {
    const vis = new Set(visibleIds);
    if (allState === true) setSelection(selection.filter((id) => !vis.has(id)));
    else setSelection([...new Set([...selection, ...visibleIds])]);
  };

  // ---------- клавиатура: одна строка в порядке Tab (остальные — стрелками) ----------
  const [focusId, setFocusId] = useState<string | null>(null);
  const focusable = focusId && shown.some((m) => m.base.id === focusId) ? focusId : (shown[0]?.base.id ?? null);
  const onFocusIn = (e: FocusEvent<HTMLTableSectionElement>) => {
    const tr = (e.target as HTMLElement).closest<HTMLElement>('tr[data-row-id]');
    if (tr?.dataset.rowId && tr.dataset.rowId !== focusId) setFocusId(tr.dataset.rowId);
  };

  // ---------- переход к строке (ui.flash): показать её, прокрутить ----------
  useEffect(() => {
    if (!flash) return;
    const idx = visible.findIndex((m) => m.base.id === flash);
    if (idx < 0) {
      // строка скрыта фильтром или поиском — показываем все
      if (rows.some((m) => m.base.id === flash) && (getState().ui.filter !== 'all' || getState().ui.search)) {
        setFilter('all');
        setSearch('');
      }
      return;
    }
    if (idx >= limit) {
      setLimit(Math.ceil((idx + 1) / PAGE) * PAGE);
      return;
    }
    const raf = requestAnimationFrame(() => {
      container.current?.querySelector(`tr[data-row-id="${CSS.escape(flash)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(raf);
  }, [flash, visible, rows, limit]);

  // строка, открытая в карточке (↑/↓ в карточке), — в видимой части контейнера, между шапкой и итогом
  useEffect(() => {
    const c = container.current;
    const tr = activeId ? c?.querySelector<HTMLElement>(`tr[data-row-id="${CSS.escape(activeId)}"]`) : null;
    if (!c || !tr) return;
    const head = c.querySelector('thead')?.getBoundingClientRect().height ?? 0;
    const foot = c.querySelector('tfoot')?.getBoundingClientRect().height ?? 0;
    const cr = c.getBoundingClientRect();
    const rr = tr.getBoundingClientRect();
    if (rr.top < cr.top + head) c.scrollTop -= cr.top + head - rr.top;
    else if (rr.bottom > cr.bottom - foot) c.scrollTop += rr.bottom - (cr.bottom - foot);
  }, [activeId]);

  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const v = el.scrollLeft > 0 ? 'true' : 'false';
    if (el.dataset.scrolled !== v) el.dataset.scrolled = v;
  };

  const markupPct = order.markupPct;
  const total = d.quote.total;
  const width = (c: ColKey) => (c === 'name' ? undefined : colWidth(c, columns));
  const minWidth = cols.reduce((a, c) => a + colWidth(c, columns), 0);
  const nCols = cols.length;
  const pieces = d.quote.lines.reduce((a, l) => a + l.qty, 0);
  // колонки между «Деталью» и «Себест.» в строке итога
  const midCols = cols.filter((c) => c !== 'select' && c !== 'status' && c !== 'name' && c !== 'cost' && c !== 'price' && c !== 'sum' && c !== 'menu').length;

  return (
    <div
      ref={container}
      role="region"
      aria-label="Позиции"
      tabIndex={-1}
      onScroll={onScroll}
      data-scrolled="false"
      className={cn(
        // высота — до нижнего поля страницы (pb-24): и в конце прокрутки шапка таблицы не уходит под липкие полосы
        'group/table relative max-h-[calc(100dvh-var(--header-h)-var(--strip-h)-11.25rem)] overflow-auto rounded-lg border outline-none',
        // строки выбраны — снизу панель массовой правки (уже 1280 px — в две строки, под неё +2rem в PositionsTab)
        selection.length > 0 && 'max-xl:max-h-[calc(100dvh-var(--header-h)-var(--strip-h)-13.25rem)]',
      )}
    >
      <table className="w-full table-fixed border-separate border-spacing-0 text-[13px] [&_td]:border-b [&_th]:border-b" style={{ minWidth }}>
        <colgroup>
          {cols.map((c) => (
            <col key={c} style={{ width: width(c) }} />
          ))}
        </colgroup>
        <thead className="sticky top-0 z-10 bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/85">
          <tr>
            <th className={cn(TH, TH_STICKY, 'pr-0')} style={{ left: STICKY_LEFT.select }}>
              <div className="flex justify-center">
                <Checkbox checked={allState} onCheckedChange={toggleAll} aria-label="Выбрать все" disabled={!visible.length} />
              </div>
            </th>
            <SortHead k="status" label="Проверка" className={cn(TH, TH_STICKY, 'text-center')} style={{ left: STICKY_LEFT.status }}>
              <TriangleAlert aria-hidden className="size-3.5" />
            </SortHead>
            <SortHead
              k="name"
              className={cn(TH, TH_STICKY, 'group-data-[scrolled=true]/table:shadow-[6px_0_6px_-6px_rgb(0_0_0/0.25)]')}
              style={{ left: STICKY_LEFT.name }}
            >
              Деталь
            </SortHead>
            <th className={TH}>Материал</th>
            <th className={cn(TH, 'text-right')}>Кол-во</th>
            {columns.bends && <th className={TH}>Гибы × длина</th>}
            {columns.geometry && <th className={TH}>Габарит · масса · рез</th>}
            {columns.breakdown && (
              <>
                <MoneyHead cat="material" label="Металл" title="Металл на 1 шт" />
                <MoneyHead cat="cut" label="Резка" title="Резка на 1 шт (метры + врезки)" />
                <MoneyHead cat="bend" label="Гибка" title="Гибка на 1 шт" />
                <MoneyHead cat="extras" label="Доп." title="Доп. работы на 1 шт" />
              </>
            )}
            {columns.cost && (
              <th className={cn(TH, 'text-right')} title="Себестоимость 1 шт: металл, резка, гибка, доп. работы">
                Себест./шт
              </th>
            )}
            <SortHead k="piece" align="right" sub={`с наценкой ${n1(markupPct)}${NBSP}%`} className={cn(TH, 'text-right')}>
              Цена/шт
            </SortHead>
            <SortHead k="sum" align="right" sub="клиенту" className={cn(TH, 'text-right')}>
              Сумма
            </SortHead>
            <th className={TH}>
              <span className="sr-only">Действия</span>
            </th>
          </tr>
        </thead>
        <tbody onFocus={onFocusIn}>
          {shown.map((m, i) => (
            <PositionRow
              key={m.base.id}
              m={m}
              selected={selected.has(m.base.id)}
              active={activeId === m.base.id}
              highlighted={highlight === m.base.id}
              flashing={flash === m.base.id}
              focusable={focusable === m.base.id}
              navRow={i}
              columns={columns}
              markupPct={markupPct}
              kop={kop}
              total={total}
              onSelect={onSelect}
            />
          ))}
          {!visible.length && (
            <tr>
              <td colSpan={nCols} className="h-28 text-center text-muted-foreground">
                <p>{search ? `Ничего не найдено по запросу «${search}»` : 'В этом фильтре позиций нет'}</p>
                <Button
                  variant="link"
                  size="sm"
                  onClick={() => {
                    setFilter('all');
                    setSearch('');
                  }}
                >
                  Показать все позиции
                </Button>
              </td>
            </tr>
          )}
          {visible.length > shown.length && (
            <tr>
              <td colSpan={nCols} className="py-2 text-center">
                <Button variant="outline" size="sm" onClick={() => setLimit((l) => l + PAGE)}>
                  Показать ещё ({Math.min(PAGE, visible.length - shown.length)})
                </Button>
              </td>
            </tr>
          )}
        </tbody>
        <tfoot className={cn('sticky bottom-0 z-10 bg-background font-medium transition-opacity', d.stale && 'opacity-60')}>
          <tr className="[&>td]:border-t [&>td]:border-b-0">
            <td colSpan={3} className={cn('sticky left-0 z-2 h-10 bg-background px-3 whitespace-nowrap')}>
              Итого {n0(d.quote.lines.length)}
              {NBSP}поз. · {n0(pieces)}
              {NBSP}шт
              {d.quote.unpriced > 0 && <span className="ml-2 text-xs font-normal text-danger">без цены: {d.quote.unpriced}</span>}
            </td>
            {midCols > 0 && <td colSpan={midCols} />}
            {columns.cost && (
              <td className="px-1.5 text-right whitespace-nowrap" title={order.delivery > 0 ? 'Себестоимость заказа, включая доставку' : 'Себестоимость заказа'}>
                <span className="mr-1 text-xs font-normal text-muted-foreground">себест.</span>
                <Money value={d.res.totals.cost} />
              </td>
            )}
            <td className="px-1.5 text-right whitespace-nowrap">
              {!columns.cost && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="text-xs font-normal text-muted-foreground" tabIndex={0}>
                      себест. <Money value={d.res.totals.cost} />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>Себестоимость заказа{order.delivery > 0 ? ', включая доставку' : ''}</TooltipContent>
                </Tooltip>
              )}
            </td>
            <td className="px-1.5 text-right whitespace-nowrap" colSpan={2}>
              <span className="mr-1 text-xs font-normal text-muted-foreground">клиенту</span>
              <Money value={d.quote.total} kop={kop} className="font-semibold" />
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
