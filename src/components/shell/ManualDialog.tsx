// «Деталь без чертежа» (ui-spec §2.16): прямоугольная пластина с круглыми отверстиями — быстрая прикидка.
// Enter — «Добавить», Ctrl/⌘+Enter — «Добавить и ещё» (окно остаётся, название очищается).
// Имя и количество приходят из «+ Добавить деталь» (строки заявки без чертежа).
import { useRef, useState, type FormEvent, type KeyboardEvent, type ReactElement } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button.tsx';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Kbd } from '@/components/ui/kbd.tsx';
import { isEditable } from '@/components/common/dom.ts';
import { MaterialSelect } from '@/components/common/MaterialSelect.tsx';
import { NumInput } from '@/components/common/NumInput.tsx';
import { ThicknessPicker } from '@/components/common/ThicknessPicker.tsx';
import { manualPosition } from '@/order.ts';
import { importDefaults } from '@/pipeline.ts';
import { addManualPosition, closeDialog } from '@/store/actions.ts';
import { ensureOrderPrices } from '@/store/pipelineActions.ts';
import { getState, useStore } from '@/store/store.ts';
import type { DialogState } from '@/store/types.ts';
import { MOD } from './useShortcuts.ts';

type Prefill = Extract<DialogState, { kind: 'manual' }>['prefill'];

interface Form {
  name: string;
  materialId: string;
  thickness: number;
  qty: number;
  width: number;
  height: number;
  holes: number;
  holeD: number;
  bends: number;
}

function initialForm(prefill: Prefill): Form {
  const d = importDefaults(getState().order.positions);
  return {
    name: prefill?.name ?? '',
    materialId: d.materialId,
    thickness: d.thickness,
    qty: prefill?.qty && prefill.qty > 0 ? Math.round(prefill.qty) : 1,
    width: 200,
    height: 100,
    holes: 0,
    holeD: 10,
    bends: 0,
  };
}

function ManualForm({ prefill }: { prefill: Prefill }): ReactElement {
  const [f, setF] = useState<Form>(() => initialForm(prefill));
  // последнее значение — сразу (Enter в числовом поле применяет его и тут же добавляет деталь)
  const latest = useRef(f);
  const nameRef = useRef<HTMLInputElement>(null);
  const set = (patch: Partial<Form>) => {
    latest.current = { ...latest.current, ...patch };
    setF(latest.current);
  };

  const add = (more: boolean) => {
    const v = latest.current;
    const p = manualPosition({ ...v, qty: Math.max(1, Math.round(v.qty)), holes: Math.max(0, Math.round(v.holes)), bends: Math.max(0, Math.round(v.bends)) });
    addManualPosition(p);
    ensureOrderPrices();
    if (more) {
      toast.success(`Добавлена деталь: ${p.name}`);
      set({ name: '' });
      nameRef.current?.focus();
    } else closeDialog();
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    add(false);
  };
  // Enter в поле — «Добавить»; Ctrl/⌘+Enter где угодно в форме — «Добавить и ещё».
  // Списки (материал, толщина) открываются в своих слоях — их Enter сюда не относится.
  const onKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing || !e.currentTarget.contains(e.target as Node)) return;
    const more = e.ctrlKey || e.metaKey;
    const field = (e.target as HTMLElement).tagName === 'INPUT';
    if (!more && !field) return;
    e.preventDefault();
    add(more);
  };

  const w = Math.round(f.width) || 0;
  const h = Math.round(f.height) || 0;
  return (
    <form onSubmit={onSubmit} onKeyDown={onKeyDown} className="flex flex-col gap-5">
      <FieldGroup className="gap-4">
        <Field>
          <FieldLabel htmlFor="manual-name">Название</FieldLabel>
          <Input id="manual-name" ref={nameRef} autoFocus value={f.name} placeholder={`Пластина ${w}×${h}`} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3">
          <Field>
            <FieldLabel>Материал</FieldLabel>
            <MaterialSelect value={f.materialId} onChange={(materialId) => set({ materialId })} className="w-full" />
          </Field>
          <Field>
            <FieldLabel>Толщина</FieldLabel>
            <ThicknessPicker materialId={f.materialId} value={f.thickness} onChange={(thickness) => set({ thickness })} className="min-w-28" />
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field>
            <FieldLabel>Ширина</FieldLabel>
            <NumInput aria-label="Ширина, мм" value={f.width} min={1} suffix="мм" onChange={(width) => set({ width })} />
          </Field>
          <Field>
            <FieldLabel>Длина</FieldLabel>
            <NumInput aria-label="Длина, мм" value={f.height} min={1} suffix="мм" onChange={(height) => set({ height })} />
          </Field>
          <Field>
            <FieldLabel>Кол-во</FieldLabel>
            <NumInput aria-label="Количество, шт" value={f.qty} min={1} suffix="шт" onChange={(qty) => set({ qty: Math.max(1, Math.round(qty)) })} />
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field>
            <FieldLabel>Отверстий</FieldLabel>
            <NumInput aria-label="Отверстий" value={f.holes} onChange={(holes) => set({ holes: Math.round(holes) })} />
          </Field>
          <Field>
            <FieldLabel>Ø отверстия</FieldLabel>
            <NumInput aria-label="Диаметр отверстия, мм" value={f.holeD} min={0.1} suffix="мм" onChange={(holeD) => set({ holeD })} />
          </Field>
          <Field>
            <FieldLabel>Гибов</FieldLabel>
            <NumInput aria-label="Гибов" value={f.bends} onChange={(bends) => set({ bends: Math.round(bends) })} />
          </Field>
        </div>
      </FieldGroup>
      <DialogFooter className="gap-2 sm:items-center">
        <Button type="button" variant="outline" onClick={closeDialog}>
          Отмена
        </Button>
        <Button type="button" variant="outline" onClick={() => add(true)}>
          Добавить и ещё
          <Kbd className="ml-1">{MOD} Enter</Kbd>
        </Button>
        <Button type="submit">
          Добавить
          <Kbd className="ml-1 bg-primary-foreground/15 text-primary-foreground">Enter</Kbd>
        </Button>
      </DialogFooter>
    </form>
  );
}

export function ManualDialog(): ReactElement | null {
  const dialog = useStore((s) => s.ui.dialog);
  if (dialog?.kind !== 'manual') return null;
  return (
    <Dialog open onOpenChange={(o) => !o && closeDialog()}>
      <DialogContent
        className="sm:max-w-lg"
        onEscapeKeyDown={(e) => {
          // Esc в поле — сначала вернуть значение и уйти из поля, следующий Esc закроет окно
          if (!isEditable(e.target)) return;
          e.preventDefault();
          const el = e.target as HTMLElement;
          setTimeout(() => el.blur(), 0);
        }}
      >
        <DialogHeader>
          <DialogTitle>Деталь без чертежа</DialogTitle>
          <DialogDescription>Прямоугольная пластина с круглыми отверстиями — для быстрой прикидки.</DialogDescription>
        </DialogHeader>
        <ManualForm key={JSON.stringify(dialog.prefill ?? null)} prefill={dialog.prefill} />
      </DialogContent>
    </Dialog>
  );
}
