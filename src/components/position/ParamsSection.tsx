// «Параметры» в карточке: материал, толщина, кол-во, гибы — с отметками ИИ и подписью, откуда значение.
import type { ReactElement, ReactNode } from 'react';
import type { AiChange, AiField } from '@/ai/apply.ts';
import type { AiSuggestion, AiSuggestionKind } from '@/core/ai.ts';
import { AiChangeBadge } from '@/components/ai/AiChangeBadge.tsx';
import { OfferChip } from '@/components/ai/OfferChip.tsx';
import { formatAiValue } from '@/components/common/aiFormat.ts';
import { MaterialSelect } from '@/components/common/MaterialSelect.tsx';
import { NumInput } from '@/components/common/NumInput.tsx';
import { ThicknessPicker } from '@/components/common/ThicknessPicker.tsx';
import type { OrderPosition } from '@/order.ts';
import { originOf } from '@/provenance.ts';
import { editPosition } from '@/store/actions.ts';
import { useStore } from '@/store/store.ts';
import { ProvenanceTag } from './ProvenanceTag.tsx';

const KIND: Record<'materialId' | 'thickness' | 'qty' | 'bends', AiSuggestionKind> = { materialId: 'material', thickness: 'thickness', qty: 'qty', bends: 'bends' };

/** Отметки ИИ у поля: «✦ ИИ» + «было …» или чипы предложений */
function Marks({ id, field, changes, offers }: { id: string; field: keyof typeof KIND; changes: AiChange[]; offers: AiSuggestion[] }): ReactElement | null {
  const ch = changes.filter((c) => c.field === field);
  const of = offers.filter((s) => s.kind === KIND[field]);
  if (!ch.length && !of.length) return null;
  return (
    <>
      {ch.map((c) => (
        <span key={c.suggestion.id} className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <AiChangeBadge change={c} positionId={id} />
          было {formatAiValue(c.field, c.from)}
        </span>
      ))}
      {of.map((s) => (
        <OfferChip key={s.id} suggestion={s} positionId={id} size="sm" />
      ))}
    </>
  );
}

function Row({ label, focusKey, htmlFor, children }: { label: string; focusKey: string; htmlFor?: string; children: ReactNode }): ReactElement {
  return (
    <>
      <label htmlFor={htmlFor} className="pt-1.5 text-sm text-muted-foreground">
        {label}
      </label>
      <div data-sheet-focus={focusKey} className="flex min-h-8 min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        {children}
      </div>
    </>
  );
}

export interface ParamsSectionProps {
  base: OrderPosition; // базовая (сюда пишутся правки)
  pos: OrderPosition; // с предложениями ИИ (что показывается)
  changes: AiChange[];
  offers: AiSuggestion[];
}

export function ParamsSection({ base, pos, changes, offers }: ParamsSectionProps): ReactElement {
  const requestLines = useStore((s) => s.order.requestLines) ?? [];
  const id = base.id;
  const has = (f: AiField) => changes.some((c) => c.field === f);
  return (
    <section aria-labelledby="params-h" className="space-y-3">
      <h3 id="params-h" className="text-sm font-semibold">
        Параметры
      </h3>
      <div className="grid grid-cols-[110px_1fr] items-start gap-x-3 gap-y-2.5">
        <Row label="Материал" focusKey="material">
          <MaterialSelect
            value={pos.materialId}
            guessed={pos.guessed.material}
            ai={has('materialId')}
            onChange={(materialId) => editPosition(id, { materialId })}
            className="w-56"
          />
          <Marks id={id} field="materialId" changes={changes} offers={offers} />
          <ProvenanceTag origin={originOf(base, 'material', changes, requestLines)} />
        </Row>
        <Row label="Толщина" focusKey="thickness">
          <ThicknessPicker
            materialId={pos.materialId}
            value={pos.thickness}
            guessed={pos.guessed.thickness}
            ai={has('thickness')}
            onChange={(thickness) => editPosition(id, { thickness })}
            className="w-28"
          />
          <Marks id={id} field="thickness" changes={changes} offers={offers} />
          <ProvenanceTag origin={originOf(base, 'thickness', changes, requestLines)} />
        </Row>
        <Row label="Кол-во" focusKey="qty">
          <NumInput
            value={pos.qty}
            min={1}
            suffix="шт"
            guessed={pos.guessed.qty}
            ai={has('qty')}
            onChange={(v) => editPosition(id, { qty: Math.max(1, Math.round(v)) })}
            aria-label="Количество, шт"
            className="w-28"
          />
          <Marks id={id} field="qty" changes={changes} offers={offers} />
          <ProvenanceTag origin={originOf(base, 'qty', changes, requestLines)} />
        </Row>
        <Row label="Гибы" focusKey="bends">
          <NumInput
            value={pos.bends}
            ai={has('bends')}
            onChange={(v) => editPosition(id, { bends: Math.round(v) })}
            aria-label="Гибов на 1 шт"
            className="w-16"
          />
          <span aria-hidden className="text-muted-foreground">
            ×
          </span>
          <NumInput value={pos.bendLength} suffix="мм" onChange={(v) => editPosition(id, { bendLength: v })} aria-label="Длина гиба, мм" className="w-28" />
          <Marks id={id} field="bends" changes={changes} offers={offers} />
          <span className="text-xs text-muted-foreground">линий гиба в файле: {pos.detectedBends}</span>
        </Row>
      </div>
    </section>
  );
}
