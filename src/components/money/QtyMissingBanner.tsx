// Количество не найдено ни в файлах, ни в заявке — расчёт сделан по 1 шт, и итог неверен в разы.
// Плашка над итогом: сколько позиций без количества, поля, чтобы вписать его сразу, и «Вставить заявку».
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { NumInput } from '@/components/common/NumInput.tsx';
import { TriangleAlert } from '@/components/common/icons.ts';
import { plural } from '@/format.ts';
import { editPosition, openSheet } from '@/store/actions.ts';
import { useDerived } from '@/store/derived.tsx';

const SHOWN = 8;

export function QtyMissingBanner(): ReactElement | null {
  // позиции с правками ИИ: количество, проставленное ИИ по заявке, уже не «не найдено»
  const positions = useDerived().positions;
  const missing = positions.filter((p) => !p.disabled && p.guessed.qty);
  if (!missing.length) return null;
  const n = missing.length;
  const all = n === positions.filter((p) => !p.disabled).length;
  return (
    <section
      aria-label="Количество не указано"
      className="no-print flex flex-col gap-3 rounded-xl border border-warn/50 bg-warn-soft p-4 text-sm text-foreground"
    >
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <TriangleAlert aria-hidden className="mt-0.5 size-5 shrink-0 text-warn" />
        <div className="min-w-0 flex-1">
          <div className="font-semibold">
            {all ? 'Количество не указано' : `Количество не найдено у ${n} ${plural(n, 'позиции', 'позиций', 'позиций')}`} — посчитано по 1 шт
          </div>
          <div className="text-muted-foreground">
            В именах файлов и в заявке его нет, поэтому себестоимость и цена клиенту сейчас занижены. Вставьте заявку клиента или впишите количество ниже.
          </div>
        </div>
        <Button size="sm" onClick={() => openSheet({ kind: 'request', section: 'request' })}>
          Вставить заявку
        </Button>
      </div>
      <div className="grid gap-x-6 gap-y-2 pl-8 sm:grid-cols-2 xl:grid-cols-3">
        {missing.slice(0, SHOWN).map((p) => (
          <label key={p.id} className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate" title={p.name}>
              {p.name}
            </span>
            <NumInput
              size="sm"
              value={p.qty}
              min={1}
              guessed
              onChange={(qty) => editPosition(p.id, { qty: Math.max(1, Math.round(qty)) })}
              aria-label={`Количество, шт: ${p.name}`}
              suffix="шт"
              className="w-24"
            />
          </label>
        ))}
      </div>
      {n > SHOWN && <div className="pl-8 text-muted-foreground">…и ещё {n - SHOWN} — в таблице позиций, поля подсвечены</div>}
    </section>
  );
}
