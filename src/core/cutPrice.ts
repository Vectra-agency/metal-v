// Прайс на лазерную резку из CSV (как «Прайс на резку металла - Лазерная резка.csv»):
// строка заголовка с «толщина» и колонками материалов, дальше строки «0,2-0,5 мм», «2 мм»…
// с ценой за погонный метр. Чистая функция — работает и в браузере, и в Node.

import type { CutGroup } from './materials.ts';
import type { CutRow } from './pricing.ts';

const PIERCE = /врез/i;
const COLUMN: [RegExp, CutGroup][] = [
  [/нерж/i, 'stainless'],
  [/алюм/i, 'aluminum'],
  [/мед|латун/i, 'copper'],
  [/черн|чёрн|стал/i, 'steel'], // последней: «сталь нерж.» уже разобрана выше
];

/** Разбивает строку CSV с учётом кавычек («"0,2-0,5 мм"» — одна ячейка) */
function cells(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

const num = (s: string): number | null => {
  const v = parseFloat(s.replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(v) && v > 0 ? v : null;
};

export interface CutPriceParse {
  rows: CutRow[];
  columns: CutGroup[]; // какие колонки нашлись
  pierce: boolean; // есть колонка «врезка»; нет — врезки берутся из прежней таблицы
}

/** Строки прайса, отсортированные по толщине; толщина строки — верхняя граница диапазона («0,6-1 мм» → 1) */
export function parseCutPriceCsv(text: string): CutPriceParse {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const hi = lines.findIndex((l) => /толщин/i.test(l));
  if (hi < 0) throw new Error('В файле нет строки заголовка с колонкой «толщина»');
  const head = lines[hi];
  const sep = (head.match(/;/g)?.length ?? 0) > (head.match(/,/g)?.length ?? 0) ? ';' : ',';
  const hc = cells(head, sep);
  const tCol = hc.findIndex((h) => /толщин/i.test(h));
  const cols = new Map<number, CutGroup>();
  const pCol = hc.findIndex((h, i) => i !== tCol && PIERCE.test(h));
  hc.forEach((h, i) => {
    if (i === tCol || i === pCol) return;
    const g = COLUMN.find(([re]) => re.test(h))?.[1];
    if (g && ![...cols.values()].includes(g)) cols.set(i, g);
  });
  if (!cols.size) throw new Error('Не найдены колонки материалов (сталь чёрная, нерж., алюминий, медь/латунь)');
  const rows: CutRow[] = [];
  for (const line of lines.slice(hi + 1)) {
    const c = cells(line, sep);
    const nums = (c[tCol] ?? '').match(/\d+(?:[.,]\d+)?/g);
    if (!nums) continue;
    const t = parseFloat(nums[nums.length - 1].replace(',', '.'));
    if (!(t > 0 && t <= 100)) continue;
    const row: CutRow = { t, steel: null, stainless: null, aluminum: null, copper: null, pierce: pCol >= 0 ? num(c[pCol] ?? '') : null };
    for (const [i, g] of cols) row[g] = num(c[i] ?? '');
    if (row.steel == null && row.stainless == null && row.aluminum == null && row.copper == null) continue;
    rows.push(row);
  }
  if (!rows.length) throw new Error('В файле нет строк с толщиной и ценой');
  rows.sort((a, b) => a.t - b.t);
  return { rows, columns: [...cols.values()], pierce: pCol >= 0 };
}

/** Таблица резки из сохранённых расценок или файла. Старый формат (ставка ₽/м + врезка, до прайса) → null: берётся прайс по умолчанию */
export function normalizeCutRows(v: unknown, fallback: readonly CutRow[] = []): CutRow[] | null {
  if (!Array.isArray(v) || !v.length || v.length > 100) return null;
  const cell = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : null);
  const rows: CutRow[] = [];
  for (const r of v) {
    if (!r || typeof r !== 'object' || !('steel' in r)) return null;
    const o = r as Record<string, unknown>;
    if (typeof o.t !== 'number' || !(o.t > 0)) return null;
    // таблицы до колонки «врезка» — врезка по ближайшей большей строке прайса по умолчанию
    const pierce = 'pierce' in o ? cell(o.pierce) : piercesFor(fallback, o.t);
    rows.push({ t: o.t, steel: cell(o.steel), stainless: cell(o.stainless), aluminum: cell(o.aluminum), copper: cell(o.copper), pierce });
  }
  return rows.sort((a, b) => a.t - b.t);
}

/** Врезка из таблицы для толщины: строка с толщиной не меньше t (как в расчёте) */
export function piercesFor(rows: readonly CutRow[], t: number): number | null {
  return rows
    .slice()
    .sort((a, b) => a.t - b.t)
    .find((r) => r.t >= t - 1e-9)?.pierce ?? null;
}
