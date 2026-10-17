// Свежесть цен mc.ru по парам «материал + толщина» и обновление перед расчётом.
// Сервер ходит на mc.ru строго по одному запросу, поэтому обновляем только устаревшие пары
// и небольшими пачками (запрос через nginx не должен идти дольше 60 с). Ошибки не критичны:
// считаем по тому, что уже есть, и объясняем почему.

import { MATERIAL_BY_ID } from './core/materials.ts';
import type { PriceBook, PriceItem } from './core/pricing.ts';
import { fetchPrices, PriceApiError, refreshPricesApi } from './order.ts';

export type Pair = [materialId: string, thickness: number];

const HOUR = 3_600_000;
/** Пар за один POST /api/prices/refresh: ~2 с на пару, nginx рвёт запрос через 60 с */
export const REFRESH_BATCH = 12;

const sameT = (a: number, b: number) => Math.abs(a - b) < 1e-6;
export const pairKey = (materialId: string, t: number) => `${materialId}|${t}`;

function pairItems(book: PriceBook, materialId: string, t: number): PriceItem[] {
  return (book.materials[materialId] ?? []).filter((i) => sameT(i.t, t));
}

/** Когда цены пары взяты с mc.ru (самая свежая запись), ISO; null — неизвестно */
export function pairFetchedAt(book: PriceBook, materialId: string, t: number): string | null {
  let best = -Infinity;
  let iso: string | null = null;
  for (const i of pairItems(book, materialId, t)) {
    const ms = i.fetchedAt ? Date.parse(i.fetchedAt) : NaN;
    if (Number.isFinite(ms) && ms > best) {
      best = ms;
      iso = i.fetchedAt!;
    }
  }
  return iso;
}

/** Возраст цен пары в часах; нет цен или нет отметки времени — Infinity */
export function pairAge(book: PriceBook, materialId: string, t: number, now = Date.now()): number {
  const at = pairFetchedAt(book, materialId, t);
  return at ? Math.max(0, (now - Date.parse(at)) / HOUR) : Infinity;
}

/** Уникальные пары, цены которых старше maxAgeHours (или неизвестны) */
export function stalePairs(book: PriceBook, pairs: Pair[], maxAgeHours: number, now = Date.now()): Pair[] {
  const seen = new Set<string>();
  const out: Pair[] = [];
  for (const [m, t] of pairs) {
    const k = pairKey(m, t);
    if (seen.has(k) || !MATERIAL_BY_ID.has(m) || !(t > 0)) continue;
    seen.add(k);
    if (pairAge(book, m, t, now) > maxAgeHours) out.push([m, t]);
  }
  return out;
}

/** Пары материал+толщина позиций, участвующих в расчёте */
export function orderPairs(positions: { materialId: string; thickness: number; qty: number; disabled?: boolean }[]): Pair[] {
  const seen = new Set<string>();
  const out: Pair[] = [];
  for (const p of positions) {
    if (p.disabled || !(p.qty > 0)) continue;
    const k = pairKey(p.materialId, p.thickness);
    if (!seen.has(k)) {
      seen.add(k);
      out.push([p.materialId, p.thickness]);
    }
  }
  return out;
}

// пары, которые уже пробовали обновить в этой вкладке: толщины, которой нет на mc.ru,
// не запрашиваем при каждом расчёте заново
const tried = new Map<string, number>();

export interface EnsurePricesOptions {
  book: PriceBook;
  pairs: Pair[];
  maxAgeHours: number;
  live: boolean; // есть API сервера (иначе статическая версия со снимком цен)
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void; // пар обработано
  now?: number;
}

export interface EnsurePricesResult {
  book: PriceBook;
  refreshed: number; // пар с новыми ценами
  errors: string[]; // ошибки по отдельным парам (от сервера)
  skipped: boolean; // обновить не удалось — считаем по имеющимся ценам
  reason?: string; // почему пропущено, по-русски
  stale: Pair[]; // какие пары требовали обновления
}

const itemsSig = (items: PriceItem[]) => JSON.stringify(items.map((i) => [i.w, i.l, i.pricePerKg, i.fetchedAt ?? '']));

/** Обновляет устаревшие цены заказа; никогда не бросает исключений */
export async function ensurePrices(o: EnsurePricesOptions): Promise<EnsurePricesResult> {
  const now = o.now ?? Date.now();
  const staleAll = stalePairs(o.book, o.pairs, o.maxAgeHours, now);
  const stale = staleAll.filter(([m, t]) => {
    const at = tried.get(pairKey(m, t));
    return at == null || now - at > o.maxAgeHours * HOUR;
  });
  const res: EnsurePricesResult = { book: o.book, refreshed: 0, errors: [], skipped: false, stale: staleAll };
  if (!staleAll.length) return res;
  if (!stale.length) {
    // всё уже пробовали недавно: цен этих толщин на mc.ru нет
    return res;
  }
  if (!o.live) {
    return { ...res, skipped: true, reason: 'Статическая версия без сервера — цены взяты из сохранённого снимка' };
  }
  let book = o.book;
  let done = 0;
  for (let i = 0; i < stale.length; i += REFRESH_BATCH) {
    const batch = stale.slice(i, i + REFRESH_BATCH);
    try {
      const r = await refreshPricesApi(batch, o.signal);
      for (const [m, t] of batch) tried.set(pairKey(m, t), now);
      for (const [m, t] of batch) {
        const before = itemsSig(pairItems(book, m, t));
        const after = itemsSig(pairItems(r.book, m, t));
        if (before !== after || pairAge(r.book, m, t, Date.now()) <= o.maxAgeHours) res.refreshed++;
      }
      book = r.book;
      res.errors.push(...r.errors);
      done += batch.length;
      o.onProgress?.(done, stale.length);
      // mc.ru включил «я не робот» — дальше не идём, полученное сохранено на сервере
      if (r.errors.some((e) => /не робот|check-human/i.test(e))) {
        res.reason = 'mc.ru включил проверку «я не робот» — часть цен не обновлена, повторите через 10–15 минут';
        break;
      }
    } catch (e) {
      const err = e as Error;
      if (err.name === 'AbortError') {
        res.reason = 'Обновление цен остановлено';
      } else if (err instanceof PriceApiError && err.status === 409) {
        res.reason = 'Цены уже обновляются другим запросом — взяты текущие';
      } else if (err instanceof PriceApiError && (err.status === 0 || err.status === 404 || err.status === 405 || err.status === 501)) {
        res.reason = 'Сервер цен недоступен — взяты сохранённые цены';
      } else if (err instanceof PriceApiError && (err.status === 502 || err.status === 504)) {
        // nginx оборвал долгий запрос, сервер мог успеть сохранить — перечитываем справочник
        res.reason = 'mc.ru отвечает медленно — обновлена только часть цен';
        try {
          const fresh = await fetchPrices();
          if (fresh.live) book = fresh.book;
        } catch {
          /* остаёмся с тем, что есть */
        }
      } else {
        res.reason = `Не удалось обновить цены: ${err.message}`;
      }
      break;
    }
  }
  res.book = book;
  if (res.reason && !res.refreshed) res.skipped = true;
  else if (!res.reason && !res.refreshed && res.errors.length) {
    res.skipped = true;
    res.reason = res.errors[0];
  }
  return res;
}

/** Для тестов: забыть, какие пары уже пробовали обновить */
export function resetPriceAttempts() {
  tried.clear();
}
