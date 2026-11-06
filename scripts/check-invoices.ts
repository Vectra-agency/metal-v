// Сверка с реальными счетами (projects/1–4) так, как считает приложение: все файлы папки, кроме самих
// счетов, → разбор DXF/PDF/TXT → слияние → расчёт по ценам mc.ru (data/prices.json) и «Расценкам» по
// умолчанию. Без ручных подстановок материала, количества и гибов (в отличие от calibrate.ts) и без ИИ.
//   node scripts/check-invoices.ts [папка с распакованным projects/1/Обработанные.rar]
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readPdf, type PdfJsLike } from '../src/core/pdf.ts';
import { computeOrder, DEFAULT_SETTINGS, type OrderResult, type PriceBook } from '../src/core/pricing.ts';
import { emptyOrder, orderSettings, type Order, type OrderPosition } from '../src/order.ts';
import { desigKey, pdfFileKey, positionsFromPages } from '../src/pdfImport.ts';
import { importDefaults, parseFiles } from '../src/pipeline.ts';

const ROOT = new URL('../../projects/', import.meta.url).pathname;
const book: PriceBook = JSON.parse(readFileSync(new URL(existsSync(new URL('../data/prices.json', import.meta.url)) ? '../data/prices.json' : '../public/prices.json', import.meta.url), 'utf8'));
const settings = structuredClone(DEFAULT_SETTINGS);

async function load(dir: string, request = ''): Promise<{ order: Order; res: OrderResult; notes: string[] }> {
  // счёт — это ответ, клиент его не присылает
  const names = readdirSync(dir)
    .filter((f) => /\.(dxf|pdf|txt)$/i.test(f) && !/сч[её]т\s+на\s+оплату/i.test(f))
    .sort((a, b) => a.localeCompare(b, 'ru'));
  const files = names.map((n) => new File([readFileSync(join(dir, n))], n, { lastModified: Math.round(statSync(join(dir, n)).mtimeMs) }));
  const parsed = await parseFiles(files, { positions: [], request }, importDefaults([]), undefined, {
    importPdf: async (f, defs) => positionsFromPages(await readPdf(pdfjs as unknown as PdfJsLike, await f.arrayBuffer()), f.name, pdfFileKey(f), defs),
  });
  const order: Order = { ...emptyOrder(), positions: parsed.positions, documents: parsed.documents, requestLines: parsed.requestLines, request };
  return { order, res: computeOrder(order.positions, book, orderSettings(order, settings)), notes: [...parsed.notes, ...parsed.warnings] };
}

const rub = (v: number) => Math.round(v).toLocaleString('ru-RU').padStart(9);
const dev = (calc: number, fact: number) => `${calc >= fact ? '+' : ''}${(((calc - fact) / fact) * 100).toFixed(0)}%`.padStart(6);
const errors: { label: string; calc: number; fact: number }[] = [];
const find = (o: Order, desig: string): OrderPosition | undefined => o.positions.find((p) => desigKey(p.name) === desigKey(desig));

function linePiece(o: Order, res: OrderResult, desig: string, qty: number, fact: number, label = desig) {
  const p = find(o, desig);
  const r = p && res.positions.get(p.id);
  if (!p || !r) {
    console.log(`  ${label.padEnd(30)} НЕТ ПОЗИЦИИ В РАСЧЁТЕ${p?.disabled ? ' (исключена)' : ''}`);
    errors.push({ label, calc: 0, fact });
    return;
  }
  const qtyNote = p.qty === qty ? `${p.qty} шт` : `${p.qty} шт (а надо ${qty})`;
  const x = r.piece;
  console.log(
    `  ${label.slice(0, 30).padEnd(30)} ${r.material.short.padEnd(10)} ${String(p.thickness).padStart(3)} мм ${qtyNote.padEnd(18)} гибов ${String(p.bends).padStart(2)}  ` +
      `металл ${rub(x.material)} рез ${rub(x.cut + x.pierce)} гиб ${rub(x.bend)} = ${rub(x.total)} ₽/шт  счёт ${rub(fact)} ${dev(x.total, fact)}`,
  );
  errors.push({ label, calc: x.total, fact });
}

function extras(o: Order, known: string[]) {
  const set = new Set(known.map(desigKey));
  for (const p of o.positions) if (!p.disabled && !set.has(desigKey(p.name))) console.log(`  ! лишняя позиция в расчёте: ${p.name} (${p.qty} шт)`);
}

// ---- Проект 1: металл + резка по группам, без гибки (счёт № 9444 «Лазерная резка СПб»)
const dir1 = process.argv[2];
if (dir1 && existsSync(dir1)) {
  const { order, res } = await load(dir1);
  const inv: [string, string, number, boolean][] = [
    ['09g2s|10', '09Г2С 10 мм', 58630, true],
    ['09g2s|20', '09Г2С 20 мм', 47690, true],
    ['st3|1.5', 'Ст3 1,5 мм', 59350, true],
    ['st3|2', 'Ст3 2 мм', 190710, true],
    ['st3|3', 'Ст3 3 мм (рифлёный — металл клиента)', 398480, false],
    ['st3|6', 'Ст3 6 мм (95 шайб)', 5940, true],
    ['st3|10', 'Ст3 10 мм', 37220, true],
  ];
  const sums = new Map<string, { mat: number; cut: number }>();
  for (const g of res.groups) {
    const k = g.key === 'rifl|3' ? 'st3|3' : g.key;
    const m = sums.get(k) ?? { mat: 0, cut: 0 };
    for (const id of g.positionIds) {
      const p = res.positions.get(id)!;
      m.mat += p.sum.material;
      m.cut += p.sum.cut + p.sum.pierce;
    }
    sums.set(k, m);
  }
  console.log(`\nПРОЕКТ 1 — металл + резка по группам (счёт № 9444), позиций ${order.positions.length}`);
  let c = 0;
  let f = 0;
  for (const [k, label, fact, counted] of inv) {
    const m = sums.get(k) ?? { mat: 0, cut: 0 };
    console.log(`  ${label.padEnd(40)} металл ${rub(m.mat)} резка ${rub(m.cut)} = ${rub(m.mat + m.cut)}  счёт ${rub(fact)} ${dev(m.mat + m.cut, fact)}${counted ? '' : '  (не в средней)'}`);
    if (counted) errors.push({ label: `П1 ${label}`, calc: m.mat + m.cut, fact });
    c += m.mat + m.cut;
    f += fact;
  }
  console.log(`  ИТОГО${' '.repeat(36)}${rub(c)}  счёт ${rub(f)} ${dev(c, f)}`);
} else console.log('\nПРОЕКТ 1 пропущен: распакуйте projects/1/Обработанные.rar и передайте папку аргументом');

// ---- Проект 2: АМг2 рифлёный «квинтет» 3 мм с гибкой (счёт № 9885)
{
  const { order, res } = await load(join(ROOT, '2'));
  console.log(`\nПРОЕКТ 2 — счёт № 9885 (5 × 6 394 + 10 × 10 204 = 134 010 ₽)`);
  linePiece(order, res, 'НГЭН.745428.0003-0700', 5, 6394);
  linePiece(order, res, 'НГЭН.745428.0003-1700', 10, 10204);
  extras(order, ['НГЭН.745428.0003-0700', 'НГЭН.745428.0003-1700']);
  console.log(`  себестоимость заказа ${rub(res.totals.cost)} ₽, счёт ${rub(134010)} ${dev(res.totals.cost, 134010)}  (количества в файлах нет — 1 шт)`);
  // то же с заявкой клиента: количество есть только в ней (в счёте — 5 и 10 шт)
  const w = await load(join(ROOT, '2'), 'Прошу счёт:\nНГЭН.745428.0003-0700 — 5 шт\nНГЭН.745428.0003-1700 — 10 шт');
  console.log('  с заявкой «-0700 — 5 шт, -1700 — 10 шт»:');
  linePiece(w.order, w.res, 'НГЭН.745428.0003-0700', 5, 6394);
  linePiece(w.order, w.res, 'НГЭН.745428.0003-1700', 10, 10204);
  extras(w.order, ['НГЭН.745428.0003-0700', 'НГЭН.745428.0003-1700']);
  console.log(`  себестоимость заказа ${rub(w.res.totals.cost)} ₽, счёт ${rub(134010)} ${dev(w.res.totals.cost, 134010)}`);
}

// ---- Проект 3: МИЛП, детали с гибкой (счёт № 467), заявка — text.txt
{
  const { order, res } = await load(join(ROOT, '3'));
  console.log(`\nПРОЕКТ 3 — счёт МИЛП № 467 (1 × 2 171 + 3 × 1 368 = 6 275 ₽)`);
  linePiece(order, res, 'БВк-400х340.00.000', 1, 2171);
  linePiece(order, res, 'БВС-305Х300.000', 3, 1368);
  extras(order, ['БВк-400х340.00.000', 'БВС-305Х300.000']);
  console.log(`  себестоимость заказа ${rub(res.totals.cost)} ₽, счёт ${rub(6275)} ${dev(res.totals.cost, 6275)}`);
}

// ---- Проект 4: цены за штуку из projects/4/text.txt
{
  const { order, res } = await load(join(ROOT, '4'));
  const rows: [string, number][] = [
    ['НГЭН.745535.0021-01', 995],
    ['НГЭН.А86.11.11.1201', 2553],
    ['НГЭН.745421.0001', 2573],
    ['НГЭН.А86.11.13.0002', 7515],
    ['НГЭН.А86.11.13.0002-01', 9343],
    ['НГЭН.А86.11.13.0004', 8971],
  ];
  const total = rows.reduce((a, [, v]) => a + v * 5, 0);
  console.log(`\nПРОЕКТ 4 — цены за штуку (text.txt), по 5 шт, итого ${total.toLocaleString('ru-RU')} ₽`);
  for (const [d, v] of rows) linePiece(order, res, d, 5, v);
  extras(order, rows.map(([d]) => d));
  console.log(`  себестоимость заказа ${rub(res.totals.cost)} ₽, факт ${rub(total)} ${dev(res.totals.cost, total)}`);
}

const mae = errors.reduce((a, e) => a + Math.abs(e.calc - e.fact) / e.fact, 0) / errors.length;
console.log(`\nСредняя абсолютная ошибка по ${errors.length} сверкам (как считает приложение): ${(mae * 100).toFixed(1)}%`);
