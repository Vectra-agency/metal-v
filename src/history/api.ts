// Запросы к истории заказов на сервере (server/history.ts) и к входу (server/auth.ts).
import type { HistoryInvoice, HistoryMatch, HistoryOrder, HistorySummary, MatchQuery } from '../core/history.ts';

/** Ошибка API истории; status 0 — нет связи (или статическая версия без сервера) */
export class HistoryApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'HistoryApiError';
    this.status = status;
  }
}

async function call<T>(url: string, init: RequestInit = {}): Promise<T> {
  let r: Response;
  try {
    r = await fetch(url, { cache: 'no-store', ...init, headers: init.body ? { 'Content-Type': 'application/json', ...init.headers } : init.headers });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new HistoryApiError('Нет связи с сервером', 0);
  }
  const json = (r.headers.get('content-type') ?? '').includes('json');
  const j = json ? ((await r.json().catch(() => null)) as (T & { error?: string }) | null) : null;
  if (!r.ok || !j) throw new HistoryApiError(j?.error ?? (r.status === 404 && !json ? 'История доступна только на сервере' : `Ошибка ${r.status}`), json ? r.status : 0);
  return j;
}

export const listHistory = (signal?: AbortSignal) => call<{ orders: HistorySummary[] }>('/api/history', { signal }).then((r) => r.orders);
export const getHistoryOrder = (id: string) => call<HistoryOrder>(`/api/history/${encodeURIComponent(id)}`);
/** Сохранить заказ; без поля invoice сервер оставляет прежний счёт цеха */
export const putHistoryOrder = (o: Omit<HistoryOrder, 'invoice'> & { invoice?: HistoryInvoice | null }) => call<HistoryOrder>(`/api/history/${encodeURIComponent(o.id)}`, { method: 'PUT', body: JSON.stringify(o) });
export const deleteHistoryOrder = (id: string) => call<HistoryOrder>(`/api/history/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const putInvoice = (id: string, invoice: HistoryInvoice) =>
  call<HistoryOrder>(`/api/history/${encodeURIComponent(id)}/invoice`, { method: 'PUT', body: JSON.stringify(invoice) });
export const deleteInvoice = (id: string) => call<HistoryOrder>(`/api/history/${encodeURIComponent(id)}/invoice`, { method: 'DELETE' });
export const invoicedOrders = (signal?: AbortSignal) => call<{ orders: HistoryOrder[] }>('/api/history/invoiced', { signal }).then((r) => r.orders);
export const exportHistory = () => call<{ version: number; exportedAt: string; orders: HistoryOrder[] }>('/api/history/export');
export const importHistory = (orders: unknown[]) =>
  call<{ added: number; updated: number; skipped: number; errors: string[] }>('/api/history/import', { method: 'POST', body: JSON.stringify({ orders }) });

export function matchHistory(parts: MatchQuery[], exclude: string | undefined, signal?: AbortSignal): Promise<{ matches: Record<string, HistoryMatch[]>; orders: number }> {
  return call('/api/history/match', { method: 'POST', body: JSON.stringify({ parts, exclude }), signal });
}

export interface AuthStatus {
  enabled: boolean;
  expiresAt: string | null;
}

export async function authStatus(): Promise<AuthStatus> {
  try {
    return await call<AuthStatus>('/api/auth/status');
  } catch {
    return { enabled: false, expiresAt: null };
  }
}

/** Выйти: cookie снимается, страница перезагружается на форму входа */
export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
  location.reload();
}
