// Строка таблицы позиций (memo): правка материала, толщины, количества и гибов прямо в таблице, деньги на 1 шт,
// отметки ИИ под полями. Строка перерисовывается, только если изменились поля её модели (по ссылкам) или флаги:
// наведение и выделение трогают 1–2 строки. Ячейки с полями тоже memo — смена наценки перерисовывает только деньги.
import { memo, type KeyboardEvent, type MouseEvent, type ReactElement } from 'react';
import { PanelRightOpen } from 'lucide-react';
import type { AiChange, AiField } from '@/ai/apply.ts';
import type { AiSuggestion, AiSuggestionKind } from '@/core/ai.ts';
import type { PosResult } from '@/core/pricing.ts';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Checkbox } from '@/components/ui/checkbox.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx';
import { AiChangeBadge } from '@/components/ai/AiChangeBadge.tsx';
import { OfferChip } from '@/components/ai/OfferChip.tsx';
import { formatAiValue } from '@/components/common/aiFormat.ts';
import { CatDot, CostBar } from '@/components/common/CostBar.tsx';
import { CircleMinus, CopyPlus, Ellipsis, Trash2 } from '@/components/common/icons.ts';
import { MaterialSelect } from '@/components/common/MaterialSelect.tsx';
import { Money } from '@/components/common/Money.tsx';
import { NumInput } from '@/components/common/NumInput.tsx';
import { PartPreview } from '@/components/common/PartPreview.tsx';
import { ThicknessPicker } from '@/components/common/ThicknessPicker.tsx';
import { kg, m as meters, n0, n1, n2, NBSP, pct1, rub } from '@/format.ts';
import { cn } from '@/lib/utils.ts';
import type { OrderPosition } from '@/order.ts';
import { duplicatePosition, editPosition, flashRow, openPosition, removePositions, setHighlight, toggleSelected } from '@/store/actions.ts';
import type { ColumnId } from '@/store/types.ts';
import { STICKY_LEFT } from './columns.ts';
import { PdfBadge } from './PdfBadge.tsx';
import type { RowModel } from './rowModel.ts';
import { StatusCell } from './StatusCell.tsx';

export interface PositionRowProps {
  m: RowModel;
  selected: boolean;
  active: boolean; // открыта в карточке
  highlighted: boolean; // наведение (в т. ч. из других мест: замечания, листы)
  flashing: boolean;
  focusable: boolean; // строка — точка входа с клавиатуры (tabIndex 0)
  navRow: number; // номер видимой строки (Enter в поле → то же поле ниже)
  columns: Record<ColumnId, boolean>;
  markupPct: number;
  kop: boolean; // КП «до копеек» — цена и сумма с копейками
  total: number; // «Цена клиенту» — для доли в заказе
  onSelect: (id: string, shift: boolean) => void; // флажок (Shift — диапазон)
}

const NONE: never[] = [];

/** Ячейка: высота строки ≥ 44 px, на сенсорном — 48 */
const TD = 'h-11 px-1.5 py-1.5 align-middle pointer-coarse:h-12';
const STICKY = 'sticky z-1 bg-(--row-bg)';

const isScan = (p: OrderPosition) => !!p.pdf && !p.pdf.meta.base.outer.length;

/** «Нет размеров (скан)» / «Контур не найден» */
export const noGeomText = (p: OrderPosition) => (isScan(p) ? 'Нет размеров (скан)' : 'Контур не найден');

// ---------- отметки ИИ ----------

const KIND_OF: Partial<Record<AiField, AiSuggestionKind>> = { materialId: 'material', thickness: 'thickness', qty: 'qty', bends: 'bends' };

interface AiProps {
  id: string;
  changes: AiChange[];
  offers: AiSuggestion[];
}

/** Вторая строка ячейки: применённые изменения ИИ («✦ ИИ было 1 шт») и предложения, ждущие решения (чипы).
 *  compact — узкий столбец (количество): строка не шире ячейки, «было …» — в подсказке значка */
function Marks({ id, changes, offers, fields, compact }: AiProps & { fields: AiField[]; compact?: boolean }): ReactElement | null {
  const ch = changes.length ? changes.filter((c) => fields.includes(c.field)) : NONE;
  const kinds = fields.map((f) => KIND_OF[f]);
  const of = offers.length ? offers.filter((s) => kinds.includes(s.kind)) : NONE;
  if (!ch.length && !of.length) return null;
  return (
    <div className={cn('mt-1 flex min-w-0 flex-wrap items-center gap-1', compact && 'max-w-full justify-end')}>
      {ch.map((c) => (
        <Was key={c.suggestion.id} change={c} positionId={id} compact={compact} />
      ))}
      {of.map((s) => (
        <OfferChip key={s.id} suggestion={s} positionId={id} size="xs" />
      ))}
    </div>
  );
}

/** «✦ ИИ было 1 шт»; compact — только значок, «было …» — в подсказке */
function Was({ change, positionId, compact, className }: { change: AiChange; positionId: string; compact?: boolean; className?: string }): ReactElement {
  const was = change.field !== 'extras' && change.field !== 'disabled' ? `было ${formatAiValue(change.field, change.from)}` : null;
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground', className)} title={compact && was ? was : undefined}>
      <AiChangeBadge change={change} positionId={positionId} />
      {was && !compact && <span className="truncate">{was}</span>}
    </span>
  );
}

/** «⚠ 2» — предупреждения разбора, которых нет среди замечаний; подсказка перечисляет их */
function WarnBadge({ warnings }: { warnings: string[] }): ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          tabIndex={0}
          aria-label={`Предупреждения: ${warnings.join('; ')}`}
          className="focus-ring shrink-0 cursor-help rounded-sm text-[11px] font-medium text-warn"
        >
          ⚠ {warnings.length}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="max-w-96">
        <ul className="space-y-0.5">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}

const hasChange = (changes: AiChange[], f: AiField) => changes.some((c) => c.field === f);

const sameArr = (a: readonly unknown[], b: readonly unknown[]) => a === b || (a.length === b.length && a.every((x, i) => x === b[i]));

/** Сравнение пропсов ячеек: массивы — поэлементно (их пересобирают при каждом пересчёте), остальное — по ссылке */
function sameCell<P extends object>(a: P, b: P): boolean {
  for (const k of Object.keys(a) as (keyof P)[]) {
    const x = a[k];
    const y = b[k];
    if (Array.isArray(x) && Array.isArray(y) ? !sameArr(x, y) : !Object.is(x, y)) return false;
  }
  return true;
}

// ---------- ячейки с полями (memo: не зависят от цен) ----------

interface NameProps extends AiProps {
  pos: OrderPosition;
  index: number;
  isNew: boolean;
  unpriced: boolean;
  warnings: string[];
  splitPieces: number | null;
  netKg: number | null;
  thumb: boolean;
  geomInline: boolean; // столбец «Габарит» скрыт — габарит во второй строке
  bendsCol: boolean;
}

const NameCell = memo(function NameCell(props: NameProps): ReactElement {
  const { id, pos: p, changes, offers, index, isNew, unpriced, warnings, splitPieces, netKg, thumb, geomInline, bendsCol } = props;
  const disabledBy = changes.find((c) => c.field === 'disabled');
  const extraChanges = changes.filter((c) => c.field === 'extras');
  const otherOffers = offers.filter((s) => s.kind === 'extra' || s.kind === 'disable' || (s.kind === 'bends' && !bendsCol));
  const showFile = !!p.fileName && p.fileName !== p.name;
  // отметки ИИ во второй строке не сжимаются: не влезли — переносятся ниже, а обрезается имя файла (габарит)
  const marks = extraChanges.length > 0 || otherOffers.length > 0;
  const rest = marks ? 'min-w-0 flex-1 basis-0' : undefined;
  return (
    <div className="flex min-w-0 items-center gap-2">
      {thumb && <PartPreview preview={p.preview} />}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-medium" title={p.name}>
            <span className="font-normal text-muted-foreground tabular-nums">{index}.</span>{' '}
            {p.disabled ? <span className="line-through">{p.name}</span> : p.name}
          </span>
          {isNew && (
            <Badge variant="secondary" className="h-4 px-1.5 text-[11px]">
              новая
            </Badge>
          )}
          {p.disabled && (
            <Badge variant="outline" className="h-4 px-1.5 text-[11px] text-muted-foreground">
              исключена
            </Badge>
          )}
          {disabledBy && <AiChangeBadge change={disabledBy} positionId={id} />}
        </div>
        <div className={cn('mt-0.5 flex min-w-0 items-center gap-1 overflow-hidden text-xs text-muted-foreground', marks && 'flex-wrap')}>
          <PdfBadge p={p} />
          {splitPieces != null && (
            <span className="shrink-0 text-[11px] whitespace-nowrap" title={`Не помещается на лист — режем из ${splitPieces} частей`}>
              ✂ из {splitPieces} частей
            </span>
          )}
          {isScan(p) && <span className="shrink-0 text-[11px]">скан</span>}
          {warnings.length > 0 && <WarnBadge warnings={warnings} />}
          {extraChanges.map((c) => (
            <Was key={c.suggestion.id} change={c} positionId={id} className="shrink-0" />
          ))}
          {otherOffers.map((s) => (
            <OfferChip key={s.id} suggestion={s} positionId={id} size="xs" />
          ))}
          {geomInline && unpriced ? (
            <>
              <span className={cn('truncate text-danger', rest)}>{noGeomText(p)}</span>
              <Button size="xs" variant="outline" className="h-5 shrink-0 px-1.5 text-[11px]" onClick={() => openPosition(id, { focus: 'dims' })}>
                Задать габарит
              </Button>
            </>
          ) : geomInline && p.geom.width > 0 ? (
            <span className={cn('truncate tabular-nums', rest)}>
              {n0(p.geom.width)}×{n0(p.geom.height)}
              {NBSP}мм{netKg != null ? ` · ${kg(netKg)}` : ''}
            </span>
          ) : showFile ? (
            <span className={cn('truncate', rest)} title={p.fileName}>
              {p.fileName}
            </span>
          ) : p.source === 'manual' ? (
            <span className={cn('truncate', rest)}>деталь без чертежа</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}, sameCell);

const MaterialCell = memo(function MaterialCell({ id, pos: p, changes, offers }: AiProps & { pos: OrderPosition }): ReactElement {
  return (
    <>
      <div className="flex items-center gap-1">
        <MaterialSelect
          size="sm"
          value={p.materialId}
          guessed={p.guessed.material}
          ai={hasChange(changes, 'materialId')}
          onChange={(materialId) => editPosition(id, { materialId })}
          aria-label={`Материал: ${p.name}`}
          className="w-[124px]"
        />
        <ThicknessPicker
          size="sm"
          materialId={p.materialId}
          value={p.thickness}
          guessed={p.guessed.thickness}
          ai={hasChange(changes, 'thickness')}
          onChange={(thickness) => editPosition(id, { thickness })}
          aria-label={`Толщина: ${p.name}`}
          className="w-[76px]"
        />
      </div>
      <Marks id={id} changes={changes} offers={offers} fields={['materialId', 'thickness']} />
    </>
  );
}, sameCell);

const QtyCell = memo(function QtyCell({ id, pos: p, changes, offers, navRow }: AiProps & { pos: OrderPosition; navRow: number }): ReactElement {
  return (
    <div className="flex flex-col items-end">
      <NumInput
        size="sm"
        value={p.qty}
        min={1}
        guessed={p.guessed.qty}
        ai={hasChange(changes, 'qty')}
        onChange={(v) => editPosition(id, { qty: Math.max(1, Math.round(v)) })}
        aria-label={`Количество, шт: ${p.name}`}
        navCol="qty"
        navRow={navRow}
        className="w-16"
      />
      <Marks id={id} changes={changes} offers={offers} fields={['qty']} compact />
    </div>
  );
}, sameCell);

const BendsCell = memo(function BendsCell({ id, pos: p, changes, offers, navRow }: AiProps & { pos: OrderPosition; navRow: number }): ReactElement {
  return (
    <>
      <div className="flex items-center gap-0.5">
        <NumInput
          size="sm"
          value={p.bends}
          ai={hasChange(changes, 'bends')}
          onChange={(v) => editPosition(id, { bends: Math.round(v) })}
          aria-label={`Гибов на 1 шт: ${p.name}`}
          title={`Линий гиба в файле: ${p.detectedBends}`}
          navCol="bends"
          navRow={navRow}
          className="w-8 shrink-0"
        />
        <span aria-hidden className="text-xs text-muted-foreground">
          ×
        </span>
        <NumInput
          size="sm"
          value={p.bendLength}
          suffix="мм"
          onChange={(v) => editPosition(id, { bendLength: v })}
          aria-label={`Длина гиба, мм: ${p.name}`}
          title="Длина гиба, мм"
          navCol="bendLength"
          navRow={navRow}
          className="w-[72px] shrink-0"
        />
      </div>
      <Marks id={id} changes={changes} offers={offers} fields={['bends']} />
    </>
  );
}, sameCell);

const GeometryCell = memo(function GeometryCell(props: {
  id: string;
  pos: OrderPosition;
  unpriced: boolean;
  netKg: number | null;
  cutM: number | null;
  pierces: number | null;
}): ReactElement {
  const { id, pos: p, unpriced, netKg, cutM, pierces } = props;
  if (unpriced) {
    return (
      <div className="flex flex-col items-start gap-1">
        <span className="text-xs font-medium">{noGeomText(p)}</span>
        <Button size="xs" variant="outline" className="h-5 px-1.5 text-[11px]" onClick={() => openPosition(id, { focus: 'dims' })}>
          Задать габарит
        </Button>
      </div>
    );
  }
  return (
    <div className="min-w-0 leading-tight tabular-nums">
      <div className="truncate">
        {n0(p.geom.width)}×{n0(p.geom.height)}
        {NBSP}мм
      </div>
      <div className="truncate text-[11px] text-muted-foreground" title="масса 1 шт · рез на 1 шт · врезки">
        {netKg != null ? kg(netKg) : '—'} · {cutM != null ? meters(cutM * 1000) : meters(p.geom.cutLength)} · {pierces ?? p.geom.pierces}
        {NBSP}вр.
      </div>
    </div>
  );
}, sameCell);

// ---------- деньги ----------

/** Деньги на 1 шт: 0 у гибки и доп. работ — серый прочерк */
function PieceMoney({ v, zeroDash }: { v: number | null; zeroDash?: boolean }): ReactElement {
  if (v != null && zeroDash && Math.abs(v) < 0.005) return <span className="text-muted-foreground">—</span>;
  return <Money value={v} />;
}

function CostBreakdown({ r }: { r: PosResult }): ReactElement {
  const rows: { cat: 'material' | 'cut' | 'bend' | 'extras'; label: string; v: number; sub?: string }[] = [
    { cat: 'material', label: 'Металл', v: r.piece.material },
    { cat: 'cut', label: 'Резка', v: r.piece.cut + r.piece.pierce, sub: r.rate.perM != null ? `${n2(r.cutM)} м × ${n1(r.rate.perM)} ₽/м` : 'нет цены в прайсе резки' },
    { cat: 'bend', label: 'Гибка', v: r.piece.bend },
    { cat: 'extras', label: 'Доп. работы', v: r.piece.extras },
  ];
  return (
    <div className="space-y-1.5 text-[13px]">
      <div className="text-xs text-muted-foreground">Себестоимость за 1 шт</div>
      {rows.map((x) => (
        <div key={x.cat} className="flex items-baseline gap-2">
          <CatDot cat={x.cat} />
          <span>{x.label}</span>
          {x.sub && x.v > 0 && <span className="truncate text-xs text-muted-foreground">{x.sub}</span>}
          <span className="ml-auto">{x.v > 0.004 ? <Money value={x.v} /> : <span className="text-muted-foreground">—</span>}</span>
        </div>
      ))}
      <div className="flex items-baseline gap-2 border-t pt-1.5 font-medium">
        <span>Итого</span>
        <Money value={r.piece.total} className="ml-auto" />
      </div>
    </div>
  );
}

function CostCell({ r, hover }: { r: PosResult | undefined; hover: boolean }): ReactElement {
  if (!r) return <Money value={null} />;
  const body = (
    <div className="flex flex-col items-end gap-1">
      <Money value={r.piece.total} />
      <CostBar parts={{ material: r.piece.material, cut: r.piece.cut + r.piece.pierce, bend: r.piece.bend, extras: r.piece.extras }} className="h-1 w-full max-w-20" />
    </div>
  );
  if (!hover) return body;
  return (
    <HoverCard openDelay={300} closeDelay={100}>
      <HoverCardTrigger asChild>
        <div className="cursor-default">{body}</div>
      </HoverCardTrigger>
      <HoverCardContent side="left" align="center" className="w-72">
        <CostBreakdown r={r} />
      </HoverCardContent>
    </HoverCard>
  );
}

const RowMenu = memo(function RowMenu({ id, off }: { id: string; off: boolean }): ReactElement {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon-xs" variant="ghost" aria-label="Действия с позицией" className="text-muted-foreground pointer-coarse:size-9">
          <Ellipsis />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onSelect={() => openPosition(id)}>
          <PanelRightOpen />
          Открыть карточку
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            const copy = duplicatePosition(id);
            if (copy) flashRow(copy);
          }}
        >
          <CopyPlus />
          Дублировать
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => editPosition(id, { disabled: !off })}>
          <CircleMinus />
          {off ? 'Включить в расчёт' : 'Исключить из расчёта'}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => removePositions([id])}>
          <Trash2 />
          Удалить
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

// ---------- строка ----------

/** Щелчок по «пустому» месту строки открывает карточку; по полям, кнопкам и флажку — нет */
const INTERACTIVE = 'button, input, textarea, select, a, label, [role=checkbox], [role=combobox], [role=button], [data-no-row-click]';

function onRowClick(e: MouseEvent<HTMLTableRowElement>) {
  const t = e.target as HTMLElement;
  // события из всплывающих окон (портал) тоже доходят сюда по дереву React — их пропускаем
  if (!e.currentTarget.contains(t) || t.closest(INTERACTIVE)) return;
  if (window.getSelection()?.toString()) return; // выделяли текст мышью
  const id = e.currentTarget.dataset.rowId;
  if (id) openPosition(id);
}

/** Клавиши на строке под фокусом: ↑/↓ — соседняя строка, Enter — карточка, пробел — выбрать */
function onRowKeyDown(e: KeyboardEvent<HTMLTableRowElement>) {
  if (e.target !== e.currentTarget || e.altKey || e.ctrlKey || e.metaKey) return;
  const id = e.currentTarget.dataset.rowId;
  if (!id) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    let el: Element | null = e.currentTarget;
    do el = e.key === 'ArrowDown' ? el.nextElementSibling : el.previousElementSibling;
    while (el && !(el as HTMLElement).dataset.rowId);
    (el as HTMLElement | null)?.focus();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    openPosition(id);
  } else if (e.key === ' ') {
    e.preventDefault();
    toggleSelected(id);
  }
}

function PositionRowImpl(props: PositionRowProps): ReactElement {
  if (import.meta.env.DEV) rowRenderStats.count++;
  const { m, selected, active, highlighted, flashing, focusable, navRow, columns, markupPct, kop, total, onSelect } = props;
  const p = m.pos;
  const id = m.base.id;
  const off = !!p.disabled;
  const problem = m.items.some((i) => i.severity === 'problem');
  const r = off || m.unpriced ? undefined : m.r;
  const line = m.line;
  const share = columns.share && line?.sum != null && total > 0 ? (line.sum / total) * 100 : null;
  const priceTitle = r && line?.price != null ? `себестоимость ${rub(r.piece.total)} + наценка ${n1(markupPct)}${NBSP}%` : undefined;
  const ai = { id, changes: m.changes, offers: m.offers };
  return (
    <tr
      data-row-id={id}
      tabIndex={focusable ? 0 : -1}
      onClick={onRowClick}
      onKeyDown={onRowKeyDown}
      onMouseEnter={() => setHighlight(id)}
      onMouseLeave={() => setHighlight(null)}
      className={cn(
        'group/row text-[13px] transition-colors [--row-bg:var(--background)]',
        // фокус с клавиатуры — рамка по ячейкам: рамку самой строки (outline) закрывают липкие первые столбцы
        'bg-(--row-bg) outline-hidden',
        'focus-visible:[&>td]:shadow-[inset_0_2px_0_var(--ring),inset_0_-2px_0_var(--ring)]',
        'focus-visible:[&>td:first-child]:shadow-[inset_2px_0_0_var(--ring),inset_0_2px_0_var(--ring),inset_0_-2px_0_var(--ring)]',
        'focus-visible:[&>td:last-child]:shadow-[inset_-2px_0_0_var(--ring),inset_0_2px_0_var(--ring),inset_0_-2px_0_var(--ring)]',
        'hover:[--row-bg:color-mix(in_oklch,var(--muted)_70%,var(--background))]',
        highlighted && '[--row-bg:color-mix(in_oklch,var(--muted)_70%,var(--background))]',
        selected && '[--row-bg:color-mix(in_oklch,var(--muted)_90%,var(--background))]',
        active && '[--row-bg:var(--accent)] hover:[--row-bg:var(--accent)]',
        flashing && '[&>td]:animate-row-flash',
        // исключена: приглушённый текст полной контрастности (не прозрачность — она гасила и значок «исключена»)
        off && 'text-muted-foreground',
      )}
    >
      <td
        className={cn(TD, STICKY, 'pr-0', active ? 'shadow-[inset_2px_0_0_var(--primary)]' : problem ? 'shadow-[inset_2px_0_0_var(--danger)]' : undefined)}
        style={{ left: STICKY_LEFT.select }}
      >
        <div className="flex justify-center">
          <Checkbox
            checked={selected}
            aria-label={`Выбрать ${p.name}`}
            onClick={(e) => {
              e.preventDefault();
              onSelect(id, e.shiftKey);
            }}
          />
        </div>
      </td>
      <td className={cn(TD, STICKY, 'text-center')} style={{ left: STICKY_LEFT.status }}>
        <StatusCell items={m.items} inScope={m.inScope} />
      </td>
      <td
        className={cn(TD, STICKY, 'cursor-pointer group-data-[scrolled=true]/table:shadow-[6px_0_6px_-6px_rgb(0_0_0/0.25)]')}
        style={{ left: STICKY_LEFT.name }}
      >
        <NameCell
          {...ai}
          pos={p}
          index={m.index}
          isNew={m.isNew}
          unpriced={m.unpriced}
          warnings={m.warnings}
          splitPieces={m.r?.split?.pieces ?? null}
          netKg={!columns.geometry && m.r ? Math.round(m.r.netKg * 100) / 100 : null}
          thumb={columns.thumb}
          geomInline={!columns.geometry}
          bendsCol={columns.bends}
        />
      </td>
      <td className={TD}>
        <MaterialCell {...ai} pos={p} />
      </td>
      <td className={cn(TD, 'text-right')}>
        <QtyCell {...ai} pos={p} navRow={navRow} />
      </td>
      {columns.bends && (
        <td className={TD}>
          <BendsCell {...ai} pos={p} navRow={navRow} />
        </td>
      )}
      {columns.geometry && (
        <td className={cn(TD, m.unpriced && 'bg-danger-soft text-danger')}>
          <GeometryCell
            id={id}
            pos={p}
            unpriced={m.unpriced}
            netKg={m.r ? Math.round(m.r.netKg * 100) / 100 : null}
            cutM={m.r ? Math.round(m.r.cutM * 100) / 100 : null}
            pierces={m.r?.pierces ?? null}
          />
        </td>
      )}
      {columns.breakdown && (
        <>
          <td className={cn(TD, 'text-right')}>
            <PieceMoney v={r ? r.piece.material : null} />
          </td>
          <td className={cn(TD, 'text-right')}>
            <PieceMoney v={r ? r.piece.cut + r.piece.pierce : null} />
          </td>
          <td className={cn(TD, 'text-right')}>
            <PieceMoney v={r ? r.piece.bend : null} zeroDash />
          </td>
          <td className={cn(TD, 'text-right')}>
            <PieceMoney v={r ? r.piece.extras : null} zeroDash />
          </td>
        </>
      )}
      {columns.cost && (
        <td className={cn(TD, 'text-right')}>
          <CostCell r={r} hover={!columns.breakdown} />
        </td>
      )}
      <td className={cn(TD, 'text-right')} title={priceTitle}>
        <Money value={line?.price} kop={kop} className="font-medium" />
      </td>
      <td className={cn(TD, 'text-right')}>
        <Money value={line?.sum} kop={kop} className="font-semibold" />
        {share != null && <div className="text-xs text-muted-foreground tabular-nums">{pct1(share)}</div>}
      </td>
      <td className={cn(TD, 'px-0 text-center')}>
        <RowMenu id={id} off={off} />
      </td>
    </tr>
  );
}

// ---------- сравнение для memo ----------

export function sameModel(a: RowModel, b: RowModel): boolean {
  if (a === b) return true;
  for (const k of Object.keys(a) as (keyof RowModel)[]) {
    const x = a[k];
    const y = b[k];
    if (Array.isArray(x) && Array.isArray(y) ? !sameArr(x, y) : !Object.is(x, y)) return false;
  }
  return true;
}

function sameProps(a: PositionRowProps, b: PositionRowProps): boolean {
  return (
    a.selected === b.selected &&
    a.active === b.active &&
    a.highlighted === b.highlighted &&
    a.flashing === b.flashing &&
    a.focusable === b.focusable &&
    a.navRow === b.navRow &&
    a.columns === b.columns &&
    a.markupPct === b.markupPct &&
    a.kop === b.kop &&
    a.total === b.total &&
    a.onSelect === b.onSelect &&
    sameModel(a.m, b.m)
  );
}

export const PositionRow = memo(PositionRowImpl, sameProps);

/** Сколько раз рисовались строки (DEV: window.__rowRenders) — проверка, что наведение трогает 1–2 строки */
export const rowRenderStats = { count: 0 };
if (import.meta.env.DEV && typeof window !== 'undefined') (window as unknown as { __rowRenders: typeof rowRenderStats }).__rowRenders = rowRenderStats;
