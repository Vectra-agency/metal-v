// Парсер цен листового проката с mc.ru (Металлсервис).
// Страница раздела показывает не все толщины, поэтому берём
// постраничные выборки /r1/<толщина> в нужном регионе.

import { MATERIALS, type Material } from '../src/core/materials.ts';
import type { PriceBook, PriceItem } from '../src/core/pricing.ts';
import { mcUrl } from '../src/mcUrl.ts';

export { mcUrl };

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';

export const REGIONS: Record<string, string> = {
  speterburg: 'Санкт-Петербург',
  msk: 'Москва',
};

interface McRow {
  name: string;
  mark: string;
  base: string;
  price: number | null;
}

function clean(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseMcHtml(html: string): { rows: McRow[]; unit: 't' | 'kg' } {
  const unit = /mf_pr">\s*Цена за кг/i.test(html) ? 'kg' : 't';
  const rows: McRow[] = [];
  // значения атрибутов могут содержать «<br>», поэтому конец тега ищем вне кавычек
  const re = /<tr\s+idt='[^']*'((?:[^>'"]|'[^']*'|"[^"]*")*)>([\s\S]*?)<\/tr>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    const body = m[2];
    const name = clean(/data-nm='([^']*)'/.exec(attrs)?.[1] ?? '');
    const base = clean(/data-base='([^']*)'/.exec(attrs)?.[1] ?? '');
    const mark = clean(/data-mark='([^']*)'/.exec(attrs)?.[1] ?? '');
    const pm = /<div class="pr"\s*>\s*([\d\s ]+)/.exec(body);
    const price = pm ? parseInt(pm[1].replace(/[\s ]/g, ''), 10) : null;
    // полное наименование в строке таблицы точнее, чем data-nm
    const full = clean(/class="refstr _nm">([\s\S]*?)<\/div>/.exec(body)?.[1] ?? name);
    rows.push({ name: full || name, mark, base, price: price && price > 0 ? price : null });
  }
  return { rows, unit };
}


export class HumanCheckError extends Error {
  constructor() {
    super('mc.ru включил проверку «я не робот» из-за частых запросов — повторите через 10–15 минут');
  }
}

async function getHtml(url: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: ctrl.signal, redirect: 'manual' });
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location') ?? '';
      if (/check-human/i.test(loc)) throw new HumanCheckError();
      throw new Error(`переадресация на ${loc}`);
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const html = await r.text();
    if (/check-human/i.test(html) && !/<tr\s+idt=/.test(html)) throw new HumanCheckError();
    return html;
  } finally {
    clearTimeout(timer);
  }
}

export function rowsToItems(mat: Material, t: number, rows: McRow[], unit: 't' | 'kg', region: string): PriceItem[] {
  const city = REGIONS[region] ?? region;
  const markRe = mat.mc.mark ? new RegExp(mat.mc.mark, 'i') : null;
  const nameRe = mat.mc.name ? new RegExp(mat.mc.name, 'i') : null;
  const exRe = mat.mc.exclude ? new RegExp(mat.mc.exclude, 'i') : null;
  const out: PriceItem[] = [];
  for (const r of rows) {
    if (r.price == null) continue;
    if (!r.base.startsWith(city)) continue;
    if (markRe && !markRe.test(r.mark)) continue;
    if (nameRe && !nameRe.test(r.name)) continue;
    if (exRe && (exRe.test(r.name) || exRe.test(r.mark))) continue;
    const d = /(\d+(?:[.,]\d+)?)\s*[хx×]\s*(\d+)\s*[хx×]\s*(\d+)/i.exec(r.name);
    if (!d) continue; // рулон/«длина под заказ» — пропускаем
    const rt = parseFloat(d[1].replace(',', '.'));
    if (Math.abs(rt - t) > 1e-6) continue;
    const w = parseInt(d[2], 10);
    const l = parseInt(d[3], 10);
    if (Math.min(w, l) < 500 || Math.max(w, l) < 1000) continue; // мерные куски не берём
    out.push({ t: rt, w: Math.min(w, l), l: Math.max(w, l), pricePerKg: unit === 't' ? r.price / 1000 : r.price, name: r.name, mark: r.mark });
  }
  // нержавейку с покрытием/полировкой не берём, если есть обычная
  if (/nerzh/.test(mat.mc.category)) {
    const plain = out.filter((i) => !/BA|4N|зерк|шлиф|PE\b|\+PE|PI\b/i.test(i.name));
    if (plain.length) return plain;
  }
  return out;
}

export async function fetchMaterialThickness(mat: Material, t: number, region = 'speterburg'): Promise<PriceItem[]> {
  const html = await getHtml(mcUrl(mat.mc.category, t, region));
  const { rows, unit } = parseMcHtml(html);
  return rowsToItems(mat, t, rows, unit, region);
}

export interface RefreshProgress {
  done: number;
  total: number;
  errors: string[];
}

/** Обновляет цены по списку пар [материал, толщина]; без списка — весь справочник */
export async function refreshPrices(
  base: PriceBook,
  pairs: [string, number][] | null,
  region = 'speterburg',
  onProgress?: (p: RefreshProgress) => void,
): Promise<{ book: PriceBook; errors: string[] }> {
  const jobs: [Material, number][] = [];
  if (pairs?.length) {
    for (const [id, t] of pairs) {
      const m = MATERIALS.find((x) => x.id === id);
      if (m) jobs.push([m, t]);
    }
  } else {
    for (const m of MATERIALS) for (const t of m.thicknesses) jobs.push([m, t]);
  }
  const materials: Record<string, PriceItem[]> = { ...base.materials };
  const errors: string[] = [];
  let updated = 0;
  // строго по одному запросу с паузой: mc.ru включает антибот-проверку при частых запросах
  for (let k = 0; k < jobs.length; k++) {
    const [m, t] = jobs[k];
    try {
      const items = await fetchMaterialThickness(m, t, region);
      // заменяем записи этой толщины; пустой ответ (нет в наличии) старые цены не стирает
      if (items.length) {
        materials[m.id] = [...(materials[m.id] ?? []).filter((i) => Math.abs(i.t - t) > 1e-6), ...items].sort((a, b) => a.t - b.t || a.w * a.l - b.w * b.l);
        updated++;
      }
    } catch (e) {
      errors.push(`${m.short} ${t} мм: ${(e as Error).message}`);
      if (e instanceof HumanCheckError) {
        errors.push(`Остановлено на ${k + 1} из ${jobs.length}; уже полученные цены сохранены`);
        onProgress?.({ done: k + 1, total: jobs.length, errors });
        break;
      }
    }
    onProgress?.({ done: k + 1, total: jobs.length, errors });
    if (k < jobs.length - 1) await new Promise((r) => setTimeout(r, 1200));
  }
  return {
    book: { updatedAt: updated ? new Date().toISOString() : base.updatedAt, region: REGIONS[region] ?? region, materials },
    errors,
  };
}
