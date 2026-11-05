import { MATERIAL_BY_ID } from './core/materials.ts';
import type { OrderResult } from './core/pricing.ts';
import { n1 } from './format.ts';
import type { OrderPosition } from './order.ts';
import { isUnpriced, UNPRICED_WORD } from './quote.ts';

// «Excel: внутренний расчёт» — CSV для Excel: разделитель «;», десятичная запятая, BOM для кириллицы, CRLF.
// Позиции — как в расчёте (с принятыми предложениями ИИ); цены — точные, без округления КП.
// Позиции без размеров в деньги не входят — строка с «цена уточняется», как в КП.

const f = (v: number, d = 2) => v.toFixed(d).replace('.', ',');
const q = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** Текст CSV внутреннего расчёта; clientTotal — «Цена клиенту» из КП (цены за шт округлены) */
export function internalCsv(title: string, positions: OrderPosition[], res: OrderResult, markupPct: number, clientTotal?: number): string {
  const rows: string[][] = [
    ['№', 'Обозначение', 'Файл', 'Материал', 'Толщина, мм', 'Кол-во', 'Габарит, мм', 'Масса шт, кг', 'Рез шт, м', 'Врезок', 'Гибов'].concat(
      ['Металл/шт', 'Резка/шт', 'Гибка/шт', 'Доп./шт', 'Себест./шт', 'Цена/шт', 'Сумма'],
    ),
  ];
  const head = rows[0].length;
  let i = 0;
  for (const p of positions) {
    if (isUnpriced(p)) {
      i++;
      const size = p.geom.width > 0 ? `${Math.round(p.geom.width)}×${Math.round(p.geom.height)}` : '';
      const label = MATERIAL_BY_ID.get(p.materialId)?.label ?? p.materialId;
      rows.push([String(i), q(p.name), q(p.fileName ?? ''), q(label), f(p.thickness, 1), String(p.qty), size, '', '', '', String(p.bends), '', '', '', '', '', q(UNPRICED_WORD), '']);
      continue;
    }
    const r = res.positions.get(p.id);
    if (!r) continue;
    i++;
    rows.push([
      String(i), q(p.name), q(p.fileName ?? ''), q(r.material.label), f(p.thickness, 1), String(p.qty),
      `${Math.round(p.geom.width)}×${Math.round(p.geom.height)}`, f(r.netKg), f(r.cutM), String(r.pierces), String(p.bends),
      f(r.piece.material), f(r.piece.cut + r.piece.pierce), f(r.piece.bend), f(r.piece.extras), f(r.piece.total), f(r.price.piece), f(r.price.sum),
    ]);
  }
  const T = res.totals;
  const line = (label: string, v: number) => rows.push(['', q(label), ...Array<string>(head - 3).fill(''), f(v)]);
  rows.push([]);
  if (title.trim()) rows.push(['', q(title.trim())]);
  line('Металл', T.material);
  line('Резка (по прайсу, ₽/м реза)', T.cutting);
  line('Гибка', T.bending);
  line('Доп. работы', T.extras);
  if (T.delivery) line('Доставка', T.delivery);
  line('Себестоимость', T.cost);
  if (T.markup) line(`Наценка ${n1(markupPct)}%`, T.markup);
  line('ИТОГО (с НДС)', T.total);
  line('в т.ч. НДС', T.vat);
  if (clientTotal != null && Math.abs(clientTotal - T.total) >= 0.005) line('Цена клиенту в КП (цена за шт округлена)', clientTotal);
  return '\uFEFF' + rows.map((r) => r.join(';')).join('\r\n');
}

/** Скачать текстовый файл (CSV) */
export function downloadText(name: string, text: string, type = 'text/csv;charset=utf-8'): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name.replace(/[\\/:*?"<>|]/g, '_');
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** «Excel: внутренний расчёт» → файл «{название || 'расчёт'}.csv» */
export function exportCsv(title: string, positions: OrderPosition[], res: OrderResult, markupPct: number, clientTotal?: number): void {
  downloadText(`${title.trim() || 'расчёт'}.csv`, internalCsv(title, positions, res, markupPct, clientTotal));
}
