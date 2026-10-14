import { useState } from 'react';
import { MATERIALS, getMaterial } from '../core/materials.ts';
import { n1 } from '../format.ts';
import { manualPosition, type OrderPosition } from '../order.ts';
import { NumInput } from './NumInput.tsx';

interface Props {
  defaults: { materialId: string; thickness: number };
  onAdd: (p: OrderPosition) => void;
  onClose: () => void;
}

/** Деталь без DXF: прямоугольная пластина с круглыми отверстиями */
export function ManualDialog({ defaults, onAdd, onClose }: Props) {
  const [f, setF] = useState({ name: '', materialId: defaults.materialId, thickness: defaults.thickness, qty: 1, width: 200, height: 100, holes: 0, holeD: 10, bends: 0 });
  const set = (patch: Partial<typeof f>) => setF((x) => ({ ...x, ...patch }));
  const mat = getMaterial(f.materialId);
  return (
    <div className="drawer-backdrop center" onClick={onClose}>
      <form
        className="dialog"
        role="dialog"
        aria-label="Деталь вручную"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          onAdd(manualPosition(f));
          onClose();
        }}
      >
        <h2>Деталь без чертежа</h2>
        <p className="small muted">Прямоугольная пластина с круглыми отверстиями — для быстрой прикидки.</p>
        <label className="field">
          <span>Название</span>
          <input value={f.name} placeholder={`Пластина ${f.width}×${f.height}`} onChange={(e) => set({ name: e.target.value })} autoFocus />
        </label>
        <div className="field-row">
          <label className="field">
            <span>Материал</span>
            <select value={f.materialId} onChange={(e) => set({ materialId: e.target.value })}>
              {MATERIALS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Толщина</span>
            <select value={String(f.thickness)} onChange={(e) => set({ thickness: Number(e.target.value) })}>
              {[...new Set([...mat.thicknesses, f.thickness])]
                .sort((a, b) => a - b)
                .map((t) => (
                  <option key={t} value={String(t)}>
                    {n1(t)} мм
                  </option>
                ))}
            </select>
          </label>
        </div>
        <div className="field-row">
          <label className="field">
            <span>Ширина</span>
            <NumInput value={f.width} suffix="мм" width={70} onChange={(v) => set({ width: v })} />
          </label>
          <label className="field">
            <span>Длина</span>
            <NumInput value={f.height} suffix="мм" width={70} onChange={(v) => set({ height: v })} />
          </label>
          <label className="field">
            <span>Кол-во</span>
            <NumInput value={f.qty} min={1} suffix="шт" width={60} onChange={(v) => set({ qty: Math.max(1, Math.round(v)) })} />
          </label>
        </div>
        <div className="field-row">
          <label className="field">
            <span>Отверстий</span>
            <NumInput value={f.holes} width={50} onChange={(v) => set({ holes: Math.round(v) })} />
          </label>
          <label className="field">
            <span>Ø отверстия</span>
            <NumInput value={f.holeD} suffix="мм" width={60} onChange={(v) => set({ holeD: v })} />
          </label>
          <label className="field">
            <span>Гибов</span>
            <NumInput value={f.bends} width={50} onChange={(v) => set({ bends: Math.round(v) })} />
          </label>
        </div>
        <footer className="dialog-f">
          <button type="button" className="btn" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" className="btn primary">
            Добавить
          </button>
        </footer>
      </form>
    </div>
  );
}
