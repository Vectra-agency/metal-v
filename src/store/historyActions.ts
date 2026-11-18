// Действия с историей заказов: сохранить заказ, найти ту же деталь и похожие в прошлых заказах,
// внести счёт цеха, открыть заказ из истории, удалить, выгрузить и загрузить историю, выйти.
import { toast } from 'sonner';
import { cyrb53, stableStringify } from '../ai/context.ts';
import type { AiDocument } from '../core/ai.ts';
import type { HistoryInvoice, HistoryOrder } from '../core/history.ts';
import { invoiceTotals } from '../core/history.ts';
import type { ParsedInvoice } from '../core/invoice.ts';
import { plural, rub0 } from '../format.ts';
import {
  authStatus,
  deleteHistoryOrder,
  deleteInvoice,
  exportHistory,
  getHistoryOrder,
  HistoryApiError,
  importHistory,
  matchHistory,
  putHistoryOrder,
  putInvoice,
} from '../history/api.ts';
import { historyHash, historyOrderFrom, matchQueries, newHistoryId, orderFromHistory } from '../history/build.ts';
import { draftInvoice, invoiceFromPdf } from '../history/invoicePdf.ts';
import type { OrderHistoryRef } from '../order.ts';
import { closeDialog, openDialog, openSheet } from './actions.ts';
import { getDerived } from './derived.tsx';
import { openOrder } from './pipelineActions.ts';
import { getState, patchHistory, setOrder } from './store.ts';
import type { HistoryTab } from './types.ts';
import { orderEpoch, undoToast } from './undo.ts';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const bump = () => patchHistory({ version: getState().history.version + 1 });

function invoiceRef(h: HistoryOrder): OrderHistoryRef['invoice'] {
  if (!h.invoice) return null;
  const t = invoiceTotals(h);
  return { number: h.invoice.number, date: h.invoice.date, supplier: h.invoice.supplier, fact: t.fact, calc: t.calc };
}

/** Поправить ссылку текущего заказа на запись истории (null — убрать); заказ связан с другой записью или ни с какой — не трогаем */
function linkOrder(id: string, patch: Partial<OrderHistoryRef> | null): void {
  setOrder((o) => {
    if (o.history?.id !== id) return o;
    if (patch === null) {
      const { history: _h, ...rest } = o;
      return rest;
    }
    return { ...o, history: { ...o.history, ...patch, id } };
  });
}

export function openHistory(tab?: HistoryTab): void {
  openSheet({ kind: 'history', tab });
}

// ---------- поиск той же детали и похожих ----------

let matchTimer: ReturnType<typeof setTimeout> | null = null;
let matchCtl: AbortController | null = null;

/** Позиции изменились — через паузу спросить сервер, что из них уже было в прошлых заказах */
export function scheduleHistoryMatch(delay = 700): void {
  if (getState().history.available === false) return;
  if (matchTimer) clearTimeout(matchTimer);
  matchTimer = setTimeout(() => void runMatch(), delay);
}

async function runMatch(): Promise<void> {
  matchTimer = null;
  const s = getState();
  if (!s.prices.live) return; // статическая версия без сервера
  const d = getDerived();
  const parts = matchQueries(d.positions, d.res);
  const exclude = s.order.history?.id;
  const key = cyrb53(stableStringify({ parts, exclude, v: s.history.version })).toString(36);
  if (key === s.history.matchKey) return;
  if (!parts.length) {
    patchHistory({ matches: {}, matchKey: key });
    return;
  }
  matchCtl?.abort();
  const ctl = new AbortController();
  matchCtl = ctl;
  try {
    const r = await matchHistory(parts, exclude, ctl.signal);
    if (ctl.signal.aborted) return;
    patchHistory({ matches: r.matches, matchKey: key, orders: r.orders, available: true });
  } catch (e) {
    if (ctl.signal.aborted) return;
    if (e instanceof HistoryApiError && e.status === 0) patchHistory({ available: false });
    else console.warn('история: поиск не удался', e);
  }
}

// ---------- сохранение ----------

/** Сохранить заказ в историю (обновить свою запись; asNew — отдельной новой записью). Счёт цеха в истории не трогаем */
export async function saveToHistory(opts: { asNew?: boolean; quiet?: boolean } = {}): Promise<HistoryOrder | null> {
  const s = getState();
  if (s.history.busy) return null;
  const d = getDerived();
  if (!d.positions.length) return null;
  const prevId = s.order.history?.id;
  const id = (!opts.asNew && prevId) || newHistoryId();
  const { invoice: _inv, ...body } = historyOrderFrom(s.order, d.positions, d.res, id);
  const hash = historyHash(s.order, d.positions);
  const epoch = orderEpoch();
  patchHistory({ busy: 'Сохраняю в историю…' });
  try {
    const saved = await putHistoryOrder(body);
    // за время запроса мог начаться другой заказ («Новый заказ», открыт из истории) — ссылку пишем, только если заказ тот же
    if (orderEpoch() === epoch && getState().order.history?.id === prevId)
      setOrder((o) => ({ ...o, history: { id, savedAt: saved.updatedAt, hash, invoice: invoiceRef(saved) } }));
    patchHistory({ busy: null, available: true, matchKey: '' });
    bump();
    if (!opts.quiet) {
      toast.success(prevId && !opts.asNew ? 'Заказ в истории обновлён' : 'Заказ сохранён в историю', {
        description: saved.invoice ? undefined : 'Когда придёт счёт цеха, внесите его — расчёт сверится с фактом',
      });
    }
    return saved;
  } catch (e) {
    patchHistory({ busy: null });
    toast.error(`Не удалось сохранить в историю: ${errText(e)}`);
    return null;
  }
}

// ---------- счёт цеха ----------

/** Выбор файла из кода: input.click() — синхронно в обработчике нажатия */
function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

async function openInvoiceDialog(h: HistoryOrder, inv: ParsedInvoice, fileName: string): Promise<void> {
  openDialog({ kind: 'invoice', order: h, draft: draftInvoice(inv, h, fileName) });
}

/** Счёт к текущему заказу: из PDF (выбрать файл) или из документа заказа. Заказ сначала сохраняется (или обновляется) в истории */
export async function invoiceForCurrent(source: { doc: AiDocument; inv: ParsedInvoice } | null = null): Promise<void> {
  const file = source ? null : await pickFile('.pdf,application/pdf');
  if (!source && !file) return;
  const t = toast.loading('Читаю счёт…');
  try {
    const inv = source ? source.inv : await invoiceFromPdf(file!);
    const s = getState();
    const d = getDerived();
    const changed = !s.order.history || historyHash(s.order, d.positions) !== s.order.history.hash;
    const h = changed ? await saveToHistory({ quiet: true }) : await getHistoryOrder(s.order.history!.id).catch(() => saveToHistory({ quiet: true }));
    toast.dismiss(t);
    if (!h) return;
    await openInvoiceDialog(h, inv, source ? source.doc.fileName : file!.name);
  } catch (e) {
    toast.dismiss(t);
    toast.error(errText(e));
  }
}

/** Счёт к заказу из истории (панель «История») */
export async function invoiceForHistory(id: string): Promise<void> {
  const file = await pickFile('.pdf,application/pdf');
  if (!file) return;
  const t = toast.loading('Читаю счёт…');
  try {
    const [inv, h] = await Promise.all([invoiceFromPdf(file), getHistoryOrder(id)]);
    toast.dismiss(t);
    await openInvoiceDialog(h, inv, file.name);
  } catch (e) {
    toast.dismiss(t);
    toast.error(errText(e));
  }
}

/** Изменить уже внесённый счёт (сопоставление строк) */
export async function editInvoice(id: string): Promise<void> {
  try {
    const h = await getHistoryOrder(id);
    if (h.invoice) openDialog({ kind: 'invoice', order: h, draft: structuredClone(h.invoice) });
  } catch (e) {
    toast.error(errText(e));
  }
}

const pctText = (fact: number, calc: number) => {
  if (!(fact > 0) || !(calc > 0)) return '';
  const d = Math.round(((calc - fact) / fact) * 100);
  return d === 0 ? 'расчёт совпал со счётом' : `расчёт ${d > 0 ? 'выше' : 'ниже'} счёта на ${Math.abs(d)} %`;
};

export async function saveInvoice(order: HistoryOrder, invoice: HistoryInvoice): Promise<boolean> {
  try {
    const saved = await putInvoice(order.id, invoice);
    linkOrder(order.id, { invoice: invoiceRef(saved) });
    closeDialog();
    bump();
    patchHistory({ matchKey: '' });
    const t = invoiceTotals(saved);
    const n = saved.invoice?.lines.filter((l) => l.partIds.length).length ?? 0;
    toast.success(`Счёт № ${invoice.number || 'б/н'} сохранён`, {
      description: n ? `${n} ${plural(n, 'строка', 'строки', 'строк')} отнесено к деталям: ${rub0(t.fact)} по счёту, ${pctText(t.fact, t.calc)}` : 'Строки счёта не отнесены к деталям',
    });
    return true;
  } catch (e) {
    toast.error(`Не удалось сохранить счёт: ${errText(e)}`);
    return false;
  }
}

export async function removeInvoice(order: HistoryOrder): Promise<void> {
  const prev = order.invoice;
  try {
    await deleteInvoice(order.id);
    linkOrder(order.id, { invoice: null });
    closeDialog();
    bump();
    patchHistory({ matchKey: '' });
    if (prev)
      undoToast({
        message: `Счёт № ${prev.number || 'б/н'} убран из истории`,
        undo: () =>
          void putInvoice(order.id, prev).then((h) => {
            linkOrder(order.id, { invoice: invoiceRef(h) });
            bump();
          }),
      });
  } catch (e) {
    toast.error(`Не удалось убрать счёт: ${errText(e)}`);
  }
}

// ---------- открыть, удалить ----------

export async function openFromHistory(id: string): Promise<void> {
  try {
    const h = await getHistoryOrder(id);
    openOrder(orderFromHistory(h), `Открыт заказ из истории${h.title ? ` «${h.title}»` : ''}`);
    patchHistory({ matchKey: '' });
  } catch (e) {
    toast.error(`Не удалось открыть заказ: ${errText(e)}`);
  }
}

export async function removeFromHistory(id: string): Promise<void> {
  try {
    const gone = await deleteHistoryOrder(id);
    const linked = getState().order.history;
    linkOrder(id, null);
    bump();
    patchHistory({ matchKey: '' });
    undoToast({
      message: `Заказ${gone.title ? ` «${gone.title}»` : ''} удалён из истории`,
      undo: () =>
        void putHistoryOrder(gone).then(() => {
          if (linked?.id === id && !getState().order.history) setOrder((o) => ({ ...o, history: linked }));
          bump();
          patchHistory({ matchKey: '' });
        }),
    });
  } catch (e) {
    toast.error(`Не удалось удалить: ${errText(e)}`);
  }
}

// ---------- выгрузка и загрузка ----------

export async function downloadHistory(): Promise<void> {
  try {
    const data = await exportHistory();
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `history-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  } catch (e) {
    toast.error(`Не удалось выгрузить историю: ${errText(e)}`);
  }
}

const IMPORT_BATCH = 20; // тело запроса меньше 1 МБ (nginx)

export async function importHistoryFile(): Promise<void> {
  const file = await pickFile('.json,application/json');
  if (!file) return;
  let orders: unknown[];
  try {
    const j = JSON.parse(await file.text()) as { orders?: unknown };
    if (!Array.isArray(j.orders)) throw new Error('в файле нет списка orders');
    orders = j.orders;
  } catch (e) {
    toast.error(`«${file.name}» — не выгрузка истории: ${errText(e)}`);
    return;
  }
  const t = toast.loading(`Загружаю историю: 0 из ${orders.length}`);
  const sum = { added: 0, updated: 0, skipped: 0, errors: [] as string[] };
  try {
    for (let i = 0; i < orders.length; i += IMPORT_BATCH) {
      const r = await importHistory(orders.slice(i, i + IMPORT_BATCH));
      sum.added += r.added;
      sum.updated += r.updated;
      sum.skipped += r.skipped;
      sum.errors.push(...r.errors);
      toast.loading(`Загружаю историю: ${Math.min(i + IMPORT_BATCH, orders.length)} из ${orders.length}`, { id: t });
    }
    toast.dismiss(t);
    bump();
    patchHistory({ matchKey: '' });
    const msg = `Загружено: новых ${sum.added}, обновлено ${sum.updated}${sum.skipped ? `, пропущено ${sum.skipped}` : ''}`;
    if (sum.errors.length) toast.warning(msg, { description: sum.errors.slice(0, 3).join('\n') });
    else toast.success(msg);
  } catch (e) {
    toast.dismiss(t);
    toast.error(`Загрузка прервана: ${errText(e)}`);
  }
}

// ---------- вход ----------

export async function loadAuthStatus(): Promise<void> {
  patchHistory({ auth: await authStatus() });
}
