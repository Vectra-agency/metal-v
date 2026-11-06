// Простые синхронные действия (ui-spec §4.5, P0): правка заказа и позиций, расценки, настройки КП, интерфейс.
import { effectivePositions, manualEdit } from '../ai/apply.ts';
import type { SheetPolicy } from '../core/materials.ts';
import { MATERIAL_BY_ID } from '../core/materials.ts';
import { DEFAULT_SETTINGS, type Settings } from '../core/pricing.ts';
import { plural } from '../format.ts';
import { holdFiles } from '../idb.ts';
import { JOURNAL_MAX, newId, type JournalEntry, type Order, type OrderPosition } from '../order.ts';
import type { QuoteSettings } from '../quote.ts';
import { getState, merge, patchUi, setOrder, setState } from './store.ts';
import type { ColumnId, DialogState, SheetFocus, SheetState, SortKey, TabId, TableFilter } from './types.ts';
import { undoToast } from './undo.ts';

// ---------- заказ ----------

export function patchOrder(patch: Partial<Order>): void {
  setOrder((o) => merge(o, patch));
}

export function setTitle(title: string): void {
  patchOrder({ title });
}

/** Правка одной позиции внутри заказа: снимает «угадано» у правленых полей и предложения ИИ по ним */
function editIn(o: Order, id: string, patch: Partial<OrderPosition>): Order {
  const i = o.positions.findIndex((p) => p.id === id);
  if (i < 0) return o;
  const p = o.positions[i];
  const r = manualEdit(o.ai, id, patch);
  const g0 = r.patch.guessed ?? p.guessed;
  const guessed = {
    material: patch.materialId !== undefined ? false : g0.material,
    thickness: patch.thickness !== undefined ? false : g0.thickness,
    qty: patch.qty !== undefined ? false : g0.qty,
  };
  const same = guessed.material === p.guessed.material && guessed.thickness === p.guessed.thickness && guessed.qty === p.guessed.qty;
  const positions = o.positions.slice();
  const next: OrderPosition = { ...p, ...r.patch, guessed: same ? p.guessed : guessed };
  if (patch.bends !== undefined || patch.bendLength !== undefined) delete next.bendLengths;
  if (patch.qty !== undefined) delete next.qtySource;
  positions[i] = next;
  return r.ai === o.ai ? { ...o, positions } : { ...o, positions, ai: r.ai };
}

/** Все правки позиций — только здесь: значение пишется в базовую позицию, ИИ-предложение по полю снимается */
export function editPosition(id: string, patch: Partial<OrderPosition>): void {
  setOrder((o) => editIn(o, id, patch));
}

type BulkPatch = Pick<Partial<OrderPosition>, 'materialId' | 'thickness' | 'bends' | 'qty' | 'disabled'>;

/** То же, что editPosition для каждой позиции, одним изменением состояния */
export function bulkEdit(ids: string[], patch: BulkPatch): void {
  setOrder((o) => ids.reduce((acc, id) => editIn(acc, id, patch), o));
}

const removedText = (n: number) => `${plural(n, 'Удалена', 'Удалено', 'Удалено')} ${n} ${plural(n, 'позиция', 'позиции', 'позиций')}`;

/** Удаление сразу, с «Вернуть» (позиции встают на свои места) */
export function removePositions(ids: string[]): void {
  const set = new Set(ids);
  const removed = getState()
    .order.positions.map((p, index) => ({ p, index }))
    .filter((x) => set.has(x.p.id));
  if (!removed.length) return;
  setState((s) => {
    const sheetGone = s.ui.sheet?.kind === 'position' && set.has(s.ui.sheet.id);
    const dialogGone = s.ui.dialog?.kind === 'pdfReview' && set.has(s.ui.dialog.id);
    return {
      ...s,
      order: { ...s.order, positions: s.order.positions.filter((p) => !set.has(p.id)) },
      ui: {
        ...s.ui,
        selection: s.ui.selection.filter((id) => !set.has(id)),
        sheet: sheetGone ? null : s.ui.sheet,
        triage: sheetGone ? null : s.ui.triage,
        dialog: dialogGone ? null : s.ui.dialog,
        highlight: s.ui.highlight && set.has(s.ui.highlight) ? null : s.ui.highlight,
      },
    };
  });
  // PDF удалённых позиций не удаляются из браузера, пока можно «Вернуть»
  const release = holdFiles(removed.flatMap(({ p }) => (p.pdf?.fileKey ? [p.pdf.fileKey] : [])));
  undoToast({
    message: removedText(removed.length),
    orderScoped: true,
    undo: () => {
      release();
      setOrder((o) => {
        const have = new Set(o.positions.map((p) => p.id));
        const positions = o.positions.slice();
        for (const { p, index } of removed) if (!have.has(p.id)) positions.splice(Math.min(index, positions.length), 0, p);
        return positions.length === o.positions.length ? o : { ...o, positions };
      });
    },
    onExpire: release,
  });
}

/** Копия позиции сразу после неё: «{name} (копия)» — с теми значениями, что видны в строке (с принятыми
 *  предложениями ИИ: у копии они свои, ручные); возвращает id копии */
export function duplicatePosition(id: string): string | null {
  let created: string | null = null;
  setOrder((o) => {
    const i = o.positions.findIndex((p) => p.id === id);
    if (i < 0) return o;
    const src = o.positions[i];
    const eff = effectivePositions([src], o.ai)[0];
    created = newId();
    // строки доп. работ копии — обычные ручные (без привязки к предложениям ИИ исходной позиции)
    const extras = eff.extras.map((e) => ({ label: e.label, perPiece: e.perPiece }));
    const copy: OrderPosition = { ...structuredClone(eff), id: created, name: `${src.name} (копия)`, extras };
    // «исключить из расчёта» по ИИ копия не наследует
    if (src.disabled) copy.disabled = true;
    else delete copy.disabled;
    const positions = o.positions.slice();
    positions.splice(i + 1, 0, copy);
    return { ...o, positions };
  });
  return created;
}

const journalOf = (o: Order, entries: { level: JournalEntry['level']; text: string }[]): JournalEntry[] => {
  const at = new Date().toISOString();
  return [...(o.journal ?? []), ...entries.map((e) => ({ at, level: e.level, text: e.text }))].slice(-JOURNAL_MAX);
};

export function addManualPosition(p: OrderPosition): void {
  setOrder((o) => ({ ...o, positions: [...o.positions, p], journal: journalOf(o, [{ level: 'info', text: `Добавлена деталь без чертежа: ${p.name}` }]) }));
}

export function appendJournal(entries: { level: JournalEntry['level']; text: string }[]): void {
  if (!entries.length) return;
  setOrder((o) => ({ ...o, journal: journalOf(o, entries) }));
}

/** Наценка, % (0–1000) */
export function setMarkup(pct: number): void {
  if (!Number.isFinite(pct)) return;
  patchOrder({ markupPct: Math.min(1000, Math.max(0, pct)) });
}

/** Доставка на заказ, ₽ */
export function setDelivery(rub: number): void {
  if (!Number.isFinite(rub)) return;
  patchOrder({ delivery: Math.max(0, rub) });
}

/** Лист для группы «материал|толщина»; null — автовыбор */
export function setSheetChoice(groupKey: string, sheet: string | null): void {
  setOrder((o) => {
    const cur = o.sheetChoice[groupKey];
    if (sheet ? cur === sheet : cur === undefined) return o;
    const sheetChoice = { ...o.sheetChoice };
    if (sheet) sheetChoice[groupKey] = sheet;
    else delete sheetChoice[groupKey];
    return { ...o, sheetChoice };
  });
}

/** Своя цена металла ₽/кг для группы; null (или 0) — цена mc.ru */
export function setPriceOverride(groupKey: string, perKg: number | null): void {
  const v = perKg != null && Number.isFinite(perKg) && perKg > 0 ? perKg : null;
  setOrder((o) => {
    const cur = o.priceOverride[groupKey];
    if (v != null ? cur === v : cur === undefined) return o;
    const priceOverride = { ...o.priceOverride };
    if (v != null) priceOverride[groupKey] = v;
    else delete priceOverride[groupKey];
    return { ...o, priceOverride };
  });
}

export function removeDocument(fileName: string): void {
  const docs = getState().order.documents ?? [];
  const index = docs.findIndex((d) => d.fileName === fileName);
  if (index < 0) return;
  const doc = docs[index];
  setOrder((o) => ({ ...o, documents: (o.documents ?? []).filter((d) => d.fileName !== fileName) }));
  undoToast({
    message: 'Документ убран',
    orderScoped: true,
    undo: () =>
      setOrder((o) => {
        const list = (o.documents ?? []).slice();
        if (list.some((d) => d.fileName === fileName)) return o;
        list.splice(Math.min(index, list.length), 0, doc);
        return { ...o, documents: list };
      }),
  });
}

// ---------- расценки и КП ----------

export function setSettings(next: Settings): void {
  setState((s) => (s.settings === next ? s : { ...s, settings: next }));
}

export function patchSettings(patch: Partial<Settings>): void {
  setState((s) => {
    const settings = merge(s.settings, patch);
    return settings === s.settings ? s : { ...s, settings };
  });
}

/** Как цех списывает лист — для всех позиций материала; совпадает с обычным для материала — запись убирается */
export function setPolicy(materialId: string, policy: SheetPolicy): void {
  const cur = getState().settings.policy;
  if (policy === MATERIAL_BY_ID.get(materialId)?.policy) {
    if (!(materialId in cur)) return;
    const next = { ...cur };
    delete next[materialId];
    patchSettings({ policy: next });
  } else if (cur[materialId] !== policy) patchSettings({ policy: { ...cur, [materialId]: policy } });
}

/** «Сбросить»: только расценки (настройки КП и «Обновлять цены mc.ru старше» с вкладки «КП и цены» остаются), с «Вернуть» */
export function resetSettings(): void {
  const prev = getState().settings;
  setSettings({ ...structuredClone(DEFAULT_SETTINGS), priceMaxAgeHours: prev.priceMaxAgeHours });
  undoToast({ message: 'Расценки сброшены', undo: () => setSettings(prev) });
}

export function setQuoteSettings(patch: Partial<QuoteSettings>): void {
  setState((s) => {
    const quote = merge(s.quote, patch);
    return quote === s.quote ? s : { ...s, quote };
  });
}

// ---------- интерфейс ----------

export function setTab(tab: TabId): void {
  patchUi({ tab });
}

let flashTimer: ReturnType<typeof setTimeout> | null = null;

/** Вспышка строки таблицы (ui.flash) на 1,2 с; повтор для той же строки перезапускает её */
export function flashRow(id: string): void {
  if (flashTimer) clearTimeout(flashTimer);
  const start = () => {
    patchUi({ flash: id });
    flashTimer = setTimeout(() => {
      flashTimer = null;
      if (getState().ui.flash === id) patchUi({ flash: null });
    }, 1200);
  };
  if (getState().ui.flash === id) {
    patchUi({ flash: null });
    requestAnimationFrame(start);
  } else start();
}

/** Карточка позиции; reveal — перейти на вкладку «Позиции» и подсветить строку (таблица прокручивает к ней) */
export function openPosition(id: string, opts: { focus?: SheetFocus; reveal?: boolean } = {}): void {
  const sheet: SheetState = opts.focus ? { kind: 'position', id, focus: opts.focus } : { kind: 'position', id };
  patchUi(opts.reveal ? { sheet, tab: 'positions' } : { sheet });
  if (opts.reveal) flashRow(id);
}

/** Одна боковая панель за раз; «Заявка» и «Расценки» прерывают разбор замечаний */
export function openSheet(sheet: SheetState): void {
  patchUi(sheet.kind === 'request' || sheet.kind === 'settings' ? { sheet, triage: null } : { sheet });
}

/** Закрыть панель (и закончить разбор замечаний) */
export function closeSheet(): void {
  patchUi({ sheet: null, triage: null });
}

export function openDialog(d: DialogState): void {
  patchUi({ dialog: d });
}

export function closeDialog(): void {
  patchUi({ dialog: null });
}

export function setHighlight(id: string | null): void {
  patchUi({ highlight: id });
}

export function setSelection(ids: string[]): void {
  patchUi({ selection: ids });
}

export function toggleSelected(id: string): void {
  const sel = getState().ui.selection;
  setSelection(sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]);
}

export function clearSelection(): void {
  if (getState().ui.selection.length) setSelection([]);
}

export function setFilter(f: TableFilter): void {
  patchUi({ filter: f });
}

export function setSearch(q: string): void {
  patchUi({ search: q });
}

/** Сортировка по столбцу: по убыванию → по возрастанию → как в заказе (имя — сначала по возрастанию) */
export function cycleSort(key: SortKey): void {
  const s = getState().ui.sort;
  if (key === 'order') return patchUi({ sort: { key: 'order', dir: 1 } });
  const first: 1 | -1 = key === 'name' ? 1 : -1;
  if (s.key !== key) patchUi({ sort: { key, dir: first } });
  else if (s.dir === first) patchUi({ sort: { key, dir: first === 1 ? -1 : 1 } });
  else patchUi({ sort: { key: 'order', dir: 1 } });
}

export function setColumn(id: ColumnId, on: boolean): void {
  const cols = getState().ui.columns;
  if (cols[id] !== on) patchUi({ columns: { ...cols, [id]: on } });
}

export function setAiCardOpen(open: boolean): void {
  patchUi({ aiCardOpen: open });
}

export function setQuoteQuestions(on: boolean): void {
  patchUi({ quoteQuestions: on });
}
