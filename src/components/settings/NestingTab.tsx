// «Раскрой и НДС»: листы металла по толщинам (рулон / лист), перемычка и поле листа, потолки отхода,
// отход «по габариту», ставка НДС.
import type { ReactElement } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.tsx';
import { NumInput } from '@/components/common/NumInput.tsx';
import { normalizeSheetRules, type SheetRule } from '@/core/pricing.ts';
import { n1 } from '@/format.ts';
import { patchSettings } from '@/store/actions.ts';
import { useStore } from '@/store/store.ts';
import { AddRow, Hint, MAX_ROWS, NumField, patchRow, removeRow, RowDelete, rowKey, sortRows, TD, TDN, TH, useRowFocus } from './shared.tsx';

/** «Листы металла»: под какую толщину какой лист берём; длина пустая — рулон. Последняя строка — «толще» */
function SheetRules(): ReactElement {
  const stored = useStore((s) => s.settings.sheetRules);
  const rules = Array.isArray(stored) && stored.length ? stored : normalizeSheetRules(stored);
  const focus = useRowFocus();
  const set = (sheetRules: SheetRule[]) => patchSettings({ sheetRules });
  // «толще» (upTo = null) — всегда последняя; новая толщина — строка встаёт на своё место
  const byT = (rows: SheetRule[]) => sortRows(rows, (r) => r.upTo ?? Infinity);
  const edit = (i: number, patch: Partial<SheetRule>) => set(patch.upTo === undefined ? patchRow(rules, i, patch) : byT(patchRow(rules, i, patch)));
  const add = () => {
    const bounded = rules.filter((r) => r.upTo != null);
    const upTo = (bounded.at(-1)?.upTo ?? 0) + 1;
    set(byT([...rules, { upTo, w: 1500, l: 3000 }]));
    focus.afterAdd('set-sheet-upTo', bounded.length);
  };
  const del = (i: number) => {
    let next = removeRow(rules, i);
    if (!next.some((r) => r.upTo == null)) next = patchRow(next, next.length - 1, { upTo: null }); // удалили «толще» — им становится последняя
    set(next);
    focus.afterDelete(i);
  };

  return (
    <section aria-labelledby="set-sheet-rules" className="flex flex-col gap-3">
      <h3 id="set-sheet-rules" className="text-sm font-medium">
        Листы металла
      </h3>
      <Hint>
        Какой лист берём под толщину — для всех материалов. Длина пустая — рулон: металл считается по длине размотки на всю ширину рулона. Лист группы можно сменить на
        вкладке «Металл и раскрой».
      </Hint>
      <div ref={focus.ref} className="flex flex-col items-start gap-3">
        <div className="w-full rounded-lg border">
          <Table className="text-[13px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className={TH}>Толщина до, мм</TableHead>
                <TableHead className={`${TH} text-right`}>Ширина, мм</TableHead>
                <TableHead className={`${TH} text-right`}>Длина, мм</TableHead>
                <TableHead className="w-9 px-1">
                  <span className="sr-only">Удалить</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.map((r, i) => {
                const prev = rules[i - 1]?.upTo;
                const what = r.upTo == null ? (prev != null ? `толще ${n1(prev)} мм` : 'все толщины') : `до ${n1(r.upTo)} мм`;
                return (
                  <TableRow key={rowKey(r)}>
                    <TableCell className={TD}>
                      {r.upTo == null ? (
                        <span className="text-muted-foreground">{what}</span>
                      ) : (
                        <NumInput
                          size="sm"
                          value={r.upTo}
                          min={0.1}
                          max={100}
                          onChange={(upTo) => edit(i, { upTo })}
                          aria-label={`Толщина до, мм, строка ${i + 1}`}
                          navCol="set-sheet-upTo"
                          navRow={i}
                          className="w-20"
                        />
                      )}
                    </TableCell>
                    <TableCell className={TDN}>
                      <NumInput
                        size="sm"
                        value={r.w}
                        min={100}
                        max={5000}
                        onChange={(w) => edit(i, { w })}
                        aria-label={`Ширина листа, мм, ${what}`}
                        navCol="set-sheet-w"
                        navRow={i}
                        className="w-24"
                      />
                    </TableCell>
                    <TableCell className={TDN}>
                      <NumInput
                        size="sm"
                        value={r.l ?? 0}
                        allowEmpty
                        placeholder="рулон"
                        max={20000}
                        onChange={(l) => edit(i, { l: l > 0 ? l : null })}
                        aria-label={`Длина листа, мм (пусто — рулон), ${what}`}
                        navCol="set-sheet-l"
                        navRow={i}
                        className="w-24"
                      />
                    </TableCell>
                    <TableCell className="px-1 py-1 text-right">
                      <RowDelete onClick={() => del(i)} disabled={rules.length <= 1} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        <AddRow onClick={add} disabled={rules.length >= MAX_ROWS}>
          + толщина
        </AddRow>
      </div>
    </section>
  );
}

export function NestingTab(): ReactElement {
  const gap = useStore((s) => s.settings.gap);
  const margin = useStore((s) => s.settings.margin);
  const maxWaste = useStore((s) => s.settings.maxWastePct);
  const maxWasteWhole = useStore((s) => s.settings.maxWasteWholePct ?? 100);
  const bboxWaste = useStore((s) => s.settings.bboxWastePct);
  const vat = useStore((s) => s.settings.vatPct);

  return (
    <div className="flex max-w-xl flex-col gap-5">
      <SheetRules />
      <div className="flex flex-col gap-4 border-t pt-5">
        <NumField label="Перемычка между деталями" value={gap} suffix="мм" max={100} onChange={(v) => patchSettings({ gap: v })} />
        <NumField label="Поле по краю листа" value={margin} suffix="мм" max={200} onChange={(v) => patchSettings({ margin: v })} />
      </div>
      <div className="flex flex-col gap-4 border-t pt-5">
        <NumField
          label="Потолок отхода при раскрое"
          hint="Металл по раскрою не дороже, чем габаритная масса заготовок плюс этот процент: неудобные детали цех докладывает к чужим заказам."
          value={maxWaste}
          suffix="%"
          max={1000}
          onChange={(v) => patchSettings({ maxWastePct: v })}
        />
        <NumField
          label="Потолок отхода «целыми листами»"
          hint="Чтобы одна мелкая деталь из нержавейки или алюминия не оплачивала весь лист."
          value={maxWasteWhole}
          suffix="%"
          max={1000}
          onChange={(v) => patchSettings({ maxWasteWholePct: v })}
        />
        <NumField
          label="Отход при списании «по габариту»"
          value={bboxWaste}
          suffix="%"
          max={1000}
          onChange={(v) => patchSettings({ bboxWastePct: v })}
        />
      </div>
      <div className="border-t pt-5">
        <NumField label="Ставка НДС (цены уже с НДС)" value={vat} suffix="%" max={100} onChange={(v) => patchSettings({ vatPct: v })} />
      </div>
    </div>
  );
}
