// Числа, деньги и даты по-русски (ru-RU): разряды и единицы через неразрывный пробел — «1 234 ₽» не разрывается.

/** Неразрывный пробел */
export const NBSP = ' ';

const nf0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const hasKop = (v: number) => Math.abs(v - Math.round(v)) >= 0.005;

/** Без «минус ноля»: значение, которое при d знаках после запятой округляется до 0, — ровно 0 («−0,003» → «0», а не «-0») */
const nz = (v: number, d: number) => (Math.abs(v) < 0.5 / 10 ** d ? 0 : v);
const f0 = (v: number) => nf0.format(nz(Math.round(v), 0));
const f1 = (v: number) => nf1.format(nz(v, 1));
const f2 = (v: number) => nf2.format(nz(v, 2));

/** Рубли: целые; мелкие суммы (до 100 ₽) — с копейками, если они есть */
export const rub = (v: number) => `${Math.abs(v) < 100 && hasKop(v) ? f2(v) : f0(v)}${NBSP}₽`;
export const rub0 = (v: number) => `${f0(v)}${NBSP}₽`;
/** Рубли всегда с копейками: «1 234,50 ₽» */
export const rub2 = (v: number) => `${f2(v)}${NBSP}₽`;
/** Разница со знаком: «+1 240 ₽», «−1 240 ₽» (U+2212), «0 ₽»; меньше рубля — с копейками */
export function signedRub(v: number, kop = false): string {
  const a = Math.abs(v);
  if (a < 0.005) return `0${NBSP}₽`;
  const s = kop || a < 1 ? nf2.format(a) : nf0.format(Math.round(a));
  return `${v > 0 ? '+' : '−'}${s}${NBSP}₽`;
}
export const n0 = (v: number) => f0(v);
export const n1 = (v: number) => f1(v);
export const n2 = (v: number) => f2(v);
export const kg = (v: number) => `${v < 10 ? nf2.format(v) : nf1.format(v)}${NBSP}кг`;
export const m = (mm: number) => `${nf2.format(mm / 1000)}${NBSP}м`;
/** Доля 0..1 → «33%» (старый формат таблиц) */
export const pct = (v: number) => `${f0(v * 100)}%`;
/** Проценты (значение уже в процентах): 33.333 → «33,3 %», 50 → «50 %» */
export const pct1 = (percent: number) => `${f1(percent)}${NBSP}%`;
export const thick = (t: number) => `${nf1.format(t)}${NBSP}мм`;
export const date = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

type When = string | number | Date | null | undefined;
const toDate = (w: When): Date | null => {
  if (w == null || w === '') return null;
  const d = w instanceof Date ? w : new Date(w);
  return Number.isFinite(d.getTime()) ? d : null;
};
const p2 = (n: number) => String(n).padStart(2, '0');

/** «16.10.2026» */
export function dateDay(w: When): string {
  const d = toDate(w);
  return d ? `${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${d.getFullYear()}` : '—';
}
/** «16.10 14:05» */
export function dateShort(w: When): string {
  const d = toDate(w);
  return d ? `${p2(d.getDate())}.${p2(d.getMonth() + 1)} ${p2(d.getHours())}:${p2(d.getMinutes())}` : '—';
}
/** «14:35» */
export function hhmm(w: When): string {
  const d = toDate(w);
  return d ? `${p2(d.getHours())}:${p2(d.getMinutes())}` : '—';
}
/** Сколько прошло: «только что», «5 мин назад», «2 ч назад», «3 дн. назад» */
export function ago(w: When, now: number = Date.now()): string {
  const d = toDate(w);
  if (!d) return '—';
  const min = Math.max(0, (now - d.getTime()) / 60_000);
  if (min < 1) return 'только что';
  if (min < 60) return `${Math.floor(min)}${NBSP}мин назад`;
  const h = min / 60;
  if (h < 24) return `${Math.floor(h)}${NBSP}ч назад`;
  return `${Math.floor(h / 24)}${NBSP}дн. назад`;
}
/** Прошедшее время по секундомеру: «0:23», «12:05», «1:02:03» */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  return h ? `${h}:${p2(mm)}:${p2(s % 60)}` : `${mm}:${p2(s % 60)}`;
}

export function plural(n: number, one: string, few: string, many: string) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}
