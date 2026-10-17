// Группа «материал + толщина» (перенесено из SheetsSection): лист, своя цена ₽/кг, списание; факты о цене и листе,
// пояснения про потолок отхода и разбиение, листы раскроя и список «Позиции группы» (подсветка — общая с листами).
import { useMemo, useState, type ReactElement } from 'react';
import { cn } from '@/lib/utils.ts';
import { Alert, AlertDescription } from '@/components/ui/alert.tsx';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Field, FieldLabel } from '@/components/ui/field.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx';
import { CatDot } from '@/components/common/CostBar.tsx';
import { ExternalLink, Info, TriangleAlert } from '@/components/common/icons.ts';
import { NumInput } from '@/components/common/NumInput.tsx';
import type { SheetPolicy } from '@/core/materials.ts';
import { fmtSheet, type GroupResult, type OrderResult } from '@/core/pricing.ts';
import { kg, n0, n1, n2, pct, rub, rub0, thick } from '@/format.ts';
import { mcUrl } from '@/mcUrl.ts';
import type { OrderPosition } from '@/order.ts';
import { openPosition, setHighlight, setPolicy, setPriceOverride, setSheetChoice } from '@/store/actions.ts';
import { useStore } from '@/store/store.ts';
import { SheetSvg } from './SheetSvg.tsx';

export const AUTO = '__auto';
const SHOWN_SHEETS = 4;

export const POLICY_LABEL: Record<SheetPolicy, string> = {
  length: 'по раскрою (остаток — деловой)',
  whole: 'целыми листами',
  bbox: 'по габариту деталей + отход',
};

function OfferFacts({ g }: { g: GroupResult }): ReactElement {
  const c = g.chosen;
  const o = c.offer;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <span className="font-medium text-foreground tabular-nums">{n2(o.pricePerKg)} ₽/кг</span>
        {o.source === 'mc' && (
          <a href={mcUrl(g.material.mc.category, g.t)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline-offset-2 hover:underline focus-ring">
            {o.note}
            <ExternalLink aria-hidden className="size-3" />
            <span className="sr-only">(откроется mc.ru)</span>
          </a>
        )}
        {o.source === 'estimate' && (
          <>
            <Badge variant="outline" className="border-warn/50 text-warn">
              <TriangleAlert aria-hidden />
              оценка
            </Badge>
            <span>{o.note}</span>
          </>
        )}
        {o.source === 'manual' && <span>{o.note}</span>}
      </span>
      <span className="tabular-nums">
        лист {fmtSheet(o.w, o.l)} = {n1(c.sheetKg)} кг = {rub0(c.sheetPrice)}
      </span>
      <span className="tabular-nums">
        в расчёте <b className="font-medium text-foreground">{n2(c.sheetsCharged)}</b> листа · заполнение {pct(c.nest.utilization)}
      </span>
    </div>
  );
}

function Notes({ g, names }: { g: GroupResult; names: Map<string, string> }): ReactElement | null {
  const maxWaste = useStore((s) => s.settings.maxWastePct);
  const maxWhole = useStore((s) => s.settings.maxWasteWholePct);
  const c = g.chosen;
  const splits = Object.entries(c.splits);
  if (!c.capped && !splits.length) return null;
  return (
    <div className="flex flex-col gap-2">
      {c.capped && (
        <Alert className="py-2 text-xs">
          <Info />
          <AlertDescription className="text-xs">
            {g.policy === 'whole' ? (
              <>
                Целыми листами вышло бы {rub0(Math.ceil(c.nest.sheetsFractional - 1e-9) * c.sheetPrice)} — для такой партии это неправдоподобно, поэтому отход ограничен{' '}
                {maxWhole ?? 100}% к массе заготовок. Потолок меняется в «Расценках».
              </>
            ) : (
              <>
                По раскрою этого заказа вышло бы {rub0(c.nest.sheetsFractional * c.sheetPrice)}, но отход ограничен {maxWaste}% к массе заготовок: неудобные детали
                цех обычно докладывает к другим заказам. Потолок меняется в «Расценках».
              </>
            )}
          </AlertDescription>
        </Alert>
      )}
      {splits.length > 0 && (
        <Alert className="border-warn/40 bg-warn-soft py-2">
          <TriangleAlert className="text-warn" />
          <AlertDescription className="text-xs text-foreground/80">
            Не помещаются на лист целиком и считаются из частей: {splits.map(([id, sp]) => `${names.get(id) ?? id} — ${sp.pieces} ч.`).join('; ')}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

function GroupPositions({ g, res, byId, highlight }: { g: GroupResult; res: OrderResult; byId: Map<string, OrderPosition>; highlight: string | null }): ReactElement {
  return (
    <div className="min-w-0">
      <div className="mb-1 flex flex-col px-2 text-xs">
        <span className="font-medium">Позиции группы</span>
        <span className="text-[11px] text-muted-foreground">Деталь · Габарит · Шт · Доля · Металл/шт</span>
      </div>
      <ul className="flex flex-col" aria-label="Позиции группы">
        {g.positionIds.map((id) => {
          const p = byId.get(id);
          const r = res.positions.get(id);
          if (!p || !r) return null;
          return (
            <li key={id}>
              <button
                type="button"
                data-row={id}
                onMouseEnter={() => setHighlight(id)}
                onMouseLeave={() => setHighlight(null)}
                onFocus={() => setHighlight(id)}
                onBlur={() => setHighlight(null)}
                onClick={() => openPosition(id)}
                className={cn(
                  'grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-2 rounded-md px-2 py-1 text-left text-xs transition-colors focus-ring hover:bg-accent',
                  highlight === id && 'bg-accent',
                )}
              >
                <span className="truncate font-medium" title={p.name}>
                  {p.name}
                </span>
                <span className="text-right tabular-nums">{rub(r.piece.material)}</span>
                <span className="col-span-2 text-muted-foreground tabular-nums">
                  {n0(p.geom.width)}×{n0(p.geom.height)} мм · {n0(r.qty)} шт · {pct(r.share)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function GroupCard({ g, res, byId }: { g: GroupResult; res: OrderResult; byId: Map<string, OrderPosition> }): ReactElement {
  const choice = useStore((s) => s.order.sheetChoice[g.key]);
  const override = useStore((s) => s.order.priceOverride[g.key] ?? 0);
  const highlight = useStore((s) => s.ui.highlight);
  const [showAll, setShowAll] = useState(false);
  const c = g.chosen;
  const sheets = c.nest.sheets;
  const visible = showAll ? sheets : sheets.slice(0, SHOWN_SHEETS);
  const names = useMemo(() => new Map(g.positionIds.map((id) => [id, byId.get(id)?.name ?? id])), [g.positionIds, byId]);
  const label = `${g.material.label} · ${thick(g.t)}`;
  const hl = highlight && g.positionIds.includes(highlight) ? highlight : null;

  return (
    <article aria-label={label} className="flex min-w-0 flex-col gap-4 rounded-xl border bg-card p-4" data-group={g.key}>
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{label}</h3>
          <p className="text-xs text-muted-foreground tabular-nums">
            {g.positionIds.length} поз. · детали {kg(g.partsKg)} · по габариту {kg(g.bboxKg)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 text-sm font-semibold tabular-nums" title="Металл группы">
          <CatDot cat="material" />
          {rub0(g.materialCost)}
        </div>
      </header>

      <div className="grid gap-3 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,0.8fr)_minmax(0,1.3fr)]">
        <Field className="gap-1.5">
          <FieldLabel className="text-xs text-muted-foreground">Лист</FieldLabel>
          <Select value={choice ?? AUTO} onValueChange={(v) => setSheetChoice(g.key, v === AUTO ? null : v)}>
            <SelectTrigger className="w-full" aria-label={`Лист для «${label}»`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              <SelectItem value={AUTO}>Авто: {fmtSheet(g.auto.offer.w, g.auto.offer.l)}</SelectItem>
              {g.options.map((o) => {
                const k = fmtSheet(o.offer.w, o.offer.l);
                return (
                  <SelectItem key={k} value={k} className="tabular-nums">
                    {k} — {rub0(o.materialCost)}
                    {Object.keys(o.splits).length ? ' (с разбиением)' : ''}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </Field>
        <Field className="gap-1.5">
          <FieldLabel className="text-xs text-muted-foreground">Цена</FieldLabel>
          <NumInput
            aria-label={`Своя цена металла для «${label}», ₽/кг`}
            title="Своя цена металла, ₽/кг (пусто — mc.ru)"
            value={override}
            allowEmpty
            placeholder={n2(c.offer.pricePerKg)}
            suffix="₽/кг"
            onChange={(v) => setPriceOverride(g.key, v > 0 ? v : null)}
          />
        </Field>
        <Field className="gap-1.5">
          <FieldLabel className="text-xs text-muted-foreground">Списание</FieldLabel>
          <Tooltip>
            <Select value={g.policy} onValueChange={(v) => setPolicy(g.material.id, v as SheetPolicy)}>
              <TooltipTrigger asChild>
                <SelectTrigger className="w-full" aria-label={`Списание металла: ${g.material.label}`}>
                  <SelectValue />
                </SelectTrigger>
              </TooltipTrigger>
              <SelectContent position="popper">
                {(Object.keys(POLICY_LABEL) as SheetPolicy[]).map((k) => (
                  <SelectItem key={k} value={k}>
                    {POLICY_LABEL[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <TooltipContent>Как цех считает металл — для всех позиций этого материала</TooltipContent>
          </Tooltip>
        </Field>
      </div>

      <OfferFacts g={g} />
      <Notes g={g} names={names} />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
            {visible.map((s, i) => (
              <SheetSvg
                key={i}
                sheet={s}
                index={i}
                w={c.nest.sheetW}
                h={c.nest.sheetH}
                showUsed={i === sheets.length - 1 && g.policy === 'length' && !c.capped}
                names={names}
                highlight={hl}
                truncated={c.nest.truncated}
              />
            ))}
          </div>
          {sheets.length > SHOWN_SHEETS && (
            <Button variant="ghost" size="sm" className="-ml-2.5 w-fit" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}>
              {showAll ? 'Свернуть' : `Показать все листы (${sheets.length})`}
            </Button>
          )}
          {c.nest.truncated && <p className="text-xs text-muted-foreground">* Деталей очень много — раскладка посчитана по пропорциональной выборке.</p>}
        </div>
        <GroupPositions g={g} res={res} byId={byId} highlight={hl} />
      </div>
    </article>
  );
}
