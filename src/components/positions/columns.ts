// Колонки таблицы позиций: что можно скрыть («Колонки»), ширины столбцов (table-fixed + colgroup).
import type { ColumnId } from '@/store/types.ts';

/** Пункты меню «Колонки» — в порядке показа */
export const COLUMN_LABEL: readonly { id: ColumnId; label: string }[] = [
  { id: 'thumb', label: 'Эскиз' },
  { id: 'geometry', label: 'Габарит, масса, рез' },
  { id: 'bends', label: 'Гибы' },
  { id: 'breakdown', label: 'Металл, резка, гибка, доп. на 1 шт' },
  { id: 'cost', label: 'Себестоимость за шт' },
  { id: 'share', label: 'Доля в заказе' },
];

/** Столбцы таблицы (физические) */
export type ColKey = 'select' | 'status' | 'name' | 'material' | 'qty' | 'bends' | 'geometry' | 'metal' | 'cut' | 'bend' | 'extras' | 'cost' | 'price' | 'sum' | 'menu';

/** Ширины, px: обычная раскладка и узкая (когда показана разбивка на 1 шт). «Деталь» — без ширины: забирает
 *  остаток строки, здесь — её минимум (таблица уже контейнера → прокрутка вбок внутри контейнера).
 *  «Цена/шт»: подпись «с наценкой 100 %» и значок сортировки помещаются целиком */
const WIDTH: Record<ColKey, [number, number]> = {
  select: [32, 32],
  status: [36, 36],
  name: [200, 200],
  material: [212, 212],
  qty: [88, 88],
  bends: [128, 128],
  geometry: [148, 132],
  metal: [72, 72],
  cut: [72, 72],
  bend: [72, 72],
  extras: [72, 72],
  cost: [96, 96],
  price: [128, 128],
  sum: [112, 108],
  menu: [36, 36],
};

/** Видимые столбцы по выбранным колонкам */
export function visibleCols(columns: Record<ColumnId, boolean>): ColKey[] {
  const out: ColKey[] = ['select', 'status', 'name', 'material', 'qty'];
  if (columns.bends) out.push('bends');
  if (columns.geometry) out.push('geometry');
  if (columns.breakdown) out.push('metal', 'cut', 'bend', 'extras');
  if (columns.cost) out.push('cost');
  out.push('price', 'sum', 'menu');
  return out;
}

export function colWidth(c: ColKey, columns: Record<ColumnId, boolean>): number {
  return WIDTH[c][columns.breakdown ? 1 : 0];
}

/** Левые отступы закреплённых столбцов: выбор, проверка, деталь */
export const STICKY_LEFT = { select: 0, status: 32, name: 68 } as const;
