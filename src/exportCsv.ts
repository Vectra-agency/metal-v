import type { OrderResult } from './core/pricing.ts';
import type { Order } from './order.ts';

// CSV для Excel: разделитель «;», десятичная запятая, BOM для кириллицы
export function exportCsv(order: Order, res: OrderResult) {
  const f = (v: number, d = 2) => v.toFixed(d).replace('.', ',');
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const rows: string[][] = [
    ['№', 'Обозначение', 'Файл', 'Материал', 'Толщина, мм', 'Кол-во', 'Габарит, мм', 'Масса шт, кг', 'Рез шт, м', 'Врезок', 'Гибов', 'Металл/шт', 'Резка/шт', 'Гибка/шт', 'Доп./шт', 'Себест./шт', 'Цена/шт', 'Сумма'],
  ];
  const head = rows[0].length;
  let i = 0;
  for (const p of order.positions) {
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
  const line = (label: string, v: number) => rows.push(['', label, ...Array<string>(head - 3).fill(''), f(v)]);
  rows.push([]);
  line('Металл', T.material);
  line('Резка (метры + врезки)', T.cutting);
  line('Гибка', T.bending);
  line('Доп. работы', T.extras);
  if (T.delivery) line('Доставка', T.delivery);
  if (T.markup) line(`Наценка ${order.markupPct}%`, T.markup);
  line('ИТОГО (с НДС)', T.total);
  line('в т.ч. НДС', T.vat);
  const csv = '﻿' + rows.map((r) => r.join(';')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `${(order.title || 'расчёт').replace(/[\\/:*?"<>|]/g, '_')}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
