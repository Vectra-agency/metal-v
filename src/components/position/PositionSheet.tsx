// Карточка позиции — немодальная боковая панель (на телефоне — снизу): замечания, цена, параметры, чертёж, PDF,
// анализ ИИ, «как получилась цена», доп. работы, примечание, предупреждения. Таблица остаётся доступной:
// щелчок по другой строке переключает карточку, ↑/↓ (не в поле) — соседние позиции в порядке таблицы.
// kind 'item' — замечание уровня заказа во время разбора по очереди (панель — P3).
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import { changesFor, effectivePositions, pendingOffers } from '@/ai/apply.ts';
import type { AttentionKind } from '@/attention.ts';
import { Button } from '@/components/ui/button.tsx';
import { ScrollArea } from '@/components/ui/scroll-area.tsx';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet.tsx';
import { Textarea } from '@/components/ui/textarea.tsx';
import { AiReviewSection } from '@/components/ai/AiReviewSection.tsx';
import { AttentionItemPanel } from '@/components/ai/AttentionItemPanel.tsx';
import { AttentionItemView } from '@/components/ai/AttentionItemView.tsx';
import { TriageHeader } from '@/components/ai/TriageHeader.tsx';
import { isEditable } from '@/components/common/dom.ts';
import { ChevronDown, ChevronUp, CircleMinus, CopyPlus, Trash2, X } from '@/components/common/icons.ts';
import { Money } from '@/components/common/Money.tsx';
import { PdfBadge } from '@/components/positions/PdfBadge.tsx';
import { isUnpriced, rowsFor, uncoveredWarnings, visibleRows } from '@/components/positions/rowModel.ts';
import { StatusCell } from '@/components/positions/StatusCell.tsx';
import { n0, NBSP } from '@/format.ts';
import { useMediaQuery } from '@/hooks/useMediaQuery.ts';
import { cn } from '@/lib/utils.ts';
import type { OrderPosition } from '@/order.ts';
import { closeSheet, duplicatePosition, editPosition, flashRow, openPosition, removePositions } from '@/store/actions.ts';
import { triageNext, triagePrev } from '@/store/aiActions.ts';
import { useDerived } from '@/store/derived.tsx';
import { getState, useStore } from '@/store/store.ts';
import type { SheetState } from '@/store/types.ts';
import { DrawingSection } from './DrawingSection.tsx';
import { ExtrasEditor } from './ExtrasEditor.tsx';
import { ManualDims, PdfBlock } from './PdfBlock.tsx';
import { ParamsSection } from './ParamsSection.tsx';
import { PriceSteps } from './PriceSteps.tsx';

/** Имена файлов позиции: «деталь.dxf · деталь.pdf» */
function fileNames(p: OrderPosition): string {
  if (p.source === 'manual') return 'Деталь без чертежа';
  const names = [p.fileName, p.pdf?.meta.fileName].filter((x, i, a): x is string => !!x && a.indexOf(x) === i);
  return names.join(' · ') || '—';
}

/** Порядок позиций в таблице сейчас (фильтр, поиск, сортировка) */
function useVisibleIds(): string[] {
  const d = useDerived();
  const order = useStore((s) => s.order);
  const addedIds = useStore((s) => s.pipeline.addedIds);
  const filter = useStore((s) => s.ui.filter);
  const search = useStore((s) => s.ui.search);
  const sort = useStore((s) => s.ui.sort);
  const visible = visibleRows(rowsFor(order, d, addedIds), filter, search, sort, !!order.ai);
  return useMemo(() => visible.map((m) => m.base.id), [visible]);
}

/** Позиция по id сейчас (живое значение, без задержки пересчёта) и она же с предложениями ИИ */
function useLivePosition(id: string): { base: OrderPosition | undefined; pos: OrderPosition | undefined } {
  const base = useStore((s) => s.order.positions.find((p) => p.id === id));
  const ai = useStore((s) => s.order.ai);
  const pos = useMemo(() => (base ? effectivePositions([base], ai)[0] : undefined), [base, ai]);
  return { base, pos };
}

// ---------- шапка ----------

function NavHeader({ id, ids }: { id: string; ids: string[] }): ReactElement {
  const { pos } = useLivePosition(id);
  const items = useDerived().attention.byPosition.get(id) ?? [];
  const inScope = useStore((s) => !!s.order.ai && (!s.order.aiScope?.length || s.order.aiScope.includes(id)));
  const i = ids.indexOf(id);
  const prev = i > 0 ? ids[i - 1] : null;
  const next = i >= 0 && i < ids.length - 1 ? ids[i + 1] : null;
  // при разборе по очереди ↑/↓ листают замечания (TriageHeader) — свой счётчик позиций не показываем, чтобы не путать
  const triage = useStore((s) => !!s.ui.triage);
  return (
    <div className="border-b">
      <TriageHeader />
      <div className="flex items-center gap-1 px-3 pt-3 sm:px-5">
        {!triage && (
          <>
            <Button size="icon-sm" variant="ghost" aria-label="Предыдущая позиция (↑)" title="Предыдущая позиция (↑)" disabled={!prev} onClick={() => prev && openPosition(prev)}>
              <ChevronUp />
            </Button>
            <Button size="icon-sm" variant="ghost" aria-label="Следующая позиция (↓)" title="Следующая позиция (↓)" disabled={!next} onClick={() => next && openPosition(next)}>
              <ChevronDown />
            </Button>
            {i >= 0 && (
              <span className="shrink-0 px-1 text-xs text-muted-foreground tabular-nums">
                {i + 1} из {ids.length}
              </span>
            )}
          </>
        )}
        <SheetTitle tabIndex={-1} className="min-w-0 flex-1 truncate px-1 text-base font-semibold outline-none" title={pos?.name}>
          {pos?.name ?? 'Позиция удалена'}
        </SheetTitle>
        <Button size="icon-sm" variant="ghost" aria-label="Закрыть" title="Закрыть (Esc)" onClick={closeSheet}>
          <X />
        </Button>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-3 pt-1 pb-3 sm:px-5">
        {pos && (
          <>
            <SheetDescription className="min-w-0 truncate text-xs">{fileNames(pos)}</SheetDescription>
            <PdfBadge p={pos} />
            <StatusCell items={items} inScope={inScope} word />
          </>
        )}
      </div>
    </div>
  );
}

// ---------- тело карточки позиции ----------

function PositionBody({ sheet }: { sheet: Extract<SheetState, { kind: 'position' }> }): ReactElement {
  const id = sheet.id;
  const d = useDerived();
  const { base, pos } = useLivePosition(id);
  const ai = useStore((s) => s.order.ai);
  const markupPct = useStore((s) => s.order.markupPct);
  const settings = useStore((s) => s.settings);
  const triageItem = useStore((s) => (s.ui.triage ? s.ui.triage.ids[s.ui.triage.index] : null));
  const changes = useMemo(() => (base && ai ? changesFor(base, ai) : []), [base, ai]);
  const offers = useMemo(() => (base && ai ? pendingOffers(ai, [base]).map((o) => o.s) : []), [base, ai]);
  // запрос «Задать габарит» (каждый новый — снова открыть форму и поставить фокус); только для той позиции,
  // для которой он был: ↑/↓ к соседней не открывают у неё форму и не забирают фокус
  const [dims, setDims] = useState({ id, n: 0 });
  useEffect(() => {
    if (sheet.focus === 'dims') setDims((x) => ({ id: sheet.id, n: x.n + 1 }));
  }, [sheet]);
  const dimsNonce = dims.id === id ? dims.n : 0;

  if (!base || !pos) {
    return (
      <div className="p-5 text-sm text-muted-foreground">
        Позиции больше нет в заказе.{' '}
        <Button variant="link" size="sm" className="px-0" onClick={closeSheet}>
          Закрыть
        </Button>
      </div>
    );
  }
  const r = d.res.positions.get(id);
  const g = r ? d.res.groups.find((x) => x.key === r.groupKey) : undefined;
  const line = d.quote.linesById.get(id);
  const kop = d.quote.settings.rounding === 'kop';
  const items = d.attention.byPosition.get(id) ?? [];
  const kinds = new Set<AttentionKind>(d.attention.items.filter((i) => i.positionId === id).map((i) => i.kind));
  const warnings = uncoveredWarnings(pos, r, kinds);
  const unpriced = isUnpriced(pos);
  const off = !!pos.disabled;
  const showDims = !base.pdf && (unpriced || dimsNonce > 0);

  return (
    <div className={cn('space-y-6 px-3 py-4 transition-opacity sm:px-5', d.stale && 'opacity-90')}>
      {items.length > 0 && (
        <section aria-labelledby="att-h" className="space-y-2">
          <h3 id="att-h" className="text-sm font-semibold">
            Требует внимания
          </h3>
          <div className="space-y-1">
            {items.map((it) => (
              <AttentionItemView key={it.id} item={it} dense={false} current={it.id === triageItem} />
            ))}
          </div>
        </section>
      )}

      <p className={cn('rounded-md px-3 py-2 text-sm', unpriced ? 'bg-danger-soft text-danger' : 'bg-muted/60')}>
        {off ? (
          'Позиция исключена из расчёта.'
        ) : unpriced ? (
          'Цена не посчитана: нет размеров'
        ) : r ? (
          <>
            Цена за 1 шт: себестоимость <Money value={r.piece.total} /> → клиенту <Money value={line?.price} kop={kop} className="font-medium" /> × {n0(pos.qty)}
            {NBSP}шт = <Money value={line?.sum} kop={kop} className="font-semibold" />
          </>
        ) : (
          '—'
        )}
      </p>

      <ParamsSection base={base} pos={pos} changes={changes} offers={offers} />

      {showDims && (
        <section aria-labelledby="dims-h" className="space-y-2">
          <h3 id="dims-h" className="text-sm font-semibold">
            Габарит вручную
          </h3>
          <ManualDims p={base} autoFocus={dimsNonce} onDone={() => setDims({ id, n: 0 })} />
        </section>
      )}

      <DrawingSection key={`drawing-${id}`} p={pos} />

      {base.pdf && <PdfBlock key={`pdf-${id}`} base={base} pos={pos} focusDims={dimsNonce} />}

      <div data-sheet-focus="ai">
        <AiReviewSection positionId={id} />
      </div>

      <PriceSteps p={pos} r={r} g={g} line={line} kop={kop} settings={settings} markupPct={markupPct} unpriced={unpriced} />

      <ExtrasEditor base={base} pos={pos} r={r} />

      <section className="space-y-2">
        <label htmlFor={`note-${id}`} className="text-sm font-semibold">
          Примечание — попадёт в КП
        </label>
        <Textarea
          id={`note-${id}`}
          rows={2}
          value={base.note ?? ''}
          placeholder="Например: из двух частей, без вальцовки"
          onChange={(e) => editPosition(id, { note: e.target.value })}
        />
      </section>

      {warnings.length > 0 && (
        <section aria-labelledby="warn-h" className="space-y-2">
          <h3 id="warn-h" className="text-sm font-semibold">
            Предупреждения
          </h3>
          <ul className="space-y-1 text-sm text-warn">
            {warnings.map((w) => (
              <li key={w}>⚠ {w}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function PositionFooter({ id }: { id: string }): ReactElement | null {
  const { pos } = useLivePosition(id);
  if (!pos) return null;
  const off = !!pos.disabled;
  return (
    <div className="flex flex-wrap items-center gap-2 border-t px-3 py-3 sm:px-5">
      <Button
        size="sm"
        variant="outline"
        title="Дублировать"
        onClick={() => {
          const copy = duplicatePosition(id);
          if (copy) flashRow(copy);
        }}
      >
        <CopyPlus />
        <span className="max-sm:sr-only">Дублировать</span>
      </Button>
      <Button size="sm" variant="outline" onClick={() => editPosition(id, { disabled: !off })}>
        <CircleMinus />
        {off ? 'Включить в расчёт' : 'Исключить из расчёта'}
      </Button>
      <Button size="sm" variant="destructive" className="ml-auto" title="Удалить" onClick={() => removePositions([id])}>
        <Trash2 />
        <span className="max-sm:sr-only">Удалить</span>
      </Button>
    </div>
  );
}

// ---------- панель ----------

export function PositionSheet(): ReactElement | null {
  const sheet = useStore((s) => s.ui.sheet);
  const phone = useMediaQuery('(max-width: 767px)');
  const ids = useVisibleIds();
  const content = useRef<HTMLDivElement>(null);
  const lastId = useRef<string | null>(null);
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const open = sheet?.kind === 'position' || sheet?.kind === 'item';
  const posId = sheet?.kind === 'position' ? sheet.id : null;
  if (posId) lastId.current = posId;

  // фокус на поле из запроса (openPosition(id, { focus })): прокрутить к нему и поставить курсор
  useEffect(() => {
    if (sheet?.kind !== 'position' || !sheet.focus || sheet.focus === 'dims') return;
    const t = setTimeout(() => {
      const box = content.current?.querySelector<HTMLElement>(`[data-sheet-focus="${sheet.focus}"]`);
      if (!box) return;
      box.scrollIntoView({ block: 'center' });
      box.querySelector<HTMLElement>('input, textarea, button, [tabindex]:not([tabindex="-1"])')?.focus();
    }, 60);
    return () => clearTimeout(t);
  }, [sheet]);

  if (!open) return null;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // события из всплывающих списков (портал) и уже обработанные (Select, меню) — не наши
    if (e.defaultPrevented || !e.currentTarget.contains(e.target as Node)) return;
    if (isEditable(e.target) || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const down = e.key === 'ArrowDown';
    const up = e.key === 'ArrowUp';
    if (getState().ui.triage) {
      if (down || e.code === 'KeyJ') {
        e.preventDefault();
        triageNext();
      } else if (up || e.code === 'KeyK') {
        e.preventDefault();
        triagePrev();
      }
      return;
    }
    const cur = getState().ui.sheet;
    if ((!down && !up) || cur?.kind !== 'position') return;
    e.preventDefault();
    const list = idsRef.current;
    const i = list.indexOf(cur.id);
    const next = i < 0 ? list[0] : list[i + (down ? 1 : -1)];
    if (next) openPosition(next);
  };

  return (
    <Sheet open modal={false} onOpenChange={(o) => !o && closeSheet()}>
      <SheetContent
        ref={content}
        side={phone ? 'bottom' : 'right'}
        showCloseButton={false}
        aria-label={posId ? 'Карточка позиции' : 'Замечание'}
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => {
          // Esc в поле — сначала вернуть значение; следующий Esc закрывает
          if (isEditable(e.target)) e.preventDefault();
        }}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          content.current?.querySelector<HTMLElement>('[data-slot=sheet-title]')?.focus();
        }}
        onCloseAutoFocus={(e) => {
          // фокус — обратно на строку таблицы
          e.preventDefault();
          const id = lastId.current;
          if (id) document.querySelector<HTMLElement>(`tr[data-row-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
        }}
        onKeyDown={onKeyDown}
        className="gap-0 p-0 data-[side=bottom]:h-[92dvh] data-[side=bottom]:rounded-t-xl data-[side=right]:w-full data-[side=right]:sm:max-w-[640px] data-[side=right]:2xl:max-w-[760px]"
      >
        {sheet.kind === 'position' ? (
          <>
            <NavHeader id={sheet.id} ids={ids} />
            <ScrollArea className="min-h-0 flex-1">
              <PositionBody sheet={sheet} />
            </ScrollArea>
            <PositionFooter id={sheet.id} />
          </>
        ) : (
          <>
            <div className="border-b">
              <TriageHeader />
              <div className="flex items-center gap-2 px-3 py-3 sm:px-5">
                <SheetTitle tabIndex={-1} className="min-w-0 flex-1 truncate text-base font-semibold outline-none">
                  Замечание по заказу
                </SheetTitle>
                <SheetDescription className="sr-only">Замечание из списка «Требует внимания»</SheetDescription>
                <Button size="icon-sm" variant="ghost" aria-label="Закрыть" title="Закрыть (Esc)" onClick={closeSheet}>
                  <X />
                </Button>
              </div>
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <div className="px-3 py-4 sm:px-5">
                <AttentionItemPanel itemId={sheet.itemId} />
              </div>
            </ScrollArea>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
