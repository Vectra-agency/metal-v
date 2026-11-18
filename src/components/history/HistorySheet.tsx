// Панель «История заказов»: все сохранённые заказы (общие для всех, кто вошёл), счёт цеха к любому из них,
// открыть заказ снова, удалить; «Сверка со счетами» — насколько текущие расценки сходятся с фактом по всем
// внесённым счетам (как scripts/check-invoices.ts, но по истории и прямо в приложении).
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs.tsx';
import { Ellipsis, Search } from '@/components/common/icons.ts';
import { isEditable } from '@/components/common/dom.ts';
import { Money } from '@/components/common/Money.tsx';
import { lineCalc, type HistoryOrder, type HistorySummary } from '@/core/history.ts';
import { getMaterial } from '@/core/materials.ts';
import { dateDay, n0, NBSP, pct1, plural, thick } from '@/format.ts';
import { invoicedOrders, listHistory } from '@/history/api.ts';
import { recalcHistory } from '@/history/build.ts';
import { closeSheet, openSheet } from '@/store/actions.ts';
import {
  downloadHistory,
  editInvoice,
  importHistoryFile,
  invoiceForHistory,
  openFromHistory,
  removeFromHistory,
} from '@/store/historyActions.ts';
import { getState, useStore } from '@/store/store.ts';
import type { HistoryTab } from '@/store/types.ts';
import { DiffBadge, diffPct, invoiceTitle, supplierName } from './shared.tsx';

type Load<T> = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; data: T };

/** Загрузка при открытии и после каждого изменения истории (version) */
function useLoad<T>(enabled: boolean, fn: (signal: AbortSignal) => Promise<T>): Load<T> {
  const version = useStore((s) => s.history.version);
  const [st, setSt] = useState<Load<T>>({ state: 'loading' });
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    if (!enabled) return;
    const ctl = new AbortController();
    setSt((x) => (x.state === 'ready' ? x : { state: 'loading' }));
    fnRef.current(ctl.signal).then(
      (data) => !ctl.signal.aborted && setSt({ state: 'ready', data }),
      (e: Error) => !ctl.signal.aborted && setSt({ state: 'error', message: e.message }),
    );
    return () => ctl.abort();
  }, [enabled, version]);
  return st;
}

function Loading({ st }: { st: Load<unknown> }): ReactElement | null {
  if (st.state === 'loading')
    return (
      <div className="flex flex-col gap-2" aria-busy="true" aria-label="Загрузка">
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
      </div>
    );
  if (st.state === 'error') return <p className="text-danger">Не удалось загрузить историю: {st.message}</p>;
  return null;
}

// ---------- заказы ----------

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е');

function OrderRow({ o, current }: { o: HistorySummary; current: boolean }): ReactElement {
  const inv = o.invoice;
  return (
    <li className="flex flex-col gap-1.5 px-3 py-3 sm:px-4">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium">{o.title || 'Без названия'}</span>
            {current && <Badge variant="secondary">открыт сейчас</Badge>}
          </div>
          <div className="text-xs text-muted-foreground">
            {o.groups.slice(0, 4).join(', ')}
            {o.groups.length > 4 ? ` и ещё ${o.groups.length - 4}` : ''} · {o.parts} {plural(o.parts, 'деталь', 'детали', 'деталей')}, {n0(o.pieces)}
            {NBSP}шт · сохранён {dateDay(o.updatedAt)}
          </div>
        </div>
        <div className="text-right">
          <Money value={o.cost} className="font-medium" />
          <div className="text-xs text-muted-foreground">себестоимость</div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        {inv ? (
          <>
            <span className="text-muted-foreground">
              Счёт {invoiceTitle(inv)}
              {inv.supplier ? ` · ${supplierName(inv.supplier)}` : ''}:
            </span>
            {inv.fact > 0 ? (
              <>
                <Money value={inv.fact} />
                <span className="text-muted-foreground">· расчёт</span>
                <Money value={inv.calc} />
                <DiffBadge calc={inv.calc} fact={inv.fact} />
              </>
            ) : (
              <span className="text-warn">строки не отнесены к деталям</span>
            )}
          </>
        ) : (
          <span className="text-muted-foreground">Счёта цеха нет</span>
        )}
        <div className="ms-auto flex items-center gap-1">
          <Button size="xs" variant="outline" onClick={() => (inv ? void editInvoice(o.id) : void invoiceForHistory(o.id))}>
            {inv ? 'Сверка' : 'Внести счёт…'}
          </Button>
          <Button size="xs" variant="outline" disabled={current} onClick={() => void openFromHistory(o.id)} title={current ? 'Этот заказ уже открыт' : 'Открыть вместо текущего (можно вернуть)'}>
            Открыть
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-xs" variant="ghost" aria-label={`Ещё: ${o.title || 'заказ'}`}>
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => void invoiceForHistory(o.id)}>{inv ? 'Заменить счёт из PDF…' : 'Внести счёт из PDF…'}</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => void removeFromHistory(o.id)}>
                Удалить из истории
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </li>
  );
}

function OrdersTab({ active }: { active: boolean }): ReactElement {
  const st = useLoad(active, listHistory);
  const currentId = useStore((s) => s.order.history?.id);
  const [q, setQ] = useState('');
  const list = st.state === 'ready' ? st.data : [];
  const shown = useMemo(() => {
    const w = norm(q.trim());
    if (!w) return list;
    return list.filter((o) => norm([o.title, ...o.names, ...o.groups, o.invoice?.number ?? '', o.invoice?.supplier ?? ''].join(' ')).includes(w));
  }, [list, q]);
  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Название, обозначение детали, номер счёта, цех" aria-label="Поиск по истории" className="pl-8" />
      </div>
      <Loading st={st} />
      {st.state === 'ready' &&
        (list.length === 0 ? (
          <p className="text-muted-foreground">
            В истории пока пусто. Сохраните расчёт кнопкой «Сохранить в историю» на экране результата, а когда придёт счёт цеха — внесите его.
          </p>
        ) : shown.length === 0 ? (
          <p className="text-muted-foreground">Ничего не нашлось по «{q}».</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {shown.map((o) => (
              <OrderRow key={o.id} o={o} current={o.id === currentId} />
            ))}
          </ul>
        ))}
    </div>
  );
}

// ---------- сверка со счетами ----------

interface CheckLine {
  key: string;
  order: HistoryOrder;
  text: string;
  group: string; // «Ст3 2 мм»
  bends: boolean;
  fact: number;
  then: number;
  now: number;
}

function checkLines(orders: HistoryOrder[]): CheckLine[] {
  const { book } = getState().prices;
  const { settings } = getState();
  const out: CheckLine[] = [];
  for (const o of orders) {
    const now = recalcHistory(o, book, settings);
    for (const [i, l] of (o.invoice?.lines ?? []).entries()) {
      if (!l.partIds.length || !(l.sum > 0)) continue;
      const then = lineCalc(o, l);
      const cur = lineCalc(o, l, (p) => now.get(p.id) ?? null);
      if (then == null || cur == null) continue;
      const parts = l.partIds.map((id) => o.parts.find((p) => p.id === id)!).filter(Boolean);
      const groups = [...new Set(parts.map((p) => `${getMaterial(p.materialId).short} ${thick(p.thickness)}`))];
      out.push({
        key: `${o.id}|${i}`,
        order: o,
        text: l.text,
        group: groups.length === 1 ? groups[0] : `${groups[0]} и др.`,
        bends: parts.some((p) => p.bends > 0),
        fact: l.sum,
        then,
        now: cur,
      });
    }
  }
  return out;
}

const mae = (ls: CheckLine[], k: 'now' | 'then') => (ls.length ? (ls.reduce((a, l) => a + Math.abs(l[k] - l.fact) / l.fact, 0) / ls.length) * 100 : 0);

function Breakdown({ title, rows }: { title: string; rows: [string, CheckLine[]][] }): ReactElement {
  return (
    <div className="rounded-lg border">
      <div className="border-b px-3 py-2 text-sm font-semibold">{title}</div>
      <Table className="text-[13px]">
        <TableBody>
          {rows.map(([k, ls]) => {
            const fact = ls.reduce((a, l) => a + l.fact, 0);
            const now = ls.reduce((a, l) => a + l.now, 0);
            return (
              <TableRow key={k}>
                <TableCell>{k}</TableCell>
                <TableCell className="text-right text-muted-foreground tabular-nums">
                  {ls.length} {plural(ls.length, 'строка', 'строки', 'строк')}
                </TableCell>
                <TableCell className="text-right">
                  <Money value={fact} />
                </TableCell>
                <TableCell className="text-right">
                  <Money value={now} />
                </TableCell>
                <TableCell className="w-16 text-right">
                  <DiffBadge calc={now} fact={fact} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function CheckTab({ active }: { active: boolean }): ReactElement {
  const st = useLoad(active, invoicedOrders);
  const book = useStore((s) => s.prices.book);
  const settings = useStore((s) => s.settings);
  // пересчёт по текущим расценкам и ценам: book и settings — входы checkLines (берёт их из хранилища)
  const lines = useMemo(() => (st.state === 'ready' ? checkLines(st.data) : []), [st, book, settings]);
  if (st.state !== 'ready') return <Loading st={st} />;
  if (!lines.length)
    return (
      <p className="text-muted-foreground">
        Пока не с чем сверять: внесите счёт цеха хотя бы к одному заказу из истории. Тогда здесь будет видно, насколько текущие расценки и цены mc.ru
        сходятся с тем, что цеха выставляют на самом деле.
      </p>
    );
  const by = (f: (l: CheckLine) => string): [string, CheckLine[]][] => {
    const m = new Map<string, CheckLine[]>();
    for (const l of lines) m.set(f(l), [...(m.get(f(l)) ?? []), l]);
    return [...m.entries()].sort((a, b) => b[1].reduce((x, l) => x + l.fact, 0) - a[1].reduce((x, l) => x + l.fact, 0));
  };
  const fact = lines.reduce((a, l) => a + l.fact, 0);
  const now = lines.reduce((a, l) => a + l.now, 0);
  const orders = new Set(lines.map((l) => l.order.id)).size;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border p-3">
          <div className="text-xs text-muted-foreground">По счетам ({orders} {plural(orders, 'заказ', 'заказа', 'заказов')})</div>
          <Money value={fact} className="text-lg font-semibold" />
        </div>
        <div className="rounded-lg border p-3">
          <div className="text-xs text-muted-foreground">Наш расчёт сейчас</div>
          <div className="flex items-center gap-2">
            <Money value={now} className="text-lg font-semibold" />
            <DiffBadge calc={now} fact={fact} />
          </div>
        </div>
        <div className="rounded-lg border p-3">
          <div className="text-xs text-muted-foreground">Средняя ошибка по строке</div>
          <div className="text-lg font-semibold tabular-nums">{pct1(mae(lines, 'now'))}</div>
          <div className="text-xs text-muted-foreground">при сохранении было {pct1(mae(lines, 'then'))}</div>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        «Сейчас» — те же детали по текущим расценкам и ценам mc.ru; «+» — расчёт выше счёта. Расхождение в одной группе материала или только у деталей с
        гибкой подсказывает, какую ставку поправить в «Расценках».
      </p>
      <div className="grid gap-3">
        <Breakdown title="По материалу и толщине" rows={by((l) => l.group)} />
        <Breakdown title="С гибкой и без" rows={by((l) => (l.bends ? 'С гибкой' : 'Без гибки'))} />
      </div>
      <div className="overflow-x-auto rounded-lg border">
        <Table className="min-w-[680px] text-[13px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Строка счёта</TableHead>
              <TableHead className="text-right">По счёту</TableHead>
              <TableHead className="text-right">Расчёт тогда</TableHead>
              <TableHead className="text-right">Расчёт сейчас</TableHead>
              <TableHead className="w-16 text-right">
                <span className="sr-only">Отклонение</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines
              .slice()
              .sort((a, b) => Math.abs(diffPct(b.now, b.fact) ?? 0) - Math.abs(diffPct(a.now, a.fact) ?? 0))
              .map((l) => (
                <TableRow key={l.key}>
                  <TableCell className="whitespace-normal">
                    <div>{l.text}</div>
                    <div className="text-xs text-muted-foreground">
                      {l.order.title || 'Без названия'}
                      {l.order.invoice ? ` · счёт ${invoiceTitle(l.order.invoice)}` : ''}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <Money value={l.fact} />
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    <Money value={l.then} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money value={l.now} />
                  </TableCell>
                  <TableCell className="text-right">
                    <DiffBadge calc={l.now} fact={l.fact} />
                  </TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ---------- панель ----------

export function HistorySheet(): ReactElement | null {
  const sheet = useStore((s) => s.ui.sheet);
  const open = sheet?.kind === 'history';
  const tab: HistoryTab = (open && sheet.tab) || 'orders';
  const opener = useRef<HTMLElement | null>(null);
  return (
    <Sheet open={open} onOpenChange={(o) => !o && closeSheet()}>
      <SheetContent
        side="right"
        className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-[820px]"
        onEscapeKeyDown={(e) => isEditable(e.target) && e.preventDefault()}
        onOpenAutoFocus={() => {
          opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
          opener.current = null;
        }}
      >
        <SheetHeader className="gap-1 pr-12">
          <SheetTitle className="text-lg font-semibold">История заказов</SheetTitle>
          <SheetDescription className="text-balance">
            Общая для всех, кто входит на сайт. Счёт цеха к заказу — факт: по нему видно, насколько точен расчёт, а та же деталь в новом заказе покажет
            прошлую цену.
          </SheetDescription>
        </SheetHeader>
        <Tabs value={tab} onValueChange={(v) => openSheet({ kind: 'history', tab: v as HistoryTab })} className="min-h-0 flex-1 gap-0">
          <div className="border-b px-4 pb-3">
            <TabsList aria-label="Разделы истории">
              <TabsTrigger value="orders" className="px-2.5">
                Заказы
              </TabsTrigger>
              <TabsTrigger value="check" className="px-2.5">
                Сверка со счетами
              </TabsTrigger>
            </TabsList>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-4 pb-8">
            <TabsContent value="orders">
              <OrdersTab active={open && tab === 'orders'} />
            </TabsContent>
            <TabsContent value="check">
              <CheckTab active={open && tab === 'check'} />
            </TabsContent>
          </div>
        </Tabs>
        <SheetFooter className="mt-0 flex-row flex-wrap gap-2 border-t">
          <Button variant="outline" size="sm" onClick={() => void downloadHistory()}>
            Выгрузить всю историю (JSON)
          </Button>
          <Button variant="outline" size="sm" onClick={() => void importHistoryFile()}>
            Загрузить из файла…
          </Button>
        </SheetFooter>
        <style>{'[data-sonner-toast] { pointer-events: auto; }'}</style>
      </SheetContent>
    </Sheet>
  );
}
