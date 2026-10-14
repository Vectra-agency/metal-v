const nf0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Рубли: целые; мелкие суммы — с копейками */
export const rub = (v: number) => `${Math.abs(v) < 100 && v !== 0 ? nf2.format(v) : nf0.format(Math.round(v))} ₽`;
export const rub0 = (v: number) => `${nf0.format(Math.round(v))} ₽`;
export const n0 = (v: number) => nf0.format(Math.round(v));
export const n1 = (v: number) => nf1.format(v);
export const n2 = (v: number) => nf2.format(v);
export const kg = (v: number) => `${v < 10 ? nf2.format(v) : nf1.format(v)} кг`;
export const m = (mm: number) => `${nf2.format(mm / 1000)} м`;
export const pct = (v: number) => `${nf0.format(v * 100)}%`;
export const thick = (t: number) => `${nf1.format(t)} мм`;
export const date = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

export function plural(n: number, one: string, few: string, many: string) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}
