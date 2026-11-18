// Счёт цеха на оплату (форма 1С: «Счет на оплату № 9444 от 22 сентября 2026 г.», таблица
// № | Товары (работы, услуги) | Кол-во Ед. | Цена | Сумма) → строки, и к каким деталям заказа они относятся.
// Вход — строки текста PDF (documentLines: ячейки через « | »). Общий модуль, без браузера.

import { HISTORY_LIMITS, designationKey } from './history.ts';
import { MATERIAL_BY_ID } from './materials.ts';
import { normText } from './pdfAnalyze.ts';

export interface InvoiceItem {
  n: number;
  text: string;
  qty: number;
  unit: string;
  price: number;
  sum: number;
}

export interface ParsedInvoice {
  supplier: string;
  number: string;
  date: string | null; // YYYY-MM-DD
  total: number; // всего к оплате
  vat: number | null;
  items: InvoiceItem[];
}

/** Деталь, к которой можно отнести строку счёта */
export interface InvoicePart {
  id: string;
  name: string;
  materialId: string;
  thickness: number;
  qty: number;
  disabled?: boolean;
}

const MONTHS: Record<string, number> = {
  января: 1,
  февраля: 2,
  марта: 3,
  апреля: 4,
  мая: 5,
  июня: 6,
  июля: 7,
  августа: 8,
  сентября: 9,
  октября: 10,
  ноября: 11,
  декабря: 12,
};

/** «58 630,00» → 58630 */
export function money(s: string): number {
  const v = Number(s.replace(/[\s  ]/g, '').replace(',', '.'));
  return Number.isFinite(v) ? v : NaN;
}

const MONEY = String.raw`\d{1,3}(?:[\s  ]\d{3})*[.,]\d{2}|\d+[.,]\d{2}`;
const UNIT = String.raw`шт|штук|компл|комп|к-т|кмп|кг|тн|т|м²|м2|кв\.?\s?м|пог\.?\s?м|п\.?\s?м|м|ед|усл\.?\s?ед|услуга|усл|упак|лист|рейс|час|ч`;
// «1 Набор пластин … | 1 компл | 58 630,00 | 58 630,00»: номер, наименование, количество и единица, цена, сумма
const ITEM = new RegExp(
  String.raw`^(\d{1,3})[\s|.]+(.+?)[\s|]+(\d+(?:[.,]\d+)?)\s*(${UNIT})\.?[\s|]+(${MONEY})[\s|]+(${MONEY})\s*$`,
  'i',
);
const HEAD = /товары\s*\(работы,?\s*услуги\)|наименование\s+(товара|работ|услуг)|^\s*№\s*\|?\s*наименование/i;
const FOOT = /^(итого|всего к оплате|в том числе ндс|без налога|всего наименований)/i;
const TITLE = /сч[её]т\s+(?:на\s+оплату\s+)?№\s*([^\s|]+)\s+от\s+(\d{1,2})[\s.]+([а-яё]+|\d{1,2})[\s.]+(\d{4})/i;

/** Похоже на счёт на оплату (по тексту листов PDF) */
export function looksLikeInvoice(text: string): boolean {
  return /сч[её]т\s+на\s+оплату/i.test(text) && /(всего к оплате|итого)/i.test(text);
}

function isoDate(d: string, m: string, y: string): string | null {
  const month = /^\d+$/.test(m) ? Number(m) : MONTHS[m.toLowerCase()];
  const day = Number(d);
  if (!month || month > 12 || !day || day > 31) return null;
  return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const clean = (s: string) =>
  s
    .replace(/\s*\|\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Строки счёта из текста PDF; null — это не счёт (нет ни одной строки с ценой и суммой) */
export function parseInvoiceLines(lines: string[]): ParsedInvoice | null {
  let supplier = '';
  let number = '';
  let date: string | null = null;
  let total = NaN;
  let vat: number | null = null;
  const items: InvoiceItem[] = [];
  let inTable = false;
  let ended = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || /^\[стр\.\s*\d+\]$/.test(line)) continue;
    const flat = clean(line);
    const t = TITLE.exec(flat);
    if (t && !number) {
      number = t[1];
      date = isoDate(t[2], t[3], t[4]);
      continue;
    }
    const sup = /^поставщик(?![а-яё])[\s|]*(?:\(исполнитель\):?)?[\s|]*(.+)$/i.exec(line);
    if (sup && !supplier) {
      supplier = clean(sup[1]).split(/,\s*(?:ИНН|КПП)(?![а-яё])/i)[0].trim();
      continue;
    }
    if (FOOT.test(flat)) {
      if (items.length) ended = true;
      const m = new RegExp(`(${MONEY})\\s*(?:руб\\.?)?\\s*$`).exec(flat);
      if (m && /^всего к оплате/i.test(flat)) total = money(m[1]);
      else if (m && /^итого/i.test(flat) && !Number.isFinite(total)) total = money(m[1]);
      else if (m && /ндс/i.test(flat)) vat = money(m[1]);
      continue;
    }
    if (HEAD.test(flat)) {
      inTable = true;
      continue;
    }
    if (ended || items.length >= HISTORY_LIMITS.invoiceLines) continue;
    const it = ITEM.exec(flat);
    if (it) {
      const qty = Number(it[3].replace(',', '.'));
      const price = money(it[5]);
      const sum = money(it[6]);
      if (!Number.isFinite(price) || !Number.isFinite(sum)) continue;
      items.push({ n: Number(it[1]), text: it[2].trim(), qty, unit: it[4].toLowerCase().replace(/\s+/g, ''), price, sum });
      inTable = true;
      continue;
    }
    // продолжение наименования на следующей строке: «толщиной 3мм, с гибкой»
    if (inTable && items.length && !/^\d{1,3}\s/.test(flat) && flat.length <= 200) {
      const last = items[items.length - 1];
      last.text = `${last.text} ${flat}`.slice(0, 1000);
    }
  }
  if (!items.length) return null;
  if (!Number.isFinite(total)) total = items.reduce((a, i) => a + i.sum, 0);
  return { supplier, number, date, total, vat, items };
}

// ---------- к каким деталям относится строка ----------

// порядок как в parseFileName: сначала более специфичные
const MATERIAL_ORDER = ['amg2r', 'rifl', 'aisi321', 'aisi304', 'aisi430', 'ocink', 'amg2', 'amg5', '09g2s', '08ps', 'st3'];
/** Строка счёта называет марку, а деталь посчитана видом проката этой марки: «Ст3» — и рифлёный, и х/к */
const FAMILY: Record<string, string> = { rifl: 'st3', '08ps': 'st3', amg2r: 'amg2' };
// покупка листа или проката, а не детали по чертежу
const RAW_STOCK = /^(лист|круг|труба|уголок|швеллер|полоса|арматура|профиль|балка|квадрат)(?![а-яё])(?!.*(?:по\s+чертеж|детал))/i;
const DESIG_ALL = /[A-Za-zА-Яа-яЁё]{1,10}[.\-]?[\dA-Za-zА-Яа-я]*\d[\dA-Za-zА-Яа-я]*(?:[.\-][\dA-Za-zА-Яа-я]+)+/g;

/** Материал строки счёта: «из 09г2с», «из Ст3», «АМг2 рифл квинтет» */
export function lineMaterial(text: string): string | null {
  for (const id of MATERIAL_ORDER) if (MATERIAL_BY_ID.get(id)!.aliases.test(` ${text} `)) return id;
  return null;
}

/** Толщина строки счёта: «толщиной 1,5мм», «s3mm», «3 мм» */
export function lineThickness(text: string): number | null {
  const m =
    /толщ[а-яё]*\s*(\d+(?:[.,]\d+)?)\s*мм/i.exec(text) ??
    /(?:^|[\s_\-.])s\s?(\d+(?:[.,]\d+)?)\s?(?:mm|мм)(?=$|[\s_\-.,])/i.exec(text) ??
    /(?:^|[\s(])(\d+(?:[.,]\d+)?)\s?мм(?![а-яё])/i.exec(text);
  const v = m ? Number(m[1].replace(',', '.')) : NaN;
  return v > 0 && v < 200 ? v : null;
}

const sameFamily = (lineMat: string, partMat: string) => lineMat === partMat || FAMILY[partMat] === lineMat;

/** Обозначения в тексте строки (ключи для сравнения) */
function lineKeys(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of normText(text).matchAll(DESIG_ALL)) {
    const k = designationKey(m[0]);
    if (k) out.add(k);
  }
  return out;
}

/**
 * К каким деталям относится каждая строка счёта: сначала по обозначению детали в строке,
 * затем строки «Набор пластин из Ст3 толщиной 2 мм» — к деталям того же материала и толщины,
 * не отнесённым по обозначению. Покупка листа («Лист г/к 1,5, х100х2500, Ст3») — ни к чему.
 */
export function autoMatch(items: readonly Pick<InvoiceItem, 'text'>[], parts: readonly InvoicePart[]): string[][] {
  const active = parts.filter((p) => !p.disabled);
  const keyed = active.map((p) => ({ p, k: designationKey(p.name) }));
  const used = new Set<string>();
  const out: string[][] = items.map((it) => {
    const keys = lineKeys(it.text);
    const hits = keyed.filter((x) => x.k && keys.has(x.k)).map((x) => x.p.id);
    hits.forEach((id) => used.add(id));
    return hits;
  });
  items.forEach((it, i) => {
    if (out[i].length || RAW_STOCK.test(it.text.trim())) return;
    const mat = lineMaterial(it.text);
    const t = lineThickness(it.text);
    if (!mat || t == null) return;
    out[i] = active.filter((p) => !used.has(p.id) && sameFamily(mat, p.materialId) && Math.abs(p.thickness - t) < 1e-6).map((p) => p.id);
  });
  return out;
}
