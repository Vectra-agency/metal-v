// Отправка клиенту: копирование, CSV, печать (ui-spec §4.5, §7).
// Пока открыты замечания уровня «ошибка», копирование, CSV и печать для клиента сначала спрашивают (CopyGuardDialog);
// { force: true } — «Всё равно скопировать / напечатать».
import { flushSync } from 'react-dom';
import { toast } from 'sonner';
import { downloadText, exportCsv } from '../exportCsv.ts';
import { plural } from '../format.ts';
import { clientMoney, quoteCsv, quoteText, quoteTsv, safeFileName } from '../quote.ts';
import { openDialog, setTab } from './actions.ts';
import { getDerived } from './derived.tsx';
import { getState, patchUi } from './store.ts';
import type { AppState, GuardAction } from './types.ts';

export type CopyKind = 'text' | 'table' | 'questions';

/** Вопросы клиенту из анализа ИИ (пустые строки отброшены) */
export function clientQuestions(s: AppState = getState()): string[] {
  return (s.order.ai?.analysis.questions ?? []).map((q) => q.trim()).filter(Boolean);
}

/** Открытые замечания уровня «ошибка» → диалог вместо действия; true — действие остановлено */
function guarded(action: GuardAction, force?: boolean): boolean {
  if (force) return false;
  if (!getDerived().attention.open.some((i) => i.severity === 'problem')) return false;
  openDialog({ kind: 'guard', action });
  return true;
}

/** Нет позиций (или все исключены) — сказать и не продолжать */
function nothingToSend(what: string): boolean {
  if (!getState().order.positions.length) {
    toast(`Нет позиций — ${what} нечего`);
    return true;
  }
  if (!getDerived().quote.lines.length) {
    toast('Нет позиций для клиента: все исключены из расчёта');
    return true;
  }
  return false;
}

/** В буфер обмена; без Clipboard API (или без фокуса) — через скрытое поле и execCommand */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* запасной путь ниже */
  }
  const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const ta = document.createElement('textarea');
  try {
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
    document.body.append(ta);
    ta.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    ta.remove();
    prev?.focus({ preventScroll: true });
  }
}

const positionsWord = (n: number) => `${n} ${plural(n, 'позиция', 'позиции', 'позиций')}`;

/** «Скопировать для клиента» (текст), «таблицей» (TSV) или «с вопросами клиенту» */
export async function copyForClient(kind: CopyKind = 'text', opts: { force?: boolean } = {}): Promise<void> {
  if (nothingToSend('копировать')) return;
  if (guarded(kind === 'table' ? 'copyTable' : kind === 'questions' ? 'copyQuestions' : 'copy', opts.force)) return;
  const s = getState();
  const q = getDerived().quote;
  const withQuestions = kind === 'questions' || (kind === 'text' && s.ui.quoteQuestions);
  const text = kind === 'table' ? quoteTsv(q) : quoteText(q, withQuestions ? { questions: clientQuestions(s) } : {});
  if (await writeClipboard(text)) toast.success(`Скопировано для клиента: ${positionsWord(q.lines.length)}, итого ${clientMoney(q, q.total)}`);
  else
    toast.error('Не удалось скопировать — выделите текст на вкладке «Для клиента»', {
      action: { label: 'Открыть', onClick: () => setTab('quote') },
    });
}

/** «Excel для клиента (CSV)»: те же строки, что «таблицей» → «КП {название}.csv» */
export function downloadClientCsv(opts: { force?: boolean } = {}): void {
  if (nothingToSend('выгружать')) return;
  if (guarded('csv', opts.force)) return;
  const q = getDerived().quote;
  downloadText(`КП ${safeFileName(q.title) || 'расчёт'}.csv`, quoteCsv(q));
}

/** «Excel: внутренний расчёт» — позиции с принятыми предложениями ИИ, точные цены */
export function downloadInternalCsv(): void {
  const s = getState();
  if (!s.order.positions.length) {
    toast('Нет позиций — выгружать нечего');
    return;
  }
  const d = getDerived();
  exportCsv(s.order.title, d.positions, d.res, s.order.markupPct, d.quote.total);
}

// ---------- печать ----------

const PAGE_CSS: Record<'client' | 'internal', string> = {
  client: '@page { size: A4 portrait; margin: 15mm 12mm; }',
  internal: '@page { size: A4 landscape; margin: 10mm; }',
};

/** Что печатать (html[data-print]) и размер листа (<style id="print-page">) */
export function setPrintPage(mode: 'client' | 'internal'): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.print = mode;
  let el = document.getElementById('print-page');
  if (!el) {
    el = document.createElement('style');
    el.id = 'print-page';
    document.head.append(el);
  }
  if (el.textContent !== PAGE_CSS[mode]) el.textContent = PAGE_CSS[mode];
}

/** «Печать КП» и Ctrl+P: только КП для клиента, А4 книжный */
export function printClient(opts: { force?: boolean } = {}): void {
  if (nothingToSend('печатать')) return;
  if (guarded('print', opts.force)) return;
  if (getState().ui.printMode !== 'client') flushSync(() => patchUi({ printMode: 'client' }));
  setPrintPage('client');
  window.print();
}

/** «Печать расчёта (внутр.)»: А4 альбомный; после печати — снова КП (следующий Ctrl+P печатает КП) */
export function printInternal(): void {
  if (!getState().order.positions.length) {
    toast('Нет позиций — печатать нечего');
    return;
  }
  flushSync(() => patchUi({ printMode: 'internal' }));
  setPrintPage('internal');
  const restore = () => {
    window.removeEventListener('afterprint', restore);
    setPrintPage('client');
    patchUi({ printMode: 'client' });
  };
  window.addEventListener('afterprint', restore);
  window.print();
}
