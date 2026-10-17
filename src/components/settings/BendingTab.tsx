// «Гибка»: ₽ за гиб по толщинам, множитель по длине гиба, наладка листогиба на позицию.
import type { ReactElement } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.tsx';
import { NumInput } from '@/components/common/NumInput.tsx';
import type { BendLenRow, BendRow } from '@/core/pricing.ts';
import { n1 } from '@/format.ts';
import { patchSettings } from '@/store/actions.ts';
import { useStore } from '@/store/store.ts';
import { AddRow, Hint, MAX_ROWS, NumField, patchRow, removeRow, RowDelete, rowKey, sortRows, TD, TDN, TH, useRowFocus } from './shared.tsx';

export function BendingTab(): ReactElement {
  const rows = useStore((s) => s.settings.bending);
  const lenK = useStore((s) => s.settings.bendLenK);
  const setup = useStore((s) => s.settings.bendSetup);
  const focus = useRowFocus();
  const set = (bending: BendRow[]) => patchSettings({ bending });
  // новая толщина или длина — строка встаёт на своё место
  const edit = (i: number, patch: Partial<BendRow>) => set(patch.t == null ? patchRow(rows, i, patch) : sortRows(patchRow(rows, i, patch), (r) => r.t));
  const editK = (i: number, patch: Partial<BendLenRow>) =>
    patchSettings({ bendLenK: patch.upTo == null ? patchRow(lenK, i, patch) : sortRows(patchRow(lenK, i, patch), (r) => r.upTo) });

  const add = () => {
    const last = rows.at(-1);
    set([...rows, { t: (last?.t ?? 0) + 2, perBend: last?.perBend ?? 100 }]);
    focus.afterAdd('set-bend-t', rows.length);
  };
  const del = (i: number) => {
    set(removeRow(rows, i));
    focus.afterDelete(i);
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Hint>Цена одного гиба длиной до 1 м. Для других длин — множитель из второй таблицы.</Hint>
        <div className="grid items-start gap-6 sm:grid-cols-2">
          <div ref={focus.ref} className="flex flex-col items-start gap-3">
            <div className="w-full rounded-lg border">
              <Table className="text-[13px]">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className={TH}>Толщина, мм</TableHead>
                    <TableHead className={`${TH} text-right`}>₽ за гиб</TableHead>
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
                          navCol="set-bend-t"
                          navRow={i}
                          className="w-20"
                        />
                      </TableCell>
                      <TableCell className={TDN}>
                        <NumInput
                          size="sm"
                          value={r.perBend}
                          onChange={(perBend) => edit(i, { perBend })}
                          aria-label={`₽ за гиб, ${n1(r.t)} мм`}
                          navCol="set-bend-perBend"
                          navRow={i}
                          className="w-24"
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

          <section aria-labelledby="set-bend-len" className="flex flex-col gap-2">
            <h3 id="set-bend-len" className="text-sm font-medium">
              Множитель по длине гиба
            </h3>
            <div className="w-full rounded-lg border">
              <Table className="text-[13px]">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className={TH}>Длина до, мм</TableHead>
                    <TableHead className={`${TH} text-right`}>Множитель</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lenK.map((r, i) => (
                    <TableRow key={rowKey(r)}>
                      <TableCell className={TD}>
                        <NumInput
                          size="sm"
                          value={r.upTo}
                          min={1}
                          onChange={(upTo) => editK(i, { upTo })}
                          aria-label={`Длина до, мм, строка ${i + 1}`}
                          navCol="set-blk-upTo"
                          navRow={i}
                          className="w-24"
                        />
                      </TableCell>
                      <TableCell className={TDN}>
                        <NumInput
                          size="sm"
                          value={r.k}
                          onChange={(k) => editK(i, { k })}
                          aria-label={`Множитель для гиба до ${r.upTo} мм`}
                          navCol="set-blk-k"
                          navRow={i}
                          className="w-20"
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>
        </div>
      </div>

      <div className="max-w-xl border-t pt-5">
        <NumField
          label="Наладка листогиба на позицию"
          hint="Наладка делится на количество деталей в позиции — заметна на малых партиях."
          value={setup}
          suffix="₽"
          onChange={(bendSetup) => patchSettings({ bendSetup })}
        />
      </div>
    </div>
  );
}
