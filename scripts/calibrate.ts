// Сверка модели с реальными счетами из папки projects/.
// Запуск: npm run calibrate -- <папка с распакованным Обработанные.rar>
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseDxf } from '../src/core/dxf.ts';
import { analyze, metricsOf } from '../src/core/geometry.ts';
import { parseFileName } from '../src/core/materials.ts';
import { computeOrder, DEFAULT_SETTINGS, type Position, type PriceBook, type Settings } from '../src/core/pricing.ts';

const ROOT = new URL('../../projects/', import.meta.url).pathname;
const book: PriceBook = JSON.parse(readFileSync(new URL('../public/prices.json', import.meta.url), 'utf8'));
const settings: Settings = structuredClone(DEFAULT_SETTINGS);

function load(path: string, over: Partial<Position> = {}): Position {
  const buf = readFileSync(path);
  const an = analyze(parseDxf(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)));
  const m = metricsOf(an.parts, an.bends);
  const pn = parseFileName(path.split('/').pop()!);
  return {
    id: path,
    name: pn.name,
    materialId: pn.materialId ?? 'st3',
    thickness: pn.thickness ?? 2,
    qty: pn.qty ?? 1,
    geom: { width: m.width, height: m.height, netArea: m.netArea, bboxArea: m.bboxArea, cutLength: m.cutLength, pierces: m.pierces, count: m.count },
    bends: 0,
    bendLength: Math.max(m.width, m.height),
    extras: [],
    ...over,
  };
}

const rub = (v: number) => Math.round(v).toLocaleString('ru-RU').padStart(10);
const pct = (calc: number, fact: number) => `${calc >= fact ? '+' : ''}${(((calc - fact) / fact) * 100).toFixed(0)}%`.padStart(6);
let report: [string, number, number][] = [];

// ---- Проект 1: набор пластин, счёт «Лазерная резка СПб» (металл + резка, без гибки)
const dir1 = process.argv[2];
if (dir1 && existsSync(dir1)) {
  const pos = readdirSync(dir1).filter((f) => f.endsWith('.dxf')).map((f) => load(join(dir1, f)));
  const r = computeOrder(pos, book, settings);
  const inv: Record<string, [string, number]> = {
    '09g2s|10': ['09Г2С 10 мм', 58630], '09g2s|20': ['09Г2С 20 мм', 47690], 'st3|1.5': ['Ст3 1,5 мм', 59350],
    'st3|2': ['Ст3 2 мм', 190710], 'st3|3': ['Ст3 3 мм (вкл. рифлёный)', 398480], 'st3|6': ['Ст3 6 мм', 5940], 'st3|10': ['Ст3 10 мм', 37220],
  };
  console.log('\nПРОЕКТ 1 — металл + резка по группам (счёт № 9444)');
  console.log('группа'.padEnd(28), 'металл'.padStart(10), 'резка'.padStart(10), 'расчёт'.padStart(10), 'счёт'.padStart(10), 'откл.');
  const merged: Record<string, { mat: number; cut: number }> = {};
  for (const g of r.groups) {
    const k = g.key === 'rifl|3' ? 'st3|3' : g.key;
    const m = (merged[k] ??= { mat: 0, cut: 0 });
    for (const id of g.positionIds) {
      const p = r.positions.get(id)!;
      m.mat += p.sum.material;
      m.cut += p.sum.cut + p.sum.pierce;
    }
    console.log(`   ${g.key.padEnd(12)} лист ${g.chosen.offer.w}×${g.chosen.offer.l}, листов ${g.chosen.sheetsCharged.toFixed(2)}, раскрой ${(g.chosen.nest.utilization * 100).toFixed(0)}%, ${g.chosen.offer.pricePerKg.toFixed(1)} ₽/кг`);
  }
  let sc = 0, sf = 0;
  for (const [k, [label, fact]] of Object.entries(inv)) {
    const m = merged[k];
    if (!m) continue;
    const calc = m.mat + m.cut;
    sc += calc; sf += fact;
    console.log(label.padEnd(28), rub(m.mat), rub(m.cut), rub(calc), rub(fact), pct(calc, fact));
    report.push([`П1 ${label}`, calc, fact]);
  }
  console.log('ИТОГО (без нерж.)'.padEnd(28), ''.padStart(10), ''.padStart(10), rub(sc), rub(sf), pct(sc, sf));
  report.push(['П1 итого металл+резка', sc, sf]);
}

// ---- Проект 2: АМг2 рифлёный 3 мм с гибкой, счёт № 9885
{
  const d = join(ROOT, '2');
  const pos = [
    load(join(d, 'НГЭН.745428.0003-0700 amg2 s3mm.dxf'), { materialId: 'amg2r', qty: 5, bends: 4, bendLength: 700 }),
    load(join(d, 'НГЭН.745428.0003-1700 amg2 s3mm.dxf'), { materialId: 'amg2r', qty: 10, bends: 4, bendLength: 1700 }),
  ];
  const r = computeOrder(pos, book, settings);
  console.log('\nПРОЕКТ 2 — АМг2 рифл. 3 мм, 4 гиба (счёт № 9885)');
  const fact = [6394, 10204];
  pos.forEach((p, i) => {
    const x = r.positions.get(p.id)!;
    console.log(`${p.name.padEnd(28)} шт: металл ${rub(x.piece.material)} рез ${rub(x.piece.cut + x.piece.pierce)} гиб ${rub(x.piece.bend)} = ${rub(x.piece.total)}  счёт ${rub(fact[i])} ${pct(x.piece.total, fact[i])}`);
  });
  const g = r.groups[0];
  console.log(`   лист ${g.chosen.offer.w}×${g.chosen.offer.l} (${g.chosen.offer.source}), листов ${g.chosen.sheetsCharged.toFixed(2)}, ${g.chosen.offer.pricePerKg.toFixed(0)} ₽/кг`);
  console.log('ИТОГО'.padEnd(28), rub(r.totals.cost), 'счёт', rub(134010), pct(r.totals.cost, 134010));
  report.push(['П2 итого', r.totals.cost, 134010]);
}

// ---- Проект 3: МИЛП, Ст3 2 мм, коробы с гибкой
{
  const d = join(ROOT, '3');
  const pos = [
    load(join(d, 'БВС-305Х300.000 - Блок выхода сброса.dxf'), { materialId: 'st3', thickness: 2, qty: 3, bends: 4, bendLength: 305 }),
    load(join(d, 'БВк-400х340.00.000 - Блок ввода кабеля (контур).dxf'), { materialId: 'st3', thickness: 2, qty: 1, bends: 4, bendLength: 400 }),
  ];
  const r = computeOrder(pos, book, settings);
  console.log('\nПРОЕКТ 3 — Ст3 2 мм, 4 гиба (счёт МИЛП № 467)');
  const fact = [1368, 2171];
  pos.forEach((p, i) => {
    const x = r.positions.get(p.id)!;
    console.log(`${p.name.slice(0, 28).padEnd(28)} шт: металл ${rub(x.piece.material)} рез ${rub(x.piece.cut + x.piece.pierce)} гиб ${rub(x.piece.bend)} = ${rub(x.piece.total)}  счёт ${rub(fact[i])} ${pct(x.piece.total, fact[i])}`);
    report.push([`П3 ${p.name.slice(0, 18)}`, x.piece.total, fact[i]]);
  });
}

// ---- Проект 4: цены за штуку (08пс, рифлёный)
{
  const d = join(ROOT, '4');
  const rows: [string, Partial<Position>, number][] = [
    ['НГЭН.745535.0021-01.dxf', { materialId: '08ps', thickness: 1.5, qty: 5, bends: 8, bendLength: 500 }, 995],
    ['НГЭН.А86.11.11.1201.dxf', { materialId: '08ps', thickness: 2, qty: 5, bends: 4, bendLength: 1580 }, 2553],
    ['НГЭН.745421.0001 st3 s2mm 5sht.dxf', { materialId: '08ps', thickness: 2, qty: 5, bends: 7, bendLength: 2896 }, 2573],
    ['НГЭН.А86.11.13.0002 st3 s3mm rifleniy 5sht.dxf', {}, 7515],
    ['НГЭН.А86.11.13.0002-01 st3 s3mm rifleniy 5sht.dxf', {}, 9343],
    ['НГЭН.А86.11.13.0004 st3 s3mm rifleniy 5sht.dxf', {}, 8971],
  ];
  const pos = rows.map(([f, o]) => load(join(d, f), o));
  const r = computeOrder(pos, book, settings);
  console.log('\nПРОЕКТ 4 — цена за штуку');
  let sc = 0, sf = 0;
  pos.forEach((p, i) => {
    const x = r.positions.get(p.id)!;
    sc += x.piece.total * p.qty; sf += rows[i][2] * p.qty;
    console.log(`${p.name.padEnd(28)} ${x.material.short.padEnd(9)} металл ${rub(x.piece.material)} рез ${rub(x.piece.cut + x.piece.pierce)} гиб ${rub(x.piece.bend)} = ${rub(x.piece.total)}  факт ${rub(rows[i][2])} ${pct(x.piece.total, rows[i][2])}${x.split ? `  [из ${x.split.pieces} частей]` : ''}`);
    report.push([`П4 ${p.name}`, x.piece.total, rows[i][2]]);
  });
  for (const g of r.groups) console.log(`   ${g.key.padEnd(10)} лист ${g.chosen.offer.w}×${g.chosen.offer.l}, листов ${g.chosen.sheetsCharged.toFixed(2)}, раскрой ${(g.chosen.nest.utilization * 100).toFixed(0)}%, ${g.chosen.offer.pricePerKg.toFixed(1)} ₽/кг (${g.chosen.offer.source})`);
  console.log('ИТОГО'.padEnd(28), rub(sc), 'факт', rub(sf), pct(sc, sf));
}

const errs = report.map(([, c, f]) => Math.abs(c - f) / f);
console.log(`\nСредняя абсолютная ошибка по ${errs.length} сверкам: ${((errs.reduce((a, b) => a + b, 0) / errs.length) * 100).toFixed(1)}%`);
if (process.env.JSON_OUT) (await import('node:fs')).writeFileSync(process.env.JSON_OUT, JSON.stringify(report));
