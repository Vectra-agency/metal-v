// «Материалы»: множители к резке и гибке, как цех списывает лист (по раскрою / целыми листами / по габариту).
import type { ReactElement } from 'react';
import { cn } from '@/lib/utils.ts';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.tsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.tsx';
import { NumInput } from '@/components/common/NumInput.tsx';
import { MATERIALS, type Material, type SheetPolicy } from '@/core/materials.ts';
import { CUT_GROUPS } from '@/core/pricing.ts';
import { n0 } from '@/format.ts';
import { useMediaQuery } from '@/hooks/useMediaQuery.ts';
import { patchSettings, setPolicy } from '@/store/actions.ts';
import { useStore } from '@/store/store.ts';
import { TD, TDN, TH } from './shared.tsx';

const POLICY: readonly [SheetPolicy, string][] = [
  ['length', 'по раскрою'],
  ['whole', 'целыми листами'],
  ['bbox', 'по габариту + отход'],
];

function PolicySelect({ mt, value, className }: { mt: Material; value: SheetPolicy; className?: string }): ReactElement {
  return (
    <Select value={value} onValueChange={(v) => setPolicy(mt.id, v as SheetPolicy)}>
      <SelectTrigger size="sm" aria-label={`Списание металла: ${mt.label}`} className={cn('text-[13px] pointer-coarse:data-[size=sm]:h-9', className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper" align="start">
        {POLICY.map(([v, l]) => (
          <SelectItem key={v} value={v}>
            {l}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function MaterialsTab(): ReactElement {
  const matK = useStore((s) => s.settings.matK);
  const policy = useStore((s) => s.settings.policy);
  // узкий экран: списание — под названием материала, чтобы таблица не уезжала вбок
  const wide = useMediaQuery('(min-width: 640px)');
  const setK = (id: string, patch: { cutK?: number; bendK?: number }) => patchSettings({ matK: { ...matK, [id]: { ...matK[id], ...patch } } });

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border">
        <Table className="text-[13px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className={TH}>Материал</TableHead>
              <TableHead className={TH} title="Колонка прайса на резку (вкладка «Резка»)">
                Резка по прайсу
              </TableHead>
              <TableHead className={`${TH} text-right`} title="Множитель к цене гиба">
                k гибки
              </TableHead>
              {wide && <TableHead className={TH}>Списание металла</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {MATERIALS.map((mt, i) => (
              <TableRow key={mt.id}>
                <TableCell className={`${TD} whitespace-normal`}>
                  <div className="font-medium">{mt.label}</div>
                  <div className="text-xs text-muted-foreground tabular-nums">{n0(mt.density)} кг/м³</div>
                  {!wide && <PolicySelect mt={mt} value={policy[mt.id] ?? mt.policy} className="mt-1.5 w-full" />}
                </TableCell>
                <TableCell className={TD}>
                  <div className="flex items-center gap-2">
                    <span className="min-w-24 text-muted-foreground">{CUT_GROUPS.find((g) => g.key === mt.cutGroup)?.label.toLowerCase()}</span>
                    <NumInput
                      size="sm"
                      value={matK[mt.id]?.cutK ?? mt.cutK}
                      onChange={(cutK) => setK(mt.id, { cutK })}
                      aria-label={`Коэффициент к прайсу резки: ${mt.label}`}
                      title="Множитель к цене резки и врезок по прайсу"
                      navCol="set-mat-cutK"
                      navRow={i}
                      suffix="×"
                      className="w-16"
                    />
                  </div>
                </TableCell>
                <TableCell className={TDN}>
                  <NumInput
                    size="sm"
                    value={matK[mt.id]?.bendK ?? mt.bendK}
                    onChange={(bendK) => setK(mt.id, { bendK })}
                    aria-label={`k гибки (множитель к цене гиба): ${mt.label}`}
                    navCol="set-mat-bendK"
                    navRow={i}
                    className="w-16"
                  />
                </TableCell>
                {wide && (
                  <TableCell className={TD}>
                    <PolicySelect mt={mt} value={policy[mt.id] ?? mt.policy} className="w-44" />
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ul className="flex list-disc flex-col gap-1 pl-5 text-sm leading-normal text-muted-foreground marker:text-border">
        <li>
          <b className="font-medium text-foreground">По раскрою</b> — полные листы плюс занятая часть последнего (остаток остаётся у цеха).
        </li>
        <li>
          <b className="font-medium text-foreground">Целыми листами</b> — каждый начатый лист оплачивается полностью (нержавейка, алюминий).
        </li>
        <li>
          <b className="font-medium text-foreground">По габариту</b> — масса габаритных заготовок плюс процент отхода, без раскладки.
        </li>
      </ul>
    </div>
  );
}
