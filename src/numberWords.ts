// Сумма прописью для КП: «Двести двенадцать тысяч семьсот сорок рублей 00 копеек».
// Тысячи — женского рода («одна тысяча», «две тысячи»), миллионы и миллиарды — мужского.
import { plural } from './format.ts';

const ONES_M = ['', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
const ONES_F = ['', 'одна', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
const TEENS = ['десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'];
const TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
const HUNDREDS = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];

// разряды по три цифры: [единица, 2–4, 5+], женский род
const SCALES: { forms: [string, string, string]; fem: boolean }[] = [
  { forms: ['', '', ''], fem: false }, // единицы — рубли (мужской род)
  { forms: ['тысяча', 'тысячи', 'тысяч'], fem: true },
  { forms: ['миллион', 'миллиона', 'миллионов'], fem: false },
  { forms: ['миллиард', 'миллиарда', 'миллиардов'], fem: false },
];

/** Тройка цифр словами: 212 → «двести двенадцать» */
function triad(n: number, fem: boolean): string[] {
  const out: string[] = [];
  const h = Math.floor(n / 100);
  const t = Math.floor((n % 100) / 10);
  const o = n % 10;
  if (h) out.push(HUNDREDS[h]);
  if (t === 1) out.push(TEENS[o]);
  else {
    if (t) out.push(TENS[t]);
    if (o) out.push((fem ? ONES_F : ONES_M)[o]);
  }
  return out;
}

/** Целое число словами (до 999 999 999 999); больше — цифрами */
export function integerInWords(n: number): string {
  n = Math.floor(Math.abs(n));
  if (n === 0) return 'ноль';
  if (n > 999_999_999_999) return String(n);
  const words: string[] = [];
  for (let i = SCALES.length - 1; i >= 0; i--) {
    const div = 1000 ** i;
    const part = Math.floor(n / div) % 1000;
    if (!part) continue;
    words.push(...triad(part, SCALES[i].fem));
    if (i > 0) words.push(plural(part, ...SCALES[i].forms));
  }
  return words.join(' ');
}

/** «Двести двенадцать тысяч семьсот сорок рублей 00 копеек»; 1001.5 → «Одна тысяча один рубль 50 копеек» */
export function amountInWords(rub: number): string {
  const totalKop = Math.round(Math.abs(Number.isFinite(rub) ? rub : 0) * 100);
  const r = Math.floor(totalKop / 100);
  const k = totalKop % 100;
  const words = `${integerInWords(r)} ${plural(r, 'рубль', 'рубля', 'рублей')} ${String(k).padStart(2, '0')} ${plural(k, 'копейка', 'копейки', 'копеек')}`;
  const s = rub < 0 && totalKop > 0 ? `минус ${words}` : words;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
