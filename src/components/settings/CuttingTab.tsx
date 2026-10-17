// «Резка»: ₽ за метр реза и за врезку по толщинам (чёрная сталь), между строками — интерполяция.
import type { ReactElement } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.tsx';
import { NumInput } from '@/components/common/NumInput.tsx';
import type { CutRow } from '@/core/pricing.ts';
import { n1 } from '@/format.ts';
import { patchSettings } from '@/store/actions.ts';
import { useStore } from '@/store/store.ts';
import { AddRow, Hint, MAX_ROWS, patchRow, removeRow, RowDelete, rowKey, sortRows, TD, TDN, TH, useRowFocus } from './shared.tsx';

export function CuttingTab(): ReactElement {
  const rows = useStore((s) => s.settings.cutting);
  const focus = useRowFocus();
  const set = (cutting: CutRow[]) => patchSettings({ cutting });
  // новая толщина — строка встаёт на своё место
  const edit = (i: number, patch: Partial<CutRow>) => set(patch.t == null ? patchRow(rows, i, patch) : sortRows(patchRow(rows, i, patch), (r) => r.t));

  const add = () => {
    const last = rows.at(-1);
    set([...rows, { t: (last?.t ?? 0) + 1, perM: last?.perM ?? 50, pierce: last?.pierce ?? 10 }]);
    focus.afterAdd('set-cut-t', rows.length);
  };
  const del = (i: number) => {
    set(removeRow(rows, i));
    focus.afterDelete(i);
  };

  return (
    <div className="flex flex-col gap-3">
      <Hint>
        Чёрная сталь (Ст3). Для других материалов цена умножается на коэффициент со вкладки «Материалы». Между строками — линейная интерполяция.
      </Hint>
      <div ref={focus.ref} className="flex max-w-md flex-col items-start gap-3">
        <div className="w-full rounded-lg border">
          <Table className="text-[13px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className={TH}>Толщина, мм</TableHead>
                <TableHead className={`${TH} text-right`}>₽ за метр реза</TableHead>
                <TableHead className={`${TH} text-right`}>₽ за врезку</TableHead>
                <TableHead className="w-9 px-1">
                  <span className="sr-only">Удалить</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r, i) => (
                <TableRow key={rowKey(r)}>
                  <TableCell className={TD}>
                    <NumInput
                      size="sm"
                      value={r.t}
                      min={0.1}
                      max={100}
                      onChange={(t) => edit(i, { t })}
                      aria-label={`Толщина, мм, строка ${i + 1}`}
                      navCol="set-cut-t"
                      navRow={i}
                      className="w-16 sm:w-20"
                    />
                  </TableCell>
                  <TableCell className={TDN}>
                    <NumInput
                      size="sm"
                      value={r.perM}
                      onChange={(perM) => edit(i, { perM })}
                      aria-label={`₽ за метр реза, ${n1(r.t)} мм`}
                      navCol="set-cut-perM"
                      navRow={i}
                      className="w-20 sm:w-24"
                    />
                  </TableCell>
                  <TableCell className={TDN}>
                    <NumInput
                      size="sm"
                      value={r.pierce}
                      onChange={(pierce) => edit(i, { pierce })}
                      aria-label={`₽ за врезку, ${n1(r.t)} мм`}
                      navCol="set-cut-pierce"
                      navRow={i}
                      className="w-20 sm:w-24"
                    />
                  </TableCell>
                  <TableCell className="px-1 py-1 text-right">
                    <RowDelete onClick={() => del(i)} disabled={rows.length <= 1} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <AddRow onClick={add} disabled={rows.length >= MAX_ROWS}>
          + строка
        </AddRow>
      </div>
    </div>
  );
}
