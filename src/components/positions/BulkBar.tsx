// Панель массовой правки выбранных позиций (снизу по центру): материал, толщина, гибы, кол-во, включить/исключить,
// принять предложения ИИ, удалить (сразу, с «Вернуть»). На телефоне скрыта.
import { useState, type ReactElement } from 'react';
import { pendingOffers } from '@/ai/apply.ts';
import { Button } from '@/components/ui/button.tsx';
import { Separator } from '@/components/ui/separator.tsx';
import { MaterialSelect } from '@/components/common/MaterialSelect.tsx';
import { NumInput } from '@/components/common/NumInput.tsx';
import { ThicknessPicker } from '@/components/common/ThicknessPicker.tsx';
import { Sparkles, Trash2, X } from '@/components/common/icons.ts';
import { cn } from '@/lib/utils.ts';
import { bulkEdit, clearSelection, removePositions } from '@/store/actions.ts';
import { acceptSuggestions } from '@/store/aiActions.ts';
import { useStore } from '@/store/store.ts';
import { livePositions } from './rowModel.ts';

function Label({ children }: { children: string }): ReactElement {
  return <span className="text-xs text-muted-foreground">{children}</span>;
}

function Bar({ ids }: { ids: string[] }): ReactElement {
  const order = useStore((s) => s.order);
  const live = livePositions(order.positions, order.ai);
  const set = new Set(ids);
  const sel = live.filter((p) => set.has(p.id));
  // список толщин — по материалу первой выбранной позиции
  const materialId = sel[0]?.materialId ?? 'st3';
  const offers = pendingOffers(order.ai, order.positions).filter((o) => set.has(o.positionId));
  // последнее применённое значение остаётся в поле — видно, что сделано
  const [mat, setMat] = useState<string | null>(null);
  const [thickness, setThickness] = useState<number | null>(null);
  const [bends, setBends] = useState(0);
  const [qty, setQty] = useState(0);
  const n = ids.length;
  return (
    <div
      role="toolbar"
      aria-label="Действия с выбранными позициями"
      className={cn(
        'fixed inset-x-0 bottom-4 z-40 mx-auto flex w-fit max-w-[calc(100vw-2rem)] flex-wrap items-center gap-2',
        'rounded-xl border bg-popover px-3 py-2 text-popover-foreground shadow-lg max-md:hidden print:hidden',
      )}
    >
      <span className="text-sm font-medium tabular-nums">Выбрано: {n}</span>
      <Separator orientation="vertical" className="h-6" />
      <Label>Материал</Label>
      <MaterialSelect
        size="sm"
        value={mat}
        placeholder="—"
        onChange={(m) => {
          setMat(m);
          bulkEdit(ids, { materialId: m });
        }}
        aria-label="Материал у выбранных"
        className="w-[124px]"
      />
      <Label>Толщина</Label>
      <ThicknessPicker
        size="sm"
        materialId={mat ?? materialId}
        value={thickness}
        onChange={(t) => {
          setThickness(t);
          bulkEdit(ids, { thickness: t });
        }}
        aria-label="Толщина у выбранных"
        className="w-[76px]"
      />
      <Label>Гибов</Label>
      <NumInput
        size="sm"
        allowEmpty
        placeholder="—"
        value={bends}
        aria-label="Гибов на 1 шт у выбранных"
        onChange={(v) => {
          const b = Math.round(v);
          setBends(b);
          bulkEdit(ids, { bends: b });
        }}
        className="w-12"
      />
      <Label>Кол-во</Label>
      <NumInput
        size="sm"
        allowEmpty
        placeholder="—"
        value={qty}
        aria-label="Количество у выбранных, шт"
        onChange={(v) => {
          if (v < 1) return;
          const q = Math.round(v);
          setQty(q);
          bulkEdit(ids, { qty: q });
        }}
        className="w-14"
      />
      <Separator orientation="vertical" className="h-6" />
      <Button size="sm" variant="outline" onClick={() => bulkEdit(ids, { disabled: false })}>
        Включить
      </Button>
      <Button size="sm" variant="outline" onClick={() => bulkEdit(ids, { disabled: true })}>
        Исключить
      </Button>
      {offers.length > 0 && (
        <Button size="sm" variant="outline" className="border-ai/50 text-ai hover:bg-ai-soft hover:text-ai" onClick={() => acceptSuggestions(offers.map((o) => o.s.id))}>
          <Sparkles />
          Принять предложения ИИ ({offers.length})
        </Button>
      )}
      <Button size="sm" variant="destructive" onClick={() => removePositions(ids)}>
        <Trash2 />
        Удалить
      </Button>
      <Button size="icon-sm" variant="ghost" aria-label="Снять выделение" onClick={clearSelection}>
        <X />
      </Button>
    </div>
  );
}

export function BulkBar(): ReactElement | null {
  const selection = useStore((s) => s.ui.selection);
  const positions = useStore((s) => s.order.positions);
  const ids = selection.filter((id) => positions.some((p) => p.id === id));
  if (!ids.length) return null;
  // новый набор — поля «Гибов» и «Кол-во» снова пустые
  return <Bar key={ids.join(',')} ids={ids} />;
}
