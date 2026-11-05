// «Резка»: прайс на лазерную резку — ₽ за погонный метр реза по толщине и колонке материала.
// Толщина без своей строки считается по ближайшей большей строке; пустая ячейка — такой резки в прайсе нет.
import { useRef, type ReactElement } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button.tsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.tsx';
import { NumInput } from '@/components/common/NumInput.tsx';
import { parseCutPriceCsv } from '@/core/cutPrice.ts';
import { CUT_GROUPS, type CutRow } from '@/core/pricing.ts';
import { n1 } from '@/format.ts';
import { patchSettings } from '@/store/actions.ts';
import { getState, useStore } from '@/store/store.ts';
import { undoToast } from '@/store/undo.ts';
import { AddRow, Hint, MAX_ROWS, patchRow, removeRow, RowDelete, rowKey, sortRows, TD, TDN, TH, useRowFocus } from './shared.tsx';

/** Подпись строки как в прайсе: первая — «до 0,5», дальше «0,6–1», «2»… */
function rowLabel(rows: readonly CutRow[], i: number): string {
  const prev = rows[i - 1];
  if (!prev) return `до ${n1(rows[i].t)}`;
  return rows[i].t - prev.t > 1 + 1e-9 ? `${n1(prev.t)}–${n1(rows[i].t)}` : n1(rows[i].t);
}

export function CuttingTab(): ReactElement {
  const rows = useStore((s) => s.settings.cutting);
  const focus = useRowFocus();
  const file = useRef<HTMLInputElement>(null);
  const set = (cutting: CutRow[]) => patchSettings({ cutting });
  // новая толщина — строка встаёт на своё место
  const edit = (i: number, patch: Partial<CutRow>) => set(patch.t == null ? patchRow(rows, i, patch) : sortRows(patchRow(rows, i, patch), (r) => r.t));

  const add = () => {
    const last = rows.at(-1);
    set([...rows, { t: (last?.t ?? 0) + 1, steel: last?.steel ?? null, stainless: last?.stainless ?? null, aluminum: last?.aluminum ?? null, copper: last?.copper ?? null }]);
    focus.afterAdd('set-cut-t', rows.length);
  };
  const del = (i: number) => {
    set(removeRow(rows, i));
    focus.afterDelete(i);
  };

  const importCsv = async (f: File) => {
    try {
      const { rows: next } = parseCutPriceCsv(await f.text());
      const prev = getState().settings.cutting;
      set(next);
      undoToast({ message: `Прайс резки загружен: ${next.length} строк из «${f.name}»`, undo: () => set(prev) });
    } catch (e) {
      toast.error(`Не удалось прочитать прайс: ${(e as Error).message}`);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Hint>
        Цена за погонный метр реза по прайсу, ₽. Врезки отдельно не оплачиваются. Толщина без своей строки считается по ближайшей большей (1,5 мм — по строке
        «2 мм»). Пустая ячейка — такой резки в прайсе нет: позиция получит предупреждение. Какой материал в какой колонке — на вкладке «Материалы».
      </Hint>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => file.current?.click()}>
          Загрузить прайс из CSV…
        </Button>
        <span className="text-xs text-muted-foreground">колонки: толщина, сталь чёрная, нерж., алюминий, медь/латунь</span>
        <input
          ref={file}
          type="file"
          accept=".csv,text/csv"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void importCsv(f);
            e.target.value = '';
          }}
        />
      </div>
      <div ref={focus.ref} className="flex flex-col items-start gap-3">
        <div className="w-full overflow-x-auto rounded-lg border">
          <Table className="min-w-[560px] text-[13px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className={TH}>Толщина до, мм</TableHead>
                {CUT_GROUPS.map((g) => (
                  <TableHead key={g.key} className={`${TH} text-right`}>
                    {g.label}
                  </TableHead>
                ))}
                <TableHead className="w-9 px-1">
                  <span className="sr-only">Удалить</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r, i) => (
                <TableRow key={rowKey(r)}>
                  <TableCell className={TD}>
                    <div className="flex items-center gap-2">
                      <NumInput
                        size="sm"
                        value={r.t}
                        min={0.1}
                        max={100}
                        onChange={(t) => edit(i, { t })}
                        aria-label={`Толщина до, мм, строка ${i + 1}`}
                        navCol="set-cut-t"
                        navRow={i}
                        className="w-16"
                      />
                      <span className="text-xs whitespace-nowrap text-muted-foreground">{rowLabel(rows, i)} мм</span>
                    </div>
                  </TableCell>
                  {CUT_GROUPS.map((g) => (
                    <TableCell key={g.key} className={TDN}>
                      <NumInput
                        size="sm"
                        value={r[g.key] ?? 0}
                        allowEmpty
                        placeholder="—"
                        onChange={(v) => edit(i, { [g.key]: v > 0 ? v : null } as Partial<CutRow>)}
                        aria-label={`${g.label}, ₽ за метр реза, до ${n1(r.t)} мм`}
                        navCol={`set-cut-${g.key}`}
                        navRow={i}
                        suffix="₽/м"
                        className="w-24"
                      />
                    </TableCell>
                  ))}
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
