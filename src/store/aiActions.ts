// Решения по предложениям ИИ (с «Отменить»/«Вернуть»), «Верно» по замечаниям, кнопки замечаний и разбор
// по очереди (ui-spec §4.5, §2.7). Разбор: снимок открытых замечаний; закрылось текущее — через 250 мс следующее.
import { toast } from 'sonner';
import { FIELD_OF, pendingOffers, resetSuggestion, revertAll, reviewFor, toggleSuggestion } from '../ai/apply.ts';
import { focusOf, type AttentionAction, type AttentionItem } from '../attention.ts';
import { fieldLabel, formatAiValue, suggestionLabel } from '../components/common/aiFormat.ts';
import type { AiAnalysis, AiState, AiSuggestion } from '../core/ai.ts';
import { plural } from '../format.ts';
import { openDialog, openPosition, openSheet, setFilter, setTab } from './actions.ts';
import { getDerived } from './derived.tsx';
import { refreshPrices, runAnalysis } from './pipelineActions.ts';
import { appStore, getState, patchUi, setOrder } from './store.ts';
import { undoToast } from './undo.ts';

// ---------- решения ----------

type Prev = Record<string, boolean | undefined>;

/** Изменить решения; возвращает прежние значения изменившихся ключей (для «Отменить») */
function decide(fn: (ai: AiState) => AiState): { prev: Prev; analysis: AiAnalysis } | null {
  const out: { v: { prev: Prev; analysis: AiAnalysis } | null } = { v: null };
  setOrder((o) => {
    if (!o.ai) return o;
    const next = fn(o.ai);
    if (next === o.ai) return o;
    const prev: Prev = {};
    for (const k of new Set([...Object.keys(o.ai.accepted), ...Object.keys(next.accepted)])) {
      if (o.ai.accepted[k] !== next.accepted[k]) prev[k] = o.ai.accepted[k];
    }
    if (!Object.keys(prev).length) return o;
    out.v = { prev, analysis: o.ai.analysis };
    return { ...o, ai: next };
  });
  if (out.v) scheduleTriageCheck();
  return out.v;
}

/** Вернуть прежние решения (только если анализ тот же) */
function restore(r: { prev: Prev; analysis: AiAnalysis }) {
  setOrder((o) => {
    if (!o.ai || o.ai.analysis !== r.analysis) return o;
    const accepted = { ...o.ai.accepted };
    for (const [k, v] of Object.entries(r.prev)) {
      if (v === undefined) delete accepted[k];
      else accepted[k] = v;
    }
    return { ...o, ai: { ...o.ai, accepted } };
  });
}

function findSuggestion(ai: AiState | undefined, id: string): { positionId: string; s: AiSuggestion } | null {
  if (!ai) return null;
  for (const r of ai.analysis.positions) {
    const s = r.suggestions.find((x) => x.id === id);
    if (s) return { positionId: r.id, s };
  }
  return null;
}

const positionName = (id: string) => getState().order.positions.find((p) => p.id === id)?.name ?? 'Позиция';

/** «Материал 08пс х/к по предложению ИИ», «… — 3 поз.», «НГЭН… исключена из расчёта по предложению ИИ» */
function acceptedText(ids: string[]): string {
  const ai = getState().order.ai;
  const found = ids.map((id) => findSuggestion(ai, id)).filter((x): x is { positionId: string; s: AiSuggestion } => !!x);
  if (!found.length) return 'Предложение ИИ принято';
  const one = found[0].s;
  const label = suggestionLabel(one);
  const same = found.every((f) => suggestionLabel(f.s) === label && f.s.kind === one.kind);
  if (!same) return `Принято ${found.length} ${plural(found.length, 'предложение', 'предложения', 'предложений')} ИИ`;
  const tail = found.length > 1 ? ` — ${found.length} поз.` : '';
  if (one.kind === 'disable')
    return found.length > 1 ? `Исключены из расчёта по предложению ИИ${tail}` : `${positionName(found[0].positionId)} исключена из расчёта по предложению ИИ`;
  if (one.kind === 'extra') return `Доп. работа «${(one.label ?? '').trim()}» по предложению ИИ${tail}`;
  if (one.kind === 'bends') return `${formatAiValue('bends', one.value)} по предложению ИИ${tail}`;
  return `${fieldLabel(FIELD_OF[one.kind])} ${label} по предложению ИИ${tail}`;
}

/** Принять предложения (одно на поле позиции); уведомление «… по предложению ИИ · Отменить» */
export function acceptSuggestions(ids: string[], opts: { toast?: boolean } = {}): void {
  if (!ids.length) return;
  const message = acceptedText(ids);
  const r = decide((ai) => ids.reduce((x, id) => toggleSuggestion(x, id, true), ai));
  if (r && opts.toast !== false) undoToast({ message, actionLabel: 'Отменить', undo: () => restore(r) });
}

/** Отклонить предложения (или снять применённые); уведомление с «Вернуть» */
export function rejectSuggestions(ids: string[], opts: { toast?: boolean; message?: string } = {}): void {
  if (!ids.length) return;
  const r = decide((ai) => ids.reduce((x, id) => toggleSuggestion(x, id, false), ai));
  const message =
    opts.message ??
    (ids.length > 1 ? `Отклонено ${ids.length} ${plural(ids.length, 'предложение', 'предложения', 'предложений')} ИИ` : 'Предложение ИИ отклонено');
  if (r && opts.toast !== false) undoToast({ message, undo: () => restore(r) });
}

/** Вернуть в «ждёт решения» */
export function resetSuggestions(ids: string[]): void {
  decide((ai) => ids.reduce(resetSuggestion, ai));
}

/** Переключатель «Учитывать» в карточке позиции (без уведомления: переключатель виден сам) */
export function setSuggestion(id: string, on: boolean): void {
  decide((ai) => toggleSuggestion(ai, id, on));
}

/** «Принять все предложения»: все ждущие решения, по одному на поле позиции */
export function acceptAllPending(): void {
  const o = getState().order;
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const { positionId, s } of pendingOffers(o.ai, o.positions)) {
    const k = `${positionId}|${s.kind}`;
    if (s.kind !== 'extra' && seen.has(k)) continue;
    seen.add(k);
    ids.push(s.id);
  }
  if (!ids.length) return;
  const r = decide((ai) => ids.reduce((x, id) => toggleSuggestion(x, id, true), ai));
  if (r)
    undoToast({
      message: `Принято ${ids.length} ${plural(ids.length, 'предложение', 'предложения', 'предложений')} ИИ`,
      actionLabel: 'Отменить',
      undo: () => restore(r),
    });
}

/** «Отменить изменения ИИ»: все применённые → отклонены; «Вернуть» — прежние решения */
export function revertAllAi(): void {
  const r = decide(revertAll);
  if (r) undoToast({ message: 'Изменения ИИ отменены', undo: () => restore(r) });
}

// ---------- «Верно» ----------

const GUESS_KIND = { material: 'material', thickness: 'thickness', qty: 'qty' } as const;

/** «Верно»: замечание проверено человеком. У «не найдено в файлах» ещё снимается «угадано» и
 *  отклоняются ждущие решения предложения ИИ по этому полю (на хэш анализа это не влияет) */
export function acknowledge(itemId: string): void {
  const item = getDerived().attention.items.find((x) => x.id === itemId);
  const at = new Date().toISOString();
  setOrder((o) => {
    let next = { ...o, checks: { ...(o.checks ?? {}), [itemId]: at } };
    if (item?.kind === 'guessed' && item.positionId) {
      const field = itemId.split(':')[2] as keyof typeof GUESS_KIND;
      const kind = GUESS_KIND[field];
      if (kind) {
        next = {
          ...next,
          positions: next.positions.map((p) => (p.id === item.positionId && p.guessed[field] ? { ...p, guessed: { ...p.guessed, [field]: false } } : p)),
        };
        const review = reviewFor(next.ai, item.positionId);
        if (next.ai && review) {
          const accepted = { ...next.ai.accepted };
          for (const s of review.suggestions) if (s.kind === kind && accepted[s.id] === undefined) accepted[s.id] = false;
          next = { ...next, ai: { ...next.ai, accepted } };
        }
      }
    }
    return next;
  });
  scheduleTriageCheck();
}

// ---------- кнопки замечаний ----------

/** Вкладка «Металл и раскрой» и карточка группы (data-group у GroupCard) в поле зрения */
function revealGroup(groupKey: string) {
  setTab('metal');
  let tries = 0;
  const key = CSS.escape(groupKey);
  const find = () => {
    const el = document.querySelector<HTMLElement>(`[data-group="${key}"], [data-group-key="${key}"]`);
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      if (el.tabIndex < 0 && !el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
      el.focus({ preventScroll: true });
    } else if (tries++ < 10) requestAnimationFrame(find);
  };
  requestAnimationFrame(find);
}

export function runAttentionAction(item: AttentionItem, action: AttentionAction): void {
  switch (action.kind) {
    case 'open':
      openPosition(action.positionId, { focus: action.focus, reveal: true });
      return;
    case 'ack':
      acknowledge(item.id);
      return;
    case 'accept':
      acceptSuggestions(action.suggestionIds);
      return;
    case 'reject':
      rejectSuggestions(action.suggestionIds);
      return;
    case 'revert':
      rejectSuggestions(action.suggestionIds, { message: 'Изменение ИИ отменено' });
      return;
    case 'setDims':
      openPosition(action.positionId, { focus: 'dims', reveal: true });
      return;
    case 'drawing':
      openDialog({ kind: 'pdfReview', id: action.positionId });
      return;
    case 'addPart':
      openDialog({ kind: 'manual', prefill: { name: action.name, qty: action.qty } });
      return;
    case 'group':
      revealGroup(action.groupKey);
      return;
    case 'refreshPrices':
      void refreshPrices();
      return;
    case 'runAi':
      void runAnalysis();
      return;
    case 'filter':
      setFilter(action.filter);
      setTab('positions');
      return;
  }
}

// ---------- разбор по очереди ----------

/** Открыть замечание в панели: позиция — её карточка (строка подсвечена), заказ — панель замечания */
function openItem(item: AttentionItem) {
  if (item.positionId) openPosition(item.positionId, { reveal: true, focus: focusOf(item) });
  else openSheet({ kind: 'item', itemId: item.id });
}

const openById = () => new Map(getDerived().attention.open.map((x) => [x.id, x]));

function go(index: number, item: AttentionItem) {
  const t = getState().ui.triage;
  if (!t) return;
  patchUi({ triage: { ids: t.ids, index } });
  openItem(item);
}

/** «Разобрать по очереди»: снимок открытых проблем и замечаний «проверить» в порядке разбора */
export function startTriage(): void {
  const open = getDerived().attention.open;
  if (!open.length) {
    toast.success('Все замечания разобраны');
    return;
  }
  patchUi({ triage: { ids: open.map((x) => x.id), index: 0 } });
  openItem(open[0]);
}

/** Следующее открытое; после последнего — пропущенные раньше, затем появившиеся за время разбора
 *  (например, принятая толщина разошлась с массой по чертежу); открытых нет — разбор закончен */
export function triageNext(): void {
  const t = getState().ui.triage;
  if (!t) return;
  const open = openById();
  for (let j = t.index + 1; j < t.ids.length; j++) {
    const x = open.get(t.ids[j]);
    if (x) return go(j, x);
  }
  for (let j = 0; j < t.index; j++) {
    const x = open.get(t.ids[j]);
    if (x) return go(j, x);
  }
  if (open.has(t.ids[t.index])) return;
  const known = new Set(t.ids);
  const fresh = [...open.values()].filter((x) => !known.has(x.id));
  if (!fresh.length) return endTriage('done');
  patchUi({ triage: { ids: [...t.ids, ...fresh.map((x) => x.id)], index: t.ids.length } });
  openItem(fresh[0]);
}

export function triagePrev(): void {
  const t = getState().ui.triage;
  if (!t) return;
  const open = openById();
  for (let j = t.index - 1; j >= 0; j--) {
    const x = open.get(t.ids[j]);
    if (x) return go(j, x);
  }
}

/** Закончить разбор; 'done' — «Все замечания разобраны» (панель остаётся на последнем) */
export function endTriage(reason: 'done' | 'user' = 'user'): void {
  if (getState().ui.triage) patchUi({ triage: null });
  if (reason === 'done') toast.success('Все замечания разобраны');
}

// автопереход: текущее замечание закрыто (любым действием) — через 250 мс следующее
let timer: ReturnType<typeof setTimeout> | null = null;

function scheduleTriageCheck() {
  if (!getState().ui.triage) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    const t = getState().ui.triage;
    if (t && !openById().has(t.ids[t.index])) triageNext();
  }, 250);
}

let prevOrder = getState().order;
appStore.subscribe(() => {
  const o = getState().order;
  if (o === prevOrder) return;
  prevOrder = o;
  scheduleTriageCheck();
});
