// Вкладка «Металл и раскрой» (ui-spec §2.11, перенесено из SheetsSection): сводка по материалам и группы
// «материал + толщина» с выбором листа, своей ценой, списанием и листами раскроя.
import type { ReactElement } from 'react';
import { useDerived } from '@/store/derived.tsx';
import { GroupCard } from './GroupCard.tsx';
import { MaterialSummary } from './MaterialSummary.tsx';

export function MetalTab(): ReactElement {
  const { res, byId } = useDerived();
  if (!res.groups.length) {
    return <p className="py-6 text-sm text-muted-foreground">Нет позиций в расчёте — включите позиции или добавьте чертежи.</p>;
  }
  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-4xl text-xs text-muted-foreground">
        Детали одного материала и толщины укладываются на листы по габаритам (оценка сверху — реальный раскрой по контуру плотнее). Стоимость металла группы делится
        между деталями пропорционально габаритной площади.
      </p>
      <MaterialSummary res={res} />
      <div className="grid gap-4 2xl:grid-cols-2">
        {res.groups.map((g) => (
          <GroupCard key={g.key} g={g} res={res} byId={byId} />
        ))}
      </div>
    </div>
  );
}
