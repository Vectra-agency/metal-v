// «Список листов»: что взять под заказ по каждой группе «материал + толщина» — рулон 1500 × длина или листы
// 1500×3000 × N шт (правила — «Расценки» → «Раскрой и НДС» → «Листы металла»), масса и стоимость металла,
// выбран лист автоматически по правилу или вручную.
import type { ReactElement } from 'react';
import { Badge } from '@/components/ui/badge.tsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.tsx';
import { ruleText, type GroupResult, type OrderResult } from '@/core/pricing.ts';
import { kg, rub0, thick } from '@/format.ts';
import { openSheet } from '@/store/actions.ts';
import { useStore } from '@/store/store.ts';
import { sheetTake } from './GroupCard.tsx';

const num = 'text-right tabular-nums whitespace-nowrap';

/** Масса металла, который берём: рулон — вся ширина × размотка, листы — целые листы раскроя */
function takenKg(g: GroupResult): number {
  const c = g.chosen;
  if (c.offer.coil) return (c.coilM ?? 0) * c.sheetKg;
  return c.nest.sheets.length * c.sheetKg;
}

export function SheetList({ res }: { res: OrderResult }): ReactElement {
  const rules = useStore((s) => s.settings.sheetRules);
  return (
    <section aria-labelledby="sheet-list-h" className="flex flex-col gap-2 rounded-xl border bg-card">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 pt-3">
        <h3 id="sheet-list-h" className="text-sm font-semibold">
          Список листов
        </h3>
        <button
          type="button"
          onClick={() => openSheet({ kind: 'settings', tab: 'nest' })}
          className="rounded-sm text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-ring"
        >
          Правила: {rules.map((r) => ruleText({ sheetRules: rules }, r)).join('; ')}
        </button>
      </div>
      <div className="overflow-x-auto">
        <Table className="text-[13px]">
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">Материал</TableHead>
              <TableHead className="text-right">Толщина</TableHead>
              <TableHead>Что взять</TableHead>
              <TableHead className="text-right">Масса металла</TableHead>
              <TableHead className="text-right">Металл в расчёте</TableHead>
              <TableHead className="pr-4">Выбор</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {res.groups.map((g) => {
              const c = g.chosen;
              return (
                <TableRow key={g.key}>
                  <TableCell className="pl-4">{g.material.label}</TableCell>
                  <TableCell className={num}>{thick(g.t)}</TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">{sheetTake(c)}</TableCell>
                  <TableCell className={num}>{kg(takenKg(g))}</TableCell>
                  <TableCell className={num}>{rub0(g.materialCost)}</TableCell>
                  <TableCell className="pr-4">
                    {g.autoChosen ? (
                      <span className="text-xs text-muted-foreground">{c.offer.rule ? 'по правилу' : 'авто'}</span>
                    ) : (
                      <Badge variant="outline">вручную</Badge>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
