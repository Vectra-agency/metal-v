// Сводка по материалам (перенесено из SheetsSection): материал и толщина — позиции, штуки, масса, металл, резка,
// гибка, доп. работы, итого. Те же числа, что раньше; ноль гибки и доп. работ — «—».
import type { ReactElement } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.tsx';
import type { OrderResult } from '@/core/pricing.ts';
import { kg, n0, rub0, thick } from '@/format.ts';

const dash = (v: number) => (v ? rub0(v) : '—');
const num = 'text-right tabular-nums whitespace-nowrap';

export function MaterialSummary({ res }: { res: OrderResult }): ReactElement {
  return (
    <div role="region" aria-label="Сводка по материалам" className="overflow-x-auto rounded-xl border bg-card">
      <Table className="text-[13px]">
        <TableHeader>
          <TableRow>
            <TableHead className="pl-4">Материал</TableHead>
            <TableHead className="text-right">Толщина</TableHead>
            <TableHead className="text-right">Позиций</TableHead>
            <TableHead className="text-right">Шт</TableHead>
            <TableHead className="text-right">Масса деталей</TableHead>
            <TableHead className="text-right">Металл</TableHead>
            <TableHead className="text-right">Резка</TableHead>
            <TableHead className="text-right">Гибка</TableHead>
            <TableHead className="text-right">Доп.</TableHead>
            <TableHead className="pr-4 text-right">Итого</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {res.groups.map((g) => {
            const ps = g.positionIds.map((id) => res.positions.get(id)).filter((p) => !!p);
            const sum = (f: (p: (typeof ps)[number]) => number) => ps.reduce((a, p) => a + f(p), 0);
            return (
              <TableRow key={g.key}>
                <TableCell className="pl-4">{g.material.label}</TableCell>
                <TableCell className={num}>{thick(g.t)}</TableCell>
                <TableCell className={num}>{ps.length}</TableCell>
                <TableCell className={num}>{n0(sum((p) => p.qty))}</TableCell>
                <TableCell className={num}>{kg(g.partsKg)}</TableCell>
                <TableCell className={num}>{rub0(sum((p) => p.sum.material))}</TableCell>
                <TableCell className={num}>{rub0(sum((p) => p.sum.cut + p.sum.pierce))}</TableCell>
                <TableCell className={num}>{dash(sum((p) => p.sum.bend))}</TableCell>
                <TableCell className={num}>{dash(sum((p) => p.sum.extras))}</TableCell>
                <TableCell className={`${num} pr-4 font-medium`}>{rub0(sum((p) => p.sum.total))}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
