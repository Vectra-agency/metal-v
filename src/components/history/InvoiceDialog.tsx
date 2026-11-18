// «Счёт цеха»: строки счёта на оплату и к каким деталям заказа они относятся. Сопоставление найдено
// автоматически (обозначение детали в строке; «набор пластин из Ст3 толщиной 2 мм» — все детали этой
// группы), менеджер его проверяет и правит. По строкам — факт против нашего расчёта тех же деталей.
import { useMemo, useState, type ReactElement } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx';
import { Field, FieldLabel } from '@/components/ui/field.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select.tsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.tsx';
import { isEditable } from '@/components/common/dom.ts';
import { Money } from '@/components/common/Money.tsx';
import { invoiceTotals, lineCalc, type HistoryInvoice, type HistoryOrder, type HistoryPart } from '@/core/history.ts';
import { getMaterial } from '@/core/materials.ts';
import { n0, n2, NBSP, plural, thick } from '@/format.ts';
import { closeDialog } from '@/store/actions.ts';
import { removeInvoice, saveInvoice } from '@/store/historyActions.ts';
import { useStore } from '@/store/store.ts';
import { DiffBadge, supplierName } from './shared.tsx';

const NONE = 'none';
const groupKeyOf = (p: HistoryPart) => `${p.materialId}|${p.thickness}`;

interface Choice {
  value: string;
  label: string;
  ids: string[];
}

function choicesOf(order: HistoryOrder): { groups: Choice[]; parts: Choice[] } {
  const active = order.parts.filter((p) => !p.disabled);
  const byGroup = new Map<string, HistoryPart[]>();
  for (const p of active) byGroup.set(groupKeyOf(p), [...(byGroup.get(groupKeyOf(p)) ?? []), p]);
  const groups = [...byGroup.entries()]
    .filter(([, ps]) => ps.length > 1)
    .map(([k, ps]) => ({
      value: `g:${k}`,
      label: `Все детали ${getMaterial(ps[0].materialId).short} ${thick(ps[0].thickness)} (${ps.length})`,
      ids: ps.map((p) => p.id),
    }));
  const parts = active.map((p) => ({
    value: `p:${p.id}`,
    label: `${p.name} · ${getMaterial(p.materialId).short} ${thick(p.thickness)} · ${n0(p.qty)}${NBSP}шт`,
    ids: [p.id],
  }));
  return { groups, parts };
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

function InvoiceForm({ order, draft }: { order: HistoryOrder; draft: HistoryInvoice }): ReactElement {
  const [inv, setInv] = useState<HistoryInvoice>(draft);
  const [busy, setBusy] = useState(false);
  const { groups, parts } = useMemo(() => choicesOf(order), [order]);
  const byValue = useMemo(() => new Map([...groups, ...parts].map((c) => [c.value, c])), [groups, parts]);
  const preview: HistoryOrder = useMemo(() => ({ ...order, invoice: inv }), [order, inv]);
  const totals = useMemo(() => invoiceTotals(preview), [preview]);
  const assigned = new Set(inv.lines.flatMap((l) => l.partIds));
  const missing = order.parts.filter((p) => !p.disabled && p.calc && !assigned.has(p.id));

  const valueOf = (ids: string[]): string => {
    if (!ids.length) return NONE;
    const hit = [...groups, ...parts].find((c) => sameSet(c.ids, ids));
    return hit ? hit.value : `k:${ids.join(',')}`;
  };
  const setLine = (i: number, ids: string[]) => setInv((x) => ({ ...x, lines: x.lines.map((l, k) => (k === i ? { ...l, partIds: ids } : l)) }));
  const save = async () => {
    setBusy(true);
    const ok = await saveInvoice(order, inv);
    if (!ok) setBusy(false);
  };

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-[1fr_8rem_9rem]">
        <Field>
          <FieldLabel htmlFor="inv-supplier">Цех</FieldLabel>
          <Input id="inv-supplier" value={inv.supplier} onChange={(e) => setInv({ ...inv, supplier: e.target.value })} placeholder="ООО «…»" />
        </Field>
        <Field>
          <FieldLabel htmlFor="inv-number">Номер счёта</FieldLabel>
          <Input id="inv-number" value={inv.number} onChange={(e) => setInv({ ...inv, number: e.target.value })} />
        </Field>
        <Field>
          <FieldLabel htmlFor="inv-date">Дата</FieldLabel>
          <Input id="inv-date" type="date" value={inv.date ?? ''} onChange={(e) => setInv({ ...inv, date: e.target.value || null })} />
        </Field>
      </div>

      <div className="max-h-[50dvh] overflow-auto rounded-lg border">
        <Table className="min-w-[760px] text-[13px]">
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-8">№</TableHead>
              <TableHead>Строка счёта</TableHead>
              <TableHead className="text-right">Сумма</TableHead>
              <TableHead className="w-[17rem]">Относится к</TableHead>
              <TableHead className="text-right">Наш расчёт</TableHead>
              <TableHead className="w-14 text-right">
                <span className="sr-only">Отклонение</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {inv.lines.map((l, i) => {
              const calc = l.partIds.length ? lineCalc(preview, l) : null;
              const value = valueOf(l.partIds);
              return (
                <TableRow key={i}>
                  <TableCell className="align-top text-muted-foreground tabular-nums">{l.n}</TableCell>
                  <TableCell className="align-top whitespace-normal">
                    <div>{l.text}</div>
                    <div className="text-xs text-muted-foreground tabular-nums">
                      {n2(l.qty).replace(/,00$/, '')} {l.unit} × <Money value={l.price} kop />
                    </div>
                  </TableCell>
                  <TableCell className="text-right align-top">
                    <Money value={l.sum} className="font-medium" />
                  </TableCell>
                  <TableCell className="align-top">
                    <Select value={value} onValueChange={(v) => setLine(i, v === NONE ? [] : (byValue.get(v)?.ids ?? l.partIds))}>
                      <SelectTrigger size="sm" className="w-[17rem] max-w-full" aria-label={`К чему относится строка ${l.n}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent position="popper" className="max-h-80">
                        <SelectItem value={NONE}>Не относится к расчёту</SelectItem>
                        {value.startsWith('k:') && (
                          <SelectItem value={value}>
                            {l.partIds.length} {plural(l.partIds.length, 'деталь', 'детали', 'деталей')}:{' '}
                            {l.partIds
                              .map((id) => order.parts.find((p) => p.id === id)?.name ?? id)
                              .slice(0, 3)
                              .join(', ')}
                            {l.partIds.length > 3 ? '…' : ''}
                          </SelectItem>
                        )}
                        {groups.length > 0 && (
                          <>
                            <SelectSeparator />
                            <SelectGroup>
                              <SelectLabel>Группа деталей</SelectLabel>
                              {groups.map((c) => (
                                <SelectItem key={c.value} value={c.value}>
                                  {c.label}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </>
                        )}
                        <SelectSeparator />
                        <SelectGroup>
                          <SelectLabel>Деталь</SelectLabel>
                          {parts.map((c) => (
                            <SelectItem key={c.value} value={c.value}>
                              {c.label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell className="text-right align-top">{calc != null ? <Money value={calc} /> : <span className="text-muted-foreground">—</span>}</TableCell>
                  <TableCell className="text-right align-top">
                    <DiffBadge calc={calc} fact={l.sum} />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <div className="flex flex-col gap-1 text-sm">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-muted-foreground">Отнесено к деталям:</span>
          <Money value={totals.fact} className="font-semibold" />
          <span className="text-muted-foreground">по счёту · наш расчёт тех же деталей</span>
          <Money value={totals.calc} className="font-semibold" />
          <DiffBadge calc={totals.calc} fact={totals.fact} />
        </div>
        <div className="text-muted-foreground">
          Всего по счёту <Money value={inv.total} />
          {totals.unmatched > 0 &&
            ` · ${totals.unmatched} ${plural(totals.unmatched, 'строка', 'строки', 'строк')} не ${plural(totals.unmatched, 'относится', 'относятся', 'относятся')} к расчёту (металл клиента, доставка, листы на склад)`}
        </div>
        {missing.length > 0 && (
          <div className="text-warn">
            Без строки счёта: {missing.slice(0, 6).map((p) => p.name).join(', ')}
            {missing.length > 6 ? ` и ещё ${missing.length - 6}` : ''} — по ним факта не будет.
          </div>
        )}
      </div>

      <DialogFooter className="gap-2 sm:items-center">
        {order.invoice && (
          <Button type="button" variant="ghost" className="sm:me-auto" disabled={busy} onClick={() => void removeInvoice(order)}>
            Убрать счёт из истории
          </Button>
        )}
        <Button type="button" variant="outline" onClick={closeDialog}>
          Отмена
        </Button>
        <Button type="button" disabled={busy} onClick={() => void save()}>
          Сохранить счёт
        </Button>
      </DialogFooter>
    </>
  );
}

export function InvoiceDialog(): ReactElement | null {
  const dialog = useStore((s) => s.ui.dialog);
  if (dialog?.kind !== 'invoice') return null;
  const { order, draft } = dialog;
  return (
    <Dialog open onOpenChange={(o) => !o && closeDialog()}>
      <DialogContent className="flex max-h-[92dvh] flex-col gap-4 sm:max-w-5xl" onEscapeKeyDown={(e) => isEditable(e.target) && e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>
            Счёт цеха{draft.supplier ? ` · ${supplierName(draft.supplier)}` : ''}
          </DialogTitle>
          <DialogDescription>
            Заказ «{order.title || 'без названия'}»: проверьте, к каким деталям относится каждая строка счёта. Факт по счёту сохранится в истории — по нему
            видно, насколько точен расчёт, и он подскажет цену, когда деталь закажут снова.
          </DialogDescription>
        </DialogHeader>
        <InvoiceForm key={`${order.id}|${draft.addedAt}`} order={order} draft={draft} />
      </DialogContent>
    </Dialog>
  );
}
