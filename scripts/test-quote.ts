// Тесты КП для клиента: node scripts/test-quote.ts
// Округление цены за шт, сумма прописью, одна и та же «Цена клиенту» в тексте, TSV, CSV и по строкам
// (при всех режимах округления), «цена уточняется» (позиция без размеров не входит в деньги), своя наценка (сценарии),
// шаблоны текста и таблицы (ui-spec §7.2).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeOrder, DEFAULT_SETTINGS, type PriceBook, type Settings } from '../src/core/pricing.ts';
import { internalCsv } from '../src/exportCsv.ts';
import { amountInWords, integerInWords } from '../src/numberWords.ts';
import { emptyOrder, manualPosition, orderSettings, type Order, type OrderPosition } from '../src/order.ts';
import {
  buildQuote,
  clientMoney,
  clientRows,
  DEFAULT_QUOTE,
  materialText,
  pricedPositions,
  quoteCsv,
  quoteText,
  quoteTsv,
  roundPiece,
  UNPRICED_NOTE,
  type PieceRounding,
  type Quote,
  type QuoteSettings,
} from '../src/quote.ts';

const book: PriceBook = JSON.parse(readFileSync(new URL('../public/prices.json', import.meta.url), 'utf8'));
const settings: Settings = structuredClone(DEFAULT_SETTINGS);

let passed = 0;
const failed: string[] = [];
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed.push(name);
    console.log(`  ✗ ${name}\n    ${String((e as Error).message).split('\n').slice(0, 30).join('\n    ')}`);
  }
}

/** Неразрывные пробелы → обычные (шаблоны в спецификации — с обычными) */
const sp = (s: string) => s.replace(/[\u00a0\u202f]/g, ' ');
const kop = (v: number) => Math.round(v * 100);

// ---------- заказ для проверок ----------

function plate(name: string, materialId: string, t: number, qty: number, w: number, h: number, holes = 2, bends = 0): OrderPosition {
  return manualPosition({ name, materialId, thickness: t, qty, width: w, height: h, holes, holeD: 9, bends });
}

function makeOrder(): Order {
  const o = emptyOrder();
  o.title = 'НГ-Энерго — зашивка';
  o.delivery = 1500;
  o.positions = [
    plate('НГЭН.745421.0001', '08ps', 2, 5, 2480, 416, 4, 2),
    plate('НГЭН.745535.0021-01', '08ps', 1.5, 5, 310, 120, 2, 1),
    plate('НГЭН.А86.11.13.0002', 'rifl', 3, 5, 600, 450, 0, 0),
    { ...plate('Кронштейн КР-112', 'st3', 2, 2, 0, 0, 0, 0), geom: { width: 0, height: 0, netArea: 0, bboxArea: 0, cutLength: 0, pierces: 0, count: 1 } },
    { ...plate('Отключённая', 'st3', 2, 3, 100, 100), disabled: true },
    plate('Ноль штук', 'st3', 2, 0, 100, 100),
    plate('Мелочь', 'st3', 1.5, 37, 40, 25, 1, 0),
  ];
  o.positions[1].note = 'по образцу';
  return o;
}

/** Как в приложении (store/derived.tsx): деньги — по позициям с размерами, в КП — все позиции */
function quoteFor(o: Order, qs: QuoteSettings, markupPct?: number, now = new Date(2026, 9, 16, 12)): Quote {
  const res = computeOrder(pricedPositions(o.positions), book, orderSettings(o, settings));
  return buildQuote({ order: o, positions: o.positions, res, settings, quote: qs, book, markupPct, now });
}

// ---------- округление и сумма прописью ----------
console.log('Округление и сумма прописью');

test('roundPiece: коп., 1 ₽, 10 ₽ (меньше 100 ₽ — до рубля)', () => {
  assert.equal(roundPiece(4043.555, 'kop'), 4043.56);
  assert.equal(roundPiece(4043.5, 'rub'), 4044);
  assert.equal(roundPiece(4043.49, 'rub'), 4043);
  assert.equal(roundPiece(4044, 'ten'), 4040);
  assert.equal(roundPiece(4045, 'ten'), 4050);
  assert.equal(roundPiece(105, 'ten'), 110);
  assert.equal(roundPiece(99.5, 'ten'), 100);
  assert.equal(roundPiece(87.4, 'ten'), 87);
  assert.equal(roundPiece(Number.NaN, 'rub'), 0);
});

test('amountInWords: примеры из спецификации', () => {
  assert.equal(amountInWords(212740), 'Двести двенадцать тысяч семьсот сорок рублей 00 копеек');
  assert.equal(amountInWords(1001.5), 'Одна тысяча один рубль 50 копеек');
});

test('amountInWords: род, склонения, копейки, большие числа', () => {
  assert.equal(amountInWords(0), 'Ноль рублей 00 копеек');
  assert.equal(amountInWords(1), 'Один рубль 00 копеек');
  assert.equal(amountInWords(2), 'Два рубля 00 копеек');
  assert.equal(amountInWords(5), 'Пять рублей 00 копеек');
  assert.equal(amountInWords(11), 'Одиннадцать рублей 00 копеек');
  assert.equal(amountInWords(21.01), 'Двадцать один рубль 01 копейка');
  assert.equal(amountInWords(22.02), 'Двадцать два рубля 02 копейки');
  assert.equal(amountInWords(2000), 'Две тысячи рублей 00 копеек');
  assert.equal(amountInWords(11000), 'Одиннадцать тысяч рублей 00 копеек');
  assert.equal(amountInWords(76260), 'Семьдесят шесть тысяч двести шестьдесят рублей 00 копеек');
  assert.equal(amountInWords(1_000_000), 'Один миллион рублей 00 копеек');
  assert.equal(amountInWords(2_000_000), 'Два миллиона рублей 00 копеек');
  assert.equal(
    amountInWords(1_234_567_891.23),
    'Один миллиард двести тридцать четыре миллиона пятьсот шестьдесят семь тысяч восемьсот девяносто один рубль 23 копейки',
  );
  assert.equal(
    amountInWords(999_999_999_999.99),
    'Девятьсот девяносто девять миллиардов девятьсот девяносто девять миллионов девятьсот девяносто девять тысяч девятьсот девяносто девять рублей 99 копеек',
  );
  assert.equal(amountInWords(13751.8), 'Тринадцать тысяч семьсот пятьдесят один рубль 80 копеек');
  assert.equal(amountInWords(0.999), 'Один рубль 00 копеек'); // копейки округляются
  assert.equal(integerInWords(100_100), 'сто тысяч сто');
});

// ---------- КП: одна сумма везде ----------
console.log('КП: «Цена клиенту» одна и та же везде');

for (const rounding of ['kop', 'rub', 'ten'] as PieceRounding[]) {
  test(`округление «${rounding}»: строки, итог, НДС, текст, TSV, CSV совпадают до копейки`, () => {
    const o = makeOrder();
    const q = quoteFor(o, { ...DEFAULT_QUOTE, rounding });
    // в КП: включённые, qty > 0, по порядку
    assert.deepEqual(
      q.lines.map((l) => l.name),
      ['НГЭН.745421.0001', 'НГЭН.745535.0021-01', 'НГЭН.А86.11.13.0002', 'Кронштейн КР-112', 'Мелочь'],
    );
    assert.deepEqual(
      q.lines.map((l) => l.n),
      [1, 2, 3, 4, 5],
    );
    let sumKop = 0;
    for (const l of q.lines) {
      if (l.price == null) continue;
      assert.equal(l.price, roundPiece(l.price, rounding), `${l.name}: цена округлена`);
      assert.equal(kop(l.sum!), kop(l.price) * l.qty, `${l.name}: сумма = цена × кол-во`);
      sumKop += kop(l.sum!);
    }
    assert.ok(q.delivery > 0);
    assert.equal(q.delivery, roundPiece(1500 * 1.5, rounding));
    assert.equal(kop(q.total), sumKop + kop(q.delivery), 'итог = Σ сумм + доставка');
    assert.equal(q.vat, Math.round((kop(q.total) * 22) / 122) / 100, 'НДС = итог × 22/122, до копейки');
    assert.equal(q.unpriced, 1);
    assert.equal(q.revenue, q.total - q.cost);
    // разница с точным расчётом — только из-за округления
    const exactPriced = q.lines.filter((l) => l.price != null).reduce((a, l) => a + l.exactSum, 0) + 1500 * 1.5;
    assert.ok(Math.abs(q.total - q.roundingDiff - exactPriced) < 1e-6);
    const maxStep = rounding === 'kop' ? 0.005 : rounding === 'rub' ? 0.5 : 5;
    const pcs = q.lines.filter((l) => l.price != null).reduce((a, l) => a + l.qty, 0) + 1;
    assert.ok(Math.abs(q.roundingDiff) <= maxStep * pcs + 1e-6, `разница ${q.roundingDiff} в пределах округления`);
    // текст для письма
    const text = quoteText(q);
    assert.ok(text.includes(`Итого: ${clientMoney(q, q.total)}, в т.ч. НДС 22\u00a0% — `), 'итог в тексте');
    assert.ok(text.includes('4. Кронштейн КР-112 — Ст3 горячекатаный 2\u00a0мм — 2\u00a0шт — цена уточняется'));
    assert.ok(text.includes(UNPRICED_NOTE));
    for (const l of q.lines) {
      if (l.price != null) assert.ok(text.includes(`× ${clientMoney(q, l.price)} = ${clientMoney(q, l.sum!)}`), `строка ${l.n} в тексте`);
    }
    // TSV и CSV
    const d = rounding === 'kop' ? 2 : 0;
    const plainTotal = d ? q.total.toFixed(2).replace('.', ',') : String(q.total);
    const tsv = quoteTsv(q).split('\n');
    assert.equal(tsv.find((r) => r.split('\t')[1] === 'Итого')!.split('\t').at(-1), plainTotal);
    const csv = quoteCsv(q);
    assert.ok(csv.startsWith('\uFEFF'));
    const csvRows = csv.slice(1).split('\r\n');
    assert.equal(csvRows.find((r) => r.split(';')[1] === 'Итого')!.split(';').at(-1), plainTotal);
    assert.equal(csvRows.length, tsv.length);
    // сумма строк TSV + доставка = «Итого»
    const num = (s: string) => Number(s.replace(',', '.'));
    const body = tsv.slice(1).filter((r) => /^\d+\t/.test(r));
    const tsvSum = body.reduce((a, r) => a + kop(num(r.split('\t').at(-1)! || '0')), 0);
    assert.equal(tsvSum + kop(q.delivery), kop(q.total));
  });
}

test('своя наценка (сценарии): строка с текущей наценкой = KPI; другая — от себестоимости × k', () => {
  const o = makeOrder();
  const qs = { ...DEFAULT_QUOTE, rounding: 'rub' as const };
  const base = quoteFor(o, qs);
  const same = quoteFor(o, qs, 50);
  assert.equal(same.total, base.total);
  assert.equal(same.vat, base.vat);
  const q30 = quoteFor(o, qs, 30);
  const res = computeOrder(o.positions, book, orderSettings(o, settings));
  for (const l of q30.lines) {
    if (l.price == null) continue;
    assert.equal(l.price, Math.round(res.positions.get(l.positionId)!.piece.total * 1.3));
  }
  assert.equal(q30.delivery, 1950);
  assert.equal(q30.markupPct, 30);
  assert.equal(q30.cost, base.cost);
  assert.ok(q30.total < base.total);
  // наценка под цену: m = round1((target / cost − 1) × 100)
  const target = Math.round(base.cost * 1.41);
  const m = Math.round((target / base.cost - 1) * 1000) / 10;
  assert.equal(m, 41);
});

test('без цены: «—» в строке, в итог не входит; исключённые и 0 шт — не в КП', () => {
  const o = makeOrder();
  const q = quoteFor(o, DEFAULT_QUOTE);
  const l = q.lines.find((x) => x.name === 'Кронштейн КР-112')!;
  assert.equal(l.price, null);
  assert.equal(l.sum, null);
  assert.ok(!q.lines.some((x) => x.name === 'Отключённая' || x.name === 'Ноль штук'));
  const tsv = quoteTsv(q);
  assert.ok(tsv.includes('4\tКронштейн КР-112\tСт3 горячекатаный 2\u00a0мм\t2\tшт\tцена уточняется\t'));
  // без строк без цены — примечания нет
  o.positions = o.positions.filter((p) => p.name !== 'Кронштейн КР-112');
  const q2 = quoteFor(o, DEFAULT_QUOTE);
  assert.equal(q2.unpriced, 0);
  assert.ok(!quoteText(q2).includes(UNPRICED_NOTE));
});

test('без размеров (скан с гибкой и покраской): не в себестоимости и раскрое, выручка и маржа сходятся, «Наценка под цену» попадает', () => {
  const o = makeOrder();
  const qs = { ...DEFAULT_QUOTE, rounding: 'kop' as const };
  const base = o.positions.filter((p) => p.name !== 'Кронштейн КР-112');
  assert.equal(pricedPositions(base), base, 'нет позиций без размеров — тот же массив');
  o.positions = base;
  const q0 = quoteFor(o, qs);
  // скан: размеров нет, но гибка и покраска (так бывает после предложений ИИ); в группе мелкой детали 08пс 1,5
  const scan: OrderPosition = { ...plate('Скан КР-7', '08ps', 1.5, 20, 0, 0, 0, 2), extras: [{ label: 'Покраска', perPiece: 650 }] };
  scan.geom = { width: 0, height: 0, netArea: 0, bboxArea: 0, cutLength: 0, pierces: 0, count: 1 };
  o.positions = [...base, scan];
  const priced = pricedPositions(o.positions);
  assert.notEqual(priced, o.positions);
  assert.equal(priced.at(-1)!.disabled, true, 'для расчёта — как исключённая');
  assert.equal(o.positions.at(-1)!.disabled, undefined, 'сама позиция не меняется');
  assert.ok(priced.slice(0, -1).every((p, i) => p === o.positions[i]), 'остальные — те же объекты');
  const q = quoteFor(o, qs);
  // строка в КП осталась — «цена уточняется»
  const l = q.lines.at(-1)!;
  assert.deepEqual([l.name, l.price, l.sum, q.unpriced], ['Скан КР-7', null, null, 1]);
  assert.ok(quoteText(q).includes('Скан КР-7 — 08пс холоднокатаный 1,5\u00a0мм — 20\u00a0шт — цена уточняется'));
  // себестоимость, цена клиенту и цены других строк — как без скана (нет фантомной заготовки в раскрое)
  assert.equal(q.cost, q0.cost);
  assert.equal(q.total, q0.total);
  assert.deepEqual(
    q.lines.slice(0, -1).map((x) => [x.name, x.price, x.sum]),
    q0.lines.map((x) => [x.name, x.price, x.sum]),
  );
  assert.equal(q.revenue, q.total - q.cost);
  assert.ok(Math.abs(q.marginPct - (50 / 150) * 100) < 0.01, `маржа ${q.marginPct} = наценка 50 % от цены`);
  // без pricedPositions гибка и покраска скана попали бы в себестоимость
  const raw = computeOrder(o.positions, book, orderSettings(o, settings));
  assert.ok(raw.totals.cost - q.cost >= 650 * 20, `${raw.totals.cost} − ${q.cost}`);
  // «Наценка под цену»: m = round1((цель / себестоимость − 1) × 100) → итог у цели (до округления наценки и цен за шт)
  const target = Math.round(q.cost * 1.62);
  const m = Math.round((target / q.cost - 1) * 1000) / 10;
  const fit = quoteFor(o, qs, m);
  const pcs = fit.lines.filter((x) => x.price != null).reduce((a, x) => a + x.qty, 0);
  assert.ok(Math.abs(fit.total - target) <= q.cost * 0.0005 + pcs * 0.005 + 0.01, `итог ${fit.total} при цели ${target}`);
  // внутренний CSV: строка скана — «цена уточняется», итоги без него
  const res = computeOrder(priced, book, orderSettings(o, settings));
  const rows = internalCsv(o.title, o.positions, res, o.markupPct, q.total).slice(1).split('\r\n');
  const scanRow = rows.find((r) => r.split(';')[1] === '"Скан КР-7"')!.split(';');
  assert.equal(scanRow.length, rows[0].split(';').length);
  assert.deepEqual([scanRow[10], scanRow.at(-2), scanRow.at(-1)], ['2', '"цена уточняется"', '']);
  const costRow = rows.find((r) => r.startsWith(';"Себестоимость";'))!;
  assert.equal(costRow.split(';').at(-1), q.cost.toFixed(2).replace('.', ','));
});

test('примечания: своё примечание, «из N частей» при разбиении; showNotes=false — пусто', () => {
  const o = makeOrder();
  o.positions[0].geom = { ...o.positions[0].geom, width: 3200, height: 1600, bboxArea: 3200 * 1600, netArea: 3200 * 1600 - 1000 };
  const q = quoteFor(o, DEFAULT_QUOTE);
  assert.equal(q.lines[1].note, 'по образцу');
  assert.match(q.lines[0].note, /^из \d+ частей$/);
  const q2 = quoteFor(o, { ...DEFAULT_QUOTE, showNotes: false });
  assert.ok(q2.lines.every((x) => x.note === ''));
});

test('материал скрыт: в тексте нет « — материал», в TSV нет столбца', () => {
  const o = makeOrder();
  const q = quoteFor(o, { ...DEFAULT_QUOTE, showMaterial: false });
  assert.ok(quoteText(q).includes('1. НГЭН.745421.0001 — 5\u00a0шт × '));
  const head = quoteTsv(q).split('\n')[0];
  assert.equal(head, '№\tНаименование\tКол-во\tЕд.\tЦена, ₽\tСумма, ₽');
  assert.ok(clientRows(q).every((r) => r.length === 6));
});

test('materialText: без пояснения в скобках, толщина с запятой', () => {
  assert.equal(sp(materialText('08ps', 2)), '08пс холоднокатаный 2 мм');
  assert.equal(sp(materialText('rifl', 3)), 'Рифлёный Ст3 3 мм');
  assert.equal(sp(materialText('aisi304', 1.5)), 'Нерж. AISI 304 1,5 мм');
});

test('дата металла — самая старая цена среди групп; works — по видам работ', () => {
  const o = makeOrder();
  const b2: PriceBook = structuredClone(book);
  for (const i of b2.materials['08ps']) if (i.t === 2) i.fetchedAt = '2026-10-10T10:00:00Z';
  for (const i of b2.materials['08ps']) if (i.t === 1.5) i.fetchedAt = '2026-10-15T10:00:00Z';
  const res = computeOrder(o.positions, b2, orderSettings(o, settings));
  const q = buildQuote({ order: o, positions: o.positions, res, settings, quote: DEFAULT_QUOTE, book: b2 });
  assert.equal(q.metalDate, '10.10.2026');
  assert.equal(q.works, 'лазерная резка, гибка');
  const q2 = buildQuote({ order: o, positions: o.positions, res, settings, quote: DEFAULT_QUOTE, book: { ...b2, materials: {}, updatedAt: null } });
  assert.equal(q2.metalDate, null);
  assert.ok(!quoteText(q2).includes('Стоимость металла'));
});

// ---------- шаблоны (ui-spec §7.2) ----------
console.log('Шаблоны текста и таблицы');

/** КП из примера спецификации (числа заданы вручную) */
function sampleQuote(over: Partial<QuoteSettings> = {}): Quote {
  const qs = { ...DEFAULT_QUOTE, ...over };
  const lines = [
    {
      n: 1, positionId: 'a', name: 'НГЭН.745421.0001', material: '08пс холоднокатаный 2\u00a0мм',
      qty: 5, price: 4044, sum: 20220, exactSum: 20219, note: 'из двух частей 2480 и 416 мм',
    },
    {
      n: 2, positionId: 'b', name: 'НГЭН.745535.0021-01', material: '08пс холоднокатаный 1,5\u00a0мм',
      qty: 5, price: 1299, sum: 6495, exactSum: 6495, note: '',
    },
    { n: 3, positionId: 'c', name: 'НГЭН.А86.11.13.0002', material: 'Рифлёный Ст3 3\u00a0мм', qty: 5, price: 9459, sum: 47295, exactSum: 47296, note: '' },
    { n: 4, positionId: 'd', name: 'Кронштейн КР-112', material: 'Ст3 горячекатаный 2\u00a0мм', qty: 2, price: null, sum: null, exactSum: 0, note: '' },
  ];
  return {
    title: 'НГ-Энерго — зашивка',
    date: '16.10.2026',
    lines,
    linesById: new Map(lines.map((l) => [l.positionId, l])),
    delivery: 2250,
    total: 76260,
    vat: 13751.8,
    vatPct: 22,
    unpriced: 1,
    exactTotal: 76261,
    roundingDiff: -1,
    cost: 50840,
    revenue: 25420,
    marginPct: 33.3,
    markupPct: 50,
    metalDate: '16.10.2026',
    works: 'лазерная резка, гибка',
    settings: qs,
  };
}

test('«Скопировать для клиента»: пример из спецификации слово в слово', () => {
  const expected = [
    'Расчёт стоимости изготовления деталей',
    'НГ-Энерго — зашивка · 16.10.2026',
    '',
    '1. НГЭН.745421.0001 — 08пс холоднокатаный 2 мм — 5 шт × 4 044 ₽ = 20 220 ₽ (из двух частей 2480 и 416 мм)',
    '2. НГЭН.745535.0021-01 — 08пс холоднокатаный 1,5 мм — 5 шт × 1 299 ₽ = 6 495 ₽',
    '3. НГЭН.А86.11.13.0002 — Рифлёный Ст3 3 мм — 5 шт × 9 459 ₽ = 47 295 ₽',
    '4. Кронштейн КР-112 — Ст3 горячекатаный 2 мм — 2 шт — цена уточняется',
    'Доставка — 2 250 ₽',
    '',
    'Итого: 76 260 ₽, в т.ч. НДС 22 % — 13 751,80 ₽',
    'Позиции с пометкой «цена уточняется» в итог не входят.',
    'Цены с НДС 22 %, действительны 5 рабочих дней. Стоимость металла — на 16.10.2026.',
  ].join('\n');
  assert.equal(sp(quoteText(sampleQuote())), expected);
});

test('текст: без названия — только дата; условия; вопросы; срок 0 / 1 день', () => {
  const q = sampleQuote({ terms: 'Срок изготовления — 10 рабочих дней', validityDays: 1 });
  q.title = '';
  const t = sp(quoteText(q, { questions: ['Какое покрытие?', '  ', 'Сколько комплектов?'] }));
  const lines = t.split('\n');
  assert.equal(lines[1], '16.10.2026');
  assert.ok(t.includes('Цены с НДС 22 %, действительны 1 рабочий день. Стоимость металла — на 16.10.2026.\nСрок изготовления — 10 рабочих дней'));
  assert.ok(t.endsWith('\n\nПросим уточнить:\n1. Какое покрытие?\n2. Сколько комплектов?'));
  const q0 = sampleQuote({ validityDays: 0 });
  assert.ok(sp(quoteText(q0)).includes('Цены с НДС 22 %. Стоимость металла — на 16.10.2026.'));
  const q3 = sampleQuote({ validityDays: 3 });
  assert.ok(sp(quoteText(q3)).includes('действительны 3 рабочих дня.'));
});

test('текст «коп.»: цены и суммы с копейками', () => {
  const q = sampleQuote({ rounding: 'kop' });
  q.lines[0].price = 4043.6;
  q.lines[0].sum = 20218;
  const t = sp(quoteText(q));
  assert.ok(t.includes('5 шт × 4 043,60 ₽ = 20 218,00 ₽'));
  assert.ok(t.includes('Итого: 76 260,00 ₽, в т.ч. НДС 22 % — 13 751,80 ₽'));
});

test('«Скопировать таблицей»: строки как в спецификации', () => {
  const tsv = sp(quoteTsv(sampleQuote())).split('\n');
  assert.equal(tsv[0], '№\tНаименование\tМатериал\tКол-во\tЕд.\tЦена, ₽\tСумма, ₽');
  assert.equal(tsv[1], '1\tНГЭН.745421.0001\t08пс холоднокатаный 2 мм\t5\tшт\t4044\t20220');
  assert.equal(tsv[4], '4\tКронштейн КР-112\tСт3 горячекатаный 2 мм\t2\tшт\tцена уточняется\t');
  assert.equal(tsv[5], '\tДоставка\t\t\t\t\t2250');
  assert.equal(tsv[6], '\tИтого\t\t\t\t\t76260');
  assert.equal(tsv[7], '\tв т.ч. НДС 22 %\t\t\t\t\t13751,80');
  assert.equal(tsv.length, 8);
});

test('CSV для клиента: «;», BOM, CRLF, кавычки там, где нужны', () => {
  const q = sampleQuote();
  q.lines[1].name = 'Деталь; "с кавычками"';
  const csv = quoteCsv(q);
  assert.ok(csv.startsWith('\uFEFF№;Наименование;Материал;'));
  assert.ok(csv.includes('\r\n2;"Деталь; ""с кавычками""";'));
  assert.ok(csv.includes('\r\n;Итого;;;;;76260\r\n'));
  assert.ok(!csv.includes('\n\n'));
});

test('внутренний CSV: заголовок, позиции с ценой, итоги, «Цена клиенту в КП»', () => {
  const o = makeOrder();
  const res = computeOrder(o.positions, book, orderSettings(o, settings));
  const csv = internalCsv(o.title, o.positions, res, o.markupPct, res.totals.total + 3);
  assert.ok(csv.startsWith('\uFEFF№;Обозначение;Файл;'));
  const rows = csv.slice(1).split('\r\n');
  assert.equal(rows.filter((r) => /^\d+;/.test(r)).length, res.positions.size);
  assert.ok(rows.some((r) => r.startsWith(';"ИТОГО (с НДС)";')));
  assert.ok(rows.some((r) => r.startsWith(';"Цена клиенту в КП (цена за шт округлена)";')));
});

console.log(`\n${passed} прошло, ${failed.length} не прошло`);
if (failed.length) {
  for (const f of failed) console.log(`  ✗ ${f}`);
  process.exit(1);
}
