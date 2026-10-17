// «Доп. операции»: справочные ставки (покраска, резьба, сварка…). По ним ИИ оценивает доп. работы,
// отсюда же пресеты в карточке позиции. Строки можно добавлять, удалять и переставлять.
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.tsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.tsx';
import { ChevronDown, ChevronUp } from '@/components/common/icons.ts';
import { NumInput } from '@/components/common/NumInput.tsx';
import type { ExtraRate } from '@/core/pricing.ts';
import { patchSettings } from '@/store/actions.ts';
import { useStore } from '@/store/store.ts';
import { AddRow, Hint, MAX_ROWS, moveRow, patchRow, removeRow, RowDelete, rowKey, TD, TextField, TH, useRowFocus } from './shared.tsx';

const UNITS: readonly string[] = ['м²', 'отв.', 'м шва', 'м', 'кг', 'шт'];

/** Кнопка перестановки: при крайней строке не выключается совсем (фокус не теряется), а просто ничего не делает */
function MoveButton({ dir, edge, label, onMove }: { dir: -1 | 1; edge: boolean; label: string; onMove: () => void }): ReactElement {
  const Icon = dir < 0 ? ChevronUp : ChevronDown;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      title={label}
      aria-disabled={edge || undefined}
      onClick={() => !edge && onMove()}
      className="text-muted-foreground aria-disabled:cursor-default aria-disabled:opacity-35 aria-disabled:hover:bg-transparent pointer-coarse:size-9"
    >
      <Icon />
    </Button>
  );
}

export function ExtraOpsTab(): ReactElement {
  const rows = useStore((s) => s.settings.extraRates);
  const focus = useRowFocus();
  const set = (extraRates: ExtraRate[]) => patchSettings({ extraRates });
  const edit = (i: number, patch: Partial<ExtraRate>) => set(patchRow(rows, i, patch));

  const add = () => {
    set([...rows, { label: '', unit: 'шт', price: 0 }]);
    focus.afterAdd('set-op-label', rows.length);
  };
  const del = (i: number) => {
    set(removeRow(rows, i));
    focus.afterDelete(i);
  };

  return (
    <div ref={focus.ref} className="flex flex-col items-start gap-3">
      <Hint>По этим ставкам ИИ считает доп. работы, ₽ с НДС. Пресеты в карточке позиции — отсюда же.</Hint>
      <div className="w-full rounded-lg border">
        <Table className="min-w-[600px] table-fixed text-[13px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className={TH}>Операция</TableHead>
              <TableHead className={`${TH} w-24`}>Ед.</TableHead>
              <TableHead className={`${TH} w-24 text-right`}>₽ за ед.</TableHead>
              <TableHead className={`${TH} w-[26%]`}>Примечание</TableHead>
              <TableHead className="w-[5.5rem] px-1">
                <span className="sr-only">Порядок и удаление</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => {
              const name = r.label || `строка ${i + 1}`;
              const units = UNITS.includes(r.unit) || !r.unit ? UNITS : [...UNITS, r.unit];
              return (
                <TableRow key={rowKey(r)}>
                  <TableCell className={TD}>
                    <TextField
                      size="sm"
                      value={r.label}
                      onCommit={(label) => edit(i, { label })}
                      aria-label={`Операция, строка ${i + 1}`}
                      placeholder="Название операции"
                      maxLength={200}
                      invalid={!r.label}
                      navCol="set-op-label"
                      navRow={i}
                    />
                  </TableCell>
                  <TableCell className={TD}>
                    <Select value={r.unit} onValueChange={(unit) => unit !== r.unit && edit(i, { unit })}>
                      <SelectTrigger size="sm" aria-label={`Единица: ${name}`} className="w-full text-[13px] pointer-coarse:data-[size=sm]:h-9">
                        <SelectValue placeholder="—" />
                      </SelectTrigger>
                      <SelectContent position="popper" align="start">
                        {units.map((u) => (
                          <SelectItem key={u} value={u}>
                            {u}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell className={TD}>
                    <NumInput
                      size="sm"
                      value={r.price}
                      max={1_000_000}
                      onChange={(price) => edit(i, { price })}
                      aria-label={`₽ за ед.: ${name}`}
                      navCol="set-op-price"
                      navRow={i}
                      className="w-full"
                    />
                  </TableCell>
                  <TableCell className={TD}>
                    <TextField
                      size="sm"
                      value={r.note ?? ''}
                      onCommit={(note) => edit(i, { note: note || undefined })} // пустое — без примечания
                      aria-label={`Примечание: ${name}`}
                      maxLength={500}
                      navCol="set-op-note"
                      navRow={i}
                    />
                  </TableCell>
                  <TableCell className="px-1 py-1">
                    <div className="flex items-center justify-end gap-0.5">
                      <MoveButton dir={-1} edge={i === 0} label="Выше" onMove={() => set(moveRow(rows, i, -1))} />
                      <MoveButton dir={1} edge={i === rows.length - 1} label="Ниже" onMove={() => set(moveRow(rows, i, 1))} />
                      <RowDelete onClick={() => del(i)} />
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
            {!rows.length && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="px-3 py-6 text-center whitespace-normal text-muted-foreground">
                  Ставок нет — ИИ не сможет оценить доп. работы в рублях.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <AddRow onClick={add} disabled={rows.length >= MAX_ROWS}>
        + операция
      </AddRow>
    </div>
  );
}
