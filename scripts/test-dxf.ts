// Тесты проверки DXF и гибов: node scripts/test-dxf.ts
// Единицы и плоскость в парсере, ошибки DXF (зазор, петля, наложение, 3D, лист, картинка, масштаб) и замечания
// (дубли, мусор, хвосты, надписи, заливки), позиция с ошибкой не считается до «Считать как есть», замечания
// «Требует внимания», отверстия и перемычки против толщины, причины гибов (ось, один гиб из отрезков),
// откуда гибы (DXF / PDF / исполнение), разбор гибов ИИ в ответе модели. Реальные DXF из projects/ — без ложных ошибок.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildAttention } from '../src/attention.ts';
import { bendSource } from '../src/bends.ts';
import { AI_RESPONSE_SCHEMA, type AiContext } from '../src/core/ai.ts';
import { sanitizeAnalysis } from '../src/core/aiSanitize.ts';
import { parseDxf } from '../src/core/dxf.ts';
import { checkDxf } from '../src/core/dxfCheck.ts';
import { analyze, metricsOf } from '../src/core/geometry.ts';
import { computeOrder, DEFAULT_SETTINGS, type PriceBook } from '../src/core/pricing.ts';
import { dxfBlocked, emptyOrder, orderSettings, positionFromDxf, type Order, type OrderPosition } from '../src/order.ts';
import { isUnpriced, pricedPositions } from '../src/quote.ts';

const book: PriceBook = JSON.parse(readFileSync(new URL('../public/prices.json', import.meta.url), 'utf8'));
const settings = structuredClone(DEFAULT_SETTINGS);

let passed = 0;
const failed: string[] = [];
async function test(name: string, fn: () => unknown) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed.push(name);
    console.log(`  ✗ ${name}\n    ${String((e as Error).stack ?? e).split('\n').slice(0, 12).join('\n    ')}`);
  }
}

// ---------- синтетические DXF ----------

const g = (pairs: (string | number)[]) => pairs.map(String).join('\n') + '\n';
const doc = (body: string, units = 4) =>
  g(['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1027', '9', '$INSUNITS', '70', units, '0', 'ENDSEC']) +
  g(['0', 'SECTION', '2', 'TABLES', '0', 'LTYPE', '2', 'CENTER', '49', 12, '49', -3, '49', 0.5, '49', -3, '0', 'LAYER', '2', 'BEND', '6', 'CENTER', '62', 1, '70', 0, '0', 'ENDSEC']) +
  g(['0', 'SECTION', '2', 'ENTITIES']) +
  body +
  g(['0', 'ENDSEC', '0', 'EOF']);
const L = (x1: number, y1: number, x2: number, y2: number, o: { layer?: string; z?: [number, number]; paper?: boolean } = {}) =>
  g(['0', 'LINE', '8', o.layer ?? '0', ...(o.paper ? ['67', 1] : []), '10', x1, '20', y1, '30', o.z?.[0] ?? 0, '11', x2, '21', y2, '31', o.z?.[1] ?? 0]);
const rect = (w: number, h: number, o: { paper?: boolean } = {}) => L(0, 0, w, 0, o) + L(w, 0, w, h, o) + L(w, h, 0, h, o) + L(0, h, 0, 0, o);
const C = (x: number, y: number, r: number) => g(['0', 'CIRCLE', '8', '0', '10', x, '20', y, '30', 0, '40', r]);
const buf = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;
const run = (body: string, units = 4) => {
  const d = parseDxf(buf(doc(body, units)));
  const an = analyze(d);
  return { d, an, m: metricsOf(an.parts, an.bends), c: checkDxf(d, an) };
};
const codes = (c: ReturnType<typeof checkDxf>, level?: string) => c.issues.filter((i) => !level || i.level === level).map((i) => i.code);
const defs = { materialId: 'st3', thickness: 2 };

console.log('\nПарсер и проверка DXF');

await test('единицы: см и м пересчитываются в мм (раньше деталь была в 10 и 1000 раз меньше), дюймы — как раньше', () => {
  assert.equal(Math.round(run(rect(10, 5), 5).m.width), 100);
  assert.equal(Math.round(run(rect(0.1, 0.05), 6).m.width), 100);
  assert.equal(Math.round(run(rect(4, 2), 1).m.width * 10) / 10, 101.6);
  assert.deepEqual(codes(run(rect(10, 5), 5).c), ['units']);
});

await test('чистая пластина с отверстием и гибом по слою BEND — без ошибок и замечаний, 1 гиб с причиной', () => {
  const r = run(rect(200, 100) + C(30, 50, 5) + L(100, 0, 100, 100, { layer: 'BEND' }));
  assert.deepEqual(codes(r.c), []);
  assert.equal(r.an.bends.length, 1);
  assert.match(r.an.bendCands[0].why, /от края до края.*CENTER.*слой «BEND»/);
  assert.equal(r.c.minHole?.d, 10);
});

await test('ошибки: зазор в углу, отверстие за краем, 3D, только лист (Layout), картинка, крошечный габарит', () => {
  const gap = run(L(0, 0, 200, 0) + L(200, 0, 200, 100) + L(200, 100, 0, 100) + L(0, 100, 0, 0.3));
  assert.deepEqual(codes(gap.c, 'error'), ['gap']);
  assert.ok(gap.c.issues[0].at?.length);
  assert.ok(codes(run(rect(200, 100) + C(195, 50, 10)).c, 'error').includes('cross'));
  assert.ok(codes(run(rect(200, 100) + L(0, 0, 200, 0, { z: [30, 30] })).c, 'error').includes('3d'));
  assert.deepEqual(codes(run(rect(200, 100, { paper: true })).c, 'error'), ['paper']);
  assert.deepEqual(codes(run(g(['0', 'IMAGE', '8', '0', '10', 0, '20', 0])).c, 'error'), ['image']);
  assert.deepEqual(codes(run(rect(2, 1)).c, 'error'), ['scale']);
});

await test('замечания (цена считается): дубли, мусор, хвост, надпись и штриховка внутри детали', () => {
  const r = run(
    rect(200, 100) + L(0, 0, 200, 0) + L(10, 10, 10.05, 10) + L(200, 100, 205, 103) + g(['0', 'TEXT', '8', '0', '10', 50, '20', 50, '40', 5, '1', 'A-01']) + g(['0', 'HATCH', '8', '0', '10', 60, '20', 60]),
  );
  assert.deepEqual(codes(r.c, 'error'), []);
  for (const c of ['dup', 'micro', 'tail', 'text', 'fill']) assert.ok(codes(r.c, 'warn').includes(c as never), c);
});

await test('гибы: ось поперёк двух гибов — не гиб; пересечение в отверстии — можно; гиб из отрезков — один; коробка «крестом» — 4; короткая — не гиб', () => {
  const axis = run(rect(300, 200) + L(0, 60, 300, 60) + L(0, 140, 300, 140) + L(150, -5, 150, 205));
  assert.equal(axis.an.bends.length, 2);
  assert.match(axis.an.bendCands.find((c) => !c.bend)!.why, /пересекает 2 линии гиба/);
  const split = run(rect(300, 200) + C(150, 100, 10) + L(0, 100, 138, 100) + L(162, 100, 300, 100));
  assert.equal(split.an.bends.length, 1);
  assert.equal(Math.round(split.an.bends[0].length), 300);
  assert.match(split.an.bendCands[0].why, /2 отрезка на одной прямой/);
  // гибы пересекаются в отверстии (разгрузка угла) — это можно: оба гиба
  const relief = run(rect(300, 200) + C(60, 60, 8) + L(0, 60, 300, 60) + L(60, 0, 60, 200));
  assert.equal(relief.an.bends.length, 2);
  // развёртка коробки «крестом»: 4 линии гиба сходятся в углах основания, ось проходит через отверстие — 4 гиба, ось не гиб
  const cross = [[60, 0], [340, 0], [340, 60], [400, 60], [400, 240], [340, 240], [340, 300], [60, 300], [60, 240], [0, 240], [0, 60], [60, 60]];
  const outline = cross.map((q, i) => L(q[0], q[1], cross[(i + 1) % 12][0], cross[(i + 1) % 12][1])).join('');
  const box = run(outline + L(60, 60, 340, 60, { layer: 'BEND' }) + L(60, 240, 340, 240, { layer: 'BEND' }) + L(60, 60, 60, 240, { layer: 'BEND' }) + L(340, 60, 340, 240, { layer: 'BEND' }) + L(200, -10, 200, 310) + C(200, 150, 10));
  assert.equal(box.an.parts.length, 1);
  assert.equal(box.an.bends.length, 4);
  assert.equal(box.an.bendCands.filter((c) => !c.bend).length, 1);
  assert.deepEqual(codes(box.c), []);
  const short = run(rect(300, 200) + L(100, 100, 130, 100));
  assert.equal(short.an.bends.length, 0);
  assert.match(short.an.bendCands[0].why, /короче ¼/);
});

await test('реальные DXF из projects/ (КОМПАС, AutoCAD): ни одной ошибки, гибов в них нет', () => {
  const dirs = ['../../projects/2', '../../projects/3', '../../projects/4'].map((d) => new URL(d, import.meta.url).pathname);
  const files = dirs.filter(existsSync).flatMap((d) => readdirSync(d).filter((f) => /\.dxf$/i.test(f)).map((f) => join(d, f)));
  assert.ok(files.length >= 8, `DXF: ${files.length}`);
  for (const f of files) {
    const b = readFileSync(f);
    const p = positionFromDxf(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, f.split('/').pop()!, defs);
    assert.ok(!dxfBlocked(p), `${f}: ${p.dxfCheck?.issues.map((i) => i.text).join('; ')}`);
  }
  const p1 = process.argv[2];
  if (p1 && existsSync(p1) && statSync(p1).isDirectory()) {
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : /\.dxf$/i.test(f) ? [join(d, f)] : []));
    for (const f of walk(p1)) {
      const b = readFileSync(f);
      const p = positionFromDxf(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, f.split('/').pop()!, defs);
      assert.ok(!dxfBlocked(p), `${f}: ${p.dxfCheck?.issues.map((i) => i.text).join('; ')}`);
    }
  }
});

console.log('\nПозиция с ошибкой DXF');

const posOf = (body: string, name: string, extra: Partial<OrderPosition> = {}): OrderPosition => ({ ...positionFromDxf(buf(doc(body)), `${name}.dxf`, defs), qty: 2, ...extra });
const attIn = (o: Order) => {
  const res = computeOrder(pricedPositions(o.positions), book, orderSettings(o, settings));
  return buildAttention({ order: o, positions: o.positions, res, baseRes: res, book, settings, live: false, priceIssue: null, aiContext: null, outdated: false });
};

await test('цена не считается, пока не «Считать как есть»; замечание — ошибка с этой кнопкой; после — «посчитан как есть»', () => {
  const bad = posOf(L(0, 0, 200, 0) + L(200, 0, 200, 100) + L(200, 100, 0, 100) + L(0, 100, 0, 0.3) + C(100, 50, 10), 'БРАК-1');
  assert.ok(dxfBlocked(bad) && isUnpriced(bad));
  const o: Order = { ...emptyOrder(), positions: [bad] };
  const res = computeOrder(pricedPositions(o.positions), book, orderSettings(o, settings));
  assert.equal(res.positions.size, 0, 'в себестоимость не идёт');
  const it = attIn(o).open.find((i) => i.kind === 'dxfError')!;
  assert.equal(it.severity, 'problem');
  assert.ok(it.actions.some((a) => a.kind === 'acceptDxf'));
  const ok = { ...bad, dxfAccepted: true };
  assert.ok(!dxfBlocked(ok) && !isUnpriced(ok));
  const it2 = attIn({ ...o, positions: [ok] }).open.find((i) => i.kind === 'dxfError')!;
  assert.equal(it2.severity, 'check');
  assert.match(it2.title, /посчитан как есть/);
});

await test('отверстие меньше толщины и узкая перемычка — замечание по толщине позиции (тоньше — замечания нет)', () => {
  const p = posOf(rect(200, 100) + C(10, 50, 8) + C(100, 50, 1), 'ТОНК-1');
  assert.equal(p.dxfCheck?.minHole?.d, 2);
  assert.equal(Math.round((p.dxfCheck?.minBridge?.d ?? 0) * 10) / 10, 2);
  const at = (t: number) => attIn({ ...emptyOrder(), positions: [{ ...p, thickness: t }] }).open.find((i) => i.kind === 'dxfTech');
  assert.ok(at(3));
  assert.match(at(3)!.title, /отверстие 2\sмм меньше толщины 3\sмм.*перемычка/);
  assert.equal(at(1.5), undefined);
});

console.log('\nОткуда гибы и разбор гибов ИИ');

await test('bendSource: DXF — линии с причинами и длинами; исполнение — линии исполнения-близнеца', () => {
  const a = posOf(rect(300, 200) + L(0, 60, 300, 60) + L(0, 140, 300, 140) + L(150, -5, 150, 205), 'ГИБ-1');
  assert.equal(a.bendsFrom, 'dxf');
  const s = bendSource(a)!;
  assert.equal(s.kind, 'dxf');
  assert.equal(s.lines.length, 2);
  assert.equal(Math.round(s.lines[0].len), 300);
  assert.equal(s.rejected.length, 1);
  assert.match(s.text, /2 линии гиба в DXF/);
  const twin: OrderPosition = { ...posOf(rect(300, 200), 'ГИБ-1-01'), bends: 2, bendsFrom: 'twin', bendsNote: 'ГИБ-1' };
  const t = bendSource(twin, [a, twin])!;
  assert.equal(t.kind, 'twin');
  assert.equal(t.lines.length, 2);
  assert.match(t.text, /с исполнения ГИБ-1/);
});

await test('ответ модели: bends — по id или обозначению, число гибов целое 0…60 или null, без обоснования — отброшен; схема требует bends', () => {
  assert.ok((AI_RESPONSE_SCHEMA.required as readonly string[]).includes('bends'));
  const ctx = {
    positions: [
      { id: 'p1', name: 'НГЭН.111.0001', disabled: false, bends: 4, detectedBends: 4 },
      { id: 'p2', name: 'НГЭН.111.0002', disabled: false, bends: 0, detectedBends: 0 },
    ],
    materials: [],
    order: { request: '' },
    documents: [],
    unmatchedRequestLines: [],
    rates: { extraOps: [] },
  } as unknown as AiContext;
  const a = sanitizeAnalysis(
    {
      summary: 'x',
      confidence: 'high',
      positions: [],
      bends: [
        { id: 'p1', reasoning: '4 полки на виде сбоку', count: 4 },
        { id: 'НГЭН.111.0002', reasoning: 'не видно', count: null },
        { id: 'p1', reasoning: 'повтор', count: 9 },
        { id: 'zz', reasoning: 'чужая', count: 1 },
        { id: 'p2', reasoning: '', count: 2 },
      ],
      questions: [],
      risks: [],
      recommendations: [],
    },
    ctx,
    { model: 'm', durationMs: 1 },
  );
  assert.deepEqual(a.bends, [
    { id: 'p1', count: 4, reasoning: '4 полки на виде сбоку' },
    { id: 'p2', count: null, reasoning: 'не видно' },
  ]);
});

console.log(`\n${passed} прошло, ${failed.length} не прошло`);
if (failed.length) process.exit(1);
