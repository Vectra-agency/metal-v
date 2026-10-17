// «Доп. работы на 1 шт»: строки «название — ₽/шт», готовые работы из «Расценок» (₽/шт считается по детали),
// строки ИИ помечены «✦ ИИ»; изменённая строка ИИ становится обычной (это решает manualEdit).
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx';
import { NumInput } from '@/components/common/NumInput.tsx';
import { Plus, X } from '@/components/common/icons.ts';
import type { AiState } from '@/core/ai.ts';
import { getMaterial, kgPerM2 } from '@/core/materials.ts';
import type { Extra, ExtraRate, PosResult } from '@/core/pricing.ts';
import { n0, n1, n2, NBSP, rub } from '@/format.ts';
import type { OrderPosition } from '@/order.ts';
import { editPosition } from '@/store/actions.ts';
import { useStore } from '@/store/store.ts';

/** ₽/шт по ставке из «Расценок» и формула для подсказки */
export function presetPrice(rate: ExtraRate, p: OrderPosition, r: PosResult | undefined): { perPiece: number; formula: string } {
  const price = rate.price;
  const unit = rate.unit.trim();
  const areaM2 = p.geom.netArea / 1e6;
  const per = `${n0(price)}${NBSP}₽/${unit}`;
  const round = (v: number) => Math.round(v * 100) / 100;
  switch (unit) {
    case 'м²':
      return { perPiece: round(2 * areaM2 * price), formula: `2 стороны × ${n2(areaM2)}${NBSP}м² × ${per}` };
    case 'кг': {
      const kgs = r?.netKg ?? areaM2 * kgPerM2(getMaterial(p.materialId), p.thickness);
      return { perPiece: round(kgs * price), formula: `${n2(kgs)}${NBSP}кг × ${per}` };
    }
    case 'м': {
      const cut = r?.cutM ?? p.geom.cutLength / 1000;
      return { perPiece: round(cut * price), formula: `${n2(cut)}${NBSP}м реза × ${per}` };
    }
    case 'м шва':
      return { perPiece: 0, formula: `Длина шва по чертежу неизвестна — введите сумму вручную (${per})` };
    case 'отв.': {
      const holes = Math.max(0, p.geom.pierces - p.geom.count);
      return { perPiece: round(holes * price), formula: `${holes}${NBSP}отв. × ${per}` };
    }
    case 'шт':
      return { perPiece: round(price), formula: `1${NBSP}шт × ${per}` };
    default:
      return { perPiece: round(price), formula: `1 × ${n1(price)}${NBSP}₽` };
  }
}

const reasonOf = (ai: AiState | undefined, aiId: string) => {
  for (const r of ai?.analysis.positions ?? []) for (const s of r.suggestions) if (s.id === aiId) return s.reason;
  return '';
};

export interface ExtrasEditorProps {
  base: OrderPosition;
  pos: OrderPosition; // с предложениями ИИ: строки ИИ уже в списке
  r: PosResult | undefined;
}

export function ExtrasEditor({ base, pos, r }: ExtrasEditorProps): ReactElement {
  const rates = useStore((s) => s.settings.extraRates);
  const ai = useStore((s) => s.order.ai);
  const extras = pos.extras;
  const list = useRef<HTMLUListElement>(null);
  // новая строка: курсор в название («+ строка») или в сумму (работа без расчёта по детали, например сварка)
  const [focusNew, setFocusNew] = useState<{ field: 'label' | 'price'; row: number } | null>(null);
  useEffect(() => {
    if (!focusNew || extras.length <= focusNew.row) return;
    const inputs = list.current?.children[focusNew.row]?.querySelectorAll<HTMLInputElement>('input');
    const el = inputs?.length ? (focusNew.field === 'label' ? inputs[0] : inputs[inputs.length - 1]) : null;
    el?.focus();
    el?.select();
    setFocusNew(null);
  }, [focusNew, extras.length]);
  const set = (next: Extra[]) => editPosition(base.id, { extras: next });
  const patchAt = (i: number, patch: Partial<Extra>) => set(extras.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <section aria-labelledby="extras-h" data-sheet-focus="extras" className="space-y-3">
      <h3 id="extras-h" className="text-sm font-semibold">
        Доп. работы на 1 шт
      </h3>
      {extras.length > 0 ? (
        <ul ref={list} className="space-y-1.5">
          {extras.map((e, i) => (
            <li key={i} className="flex items-center gap-2">
              <Input
                value={e.label}
                placeholder="Название"
                aria-label="Название работы"
                onChange={(ev) => patchAt(i, { label: ev.target.value })}
                className="h-8 min-w-0 flex-1"
              />
              {e.aiId && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span tabIndex={0} className="focus-ring inline-flex h-5 shrink-0 items-center rounded-full bg-ai-soft px-1.5 text-[11px] font-medium text-ai">
                      ✦ ИИ
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-80">{reasonOf(ai, e.aiId) || 'Добавлено по предложению ИИ'}</TooltipContent>
                </Tooltip>
              )}
              <NumInput value={e.perPiece} suffix="₽" aria-label={`Цена за 1 шт, ₽: ${e.label || 'работа'}`} onChange={(v) => patchAt(i, { perPiece: v })} className="w-28" />
              <Button size="icon-sm" variant="ghost" aria-label="Удалить работу" onClick={() => set(extras.filter((_, j) => j !== i))}>
                <X />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">Нет доп. работ.</p>
      )}
      {rates.length > 0 && <p className="text-xs text-muted-foreground">Добавить из «Расценок» — ₽ на 1 шт по размерам этой детали:</p>}
      <div className="flex flex-wrap gap-1.5">
        {rates.map((rate) => {
          const { perPiece, formula } = presetPrice(rate, pos, r);
          // по детали не посчитать (метры шва) — показываем ставку, сумму вводят сами
          const manual = perPiece <= 0;
          return (
            <Tooltip key={rate.label + rate.unit}>
              <TooltipTrigger asChild>
                <Button
                  size="xs"
                  variant="outline"
                  className="font-normal"
                  onClick={() => {
                    set([...extras, { label: rate.label, perPiece }]);
                    if (manual) setFocusNew({ field: 'price', row: extras.length });
                  }}
                >
                  + {rate.label}{' '}
                  {manual ? (
                    <span className="text-muted-foreground">
                      · {n0(rate.price)}
                      {NBSP}₽/{rate.unit}
                    </span>
                  ) : (
                    <span className="tabular-nums">→ {rub(perPiece)}</span>
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent className="max-w-80">
                {formula}
                {rate.note ? ` (${rate.note})` : ''}
              </TooltipContent>
            </Tooltip>
          );
        })}
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            set([...extras, { label: '', perPiece: 0 }]);
            setFocusNew({ field: 'label', row: extras.length });
          }}
        >
          <Plus />
          строка
        </Button>
      </div>
    </section>
  );
}
