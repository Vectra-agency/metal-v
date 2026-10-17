// «Раскрой и НДС»: перемычка и поле листа, потолки отхода, отход «по габариту», ставка НДС.
import type { ReactElement } from 'react';
import { patchSettings } from '@/store/actions.ts';
import { useStore } from '@/store/store.ts';
import { NumField } from './shared.tsx';

export function NestingTab(): ReactElement {
  const gap = useStore((s) => s.settings.gap);
  const margin = useStore((s) => s.settings.margin);
  const maxWaste = useStore((s) => s.settings.maxWastePct);
  const maxWasteWhole = useStore((s) => s.settings.maxWasteWholePct ?? 100);
  const bboxWaste = useStore((s) => s.settings.bboxWastePct);
  const vat = useStore((s) => s.settings.vatPct);

  return (
    <div className="flex max-w-xl flex-col gap-5">
      <div className="flex flex-col gap-4">
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
