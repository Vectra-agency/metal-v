import type { OrderResult } from './core/pricing.ts';
import type { Order } from './order.ts';

// CSV для Excel: разделитель «;», десятичная запятая, BOM для кириллицы
export function exportCsv(order: Order, res: OrderResult) {
  const f = (v: number, d = 2) => v.toFixed(d).replace('.', ',');
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const rows: string[][] = [
    ['№', 'Обозначение', 'Файл', 'Материал', 'Толщина, мм', 'Кол-во', 'Габарит, мм', 'Масса шт, кг', 'Рез шт, м', 'Врезок', 'Гибов', 'Металл/шт', 'Резка/шт', 'Гибка/шт', 'Доп./шт', 'Цена/шт', 'Сумма'],
  ];
  let i = 0;
  for (const p of order.positions) {
    const r = res.positions.get(p.id);
    if (!r) continue;
    i++;
    rows.push([
      String(i), q(p.name), q(p.fileName ?? ''), q(r.material.label), f(p.thickness, 1), String(p.qty),
      `${Math.round(p.geom.width)}×${Math.round(p.geom.height)}`, f(r.netKg), f(r.cutM), String(r.pierces), String(p.bends),
      f(r.piece.material), f(r.piece.cut + r.piece.pierce), f(r.piece.bend), f(r.piece.extras), f(r.piece.total), f(r.sum.total),
    ]);
  }
  const T = res.totals;
  rows.push([]);
  rows.push(['', 'Металл', '', '', '', '', '', '', '', '', '', '', '', '', '', '', f(T.material)]);
  rows.push(['', 'Резка (метры + врезки)', '', '', '', '', '', '', '', '', '', '', '', '', '', '', f(T.cutting)]);
  rows.push(['', 'Гибка', '', '', '', '', '', '', '', '', '', '', '', '', '', '', f(T.bending)]);
  rows.push(['', 'Доп. работы', '', '', '', '', '', '', '', '', '', '', '', '', '', '', f(T.extras)]);
  if (T.delivery) rows.push(['', 'Доставка', '', '', '', '', '', '', '', '', '', '', '', '', '', '', f(T.delivery)]);
  if (T.markup) rows.push(['', `Наценка ${order.markupPct}%`, '', '', '', '', '', '', '', '', '', '', '', '', '', '', f(T.markup)]);
  rows.push(['', 'ИТОГО (с НДС)', '', '', '', '', '', '', '', '', '', '', '', '', '', '', f(T.total)]);
  rows.push(['', 'в т.ч. НДС', '', '', '', '', '', '', '', '', '', '', '', '', '', '', f(T.vat)]);
  const csv = '﻿' + rows.map((r) => r.join(';')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `${(order.title || 'расчёт').replace(/[\\/:*?"<>|]/g, '_')}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
