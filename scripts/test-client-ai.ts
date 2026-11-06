// Тесты клиентского слоя ИИ: node scripts/test-client-ai.ts
// Текст чертежей (PDF/DXF), контекст и его хэш, политика предложений ИИ, наложение и ручные правки,
// свежесть цен, протокол задач ИИ (fetch подменяется), разбор файлов в Node, совместимость заказов.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { AI_LIMITS, type AiAnalysis, type AiState, type AiSuggestion } from '../src/core/ai.ts';
import { CUT_MARK, cleanMtext, cleanPdfStr, clipText, documentLines, dxfText, dxfTextLines, isNoise, mergeDrawingTexts, pdfTextLines } from '../src/core/drawingText.ts';
import { parseDxf } from '../src/core/dxf.ts';
import { readPdf, type PdfJsLike, type PdfPageData } from '../src/core/pdf.ts';
import { groupDrawings } from '../src/core/pdfAnalyze.ts';
import { computeOrder, DEFAULT_SETTINGS, type PriceBook, type Settings } from '../src/core/pricing.ts';
import {
  aiDisabled,
  aiStateFrom,
  appliedCount,
  changesFor,
  decisionOf,
  defaultAccepted,
  effectivePositions,
  manualEdit,
  onManualEdit,
  pendingOffers,
  resetSuggestion,
  revertAll,
  reviewFor,
  suggestionsFor,
  toggleSuggestion,
} from '../src/ai/apply.ts';
import { AiError, aiStatus, analyzeOrder } from '../src/ai/api.ts';
import { aiTitle, buildAttention, splitSentence, textHints } from '../src/attention.ts';
import { extractQuotes, findEvidence, normalize } from '../src/evidence.ts';
import { buildAiContext, contextHash, cyrb53, shareBudget, stableStringify } from '../src/ai/context.ts';
import { emptyOrder, manualPosition, normalizeOrder, orderSettings, type Order, type OrderPosition } from '../src/order.ts';
import { APP_UPDATED, pdfErrorText, pdfFileKey, positionsFromPages } from '../src/pdfImport.ts';
import { decodeText, parseFiles, runQuote, updateStage, initialStages } from '../src/pipeline.ts';
import { ensurePrices, pairAge, resetPriceAttempts, stalePairs } from '../src/prices.ts';

const PROJECTS = new URL('../../projects/', import.meta.url).pathname;
const book: PriceBook = JSON.parse(readFileSync(new URL('../public/prices.json', import.meta.url), 'utf8'));
const settings: Settings = structuredClone(DEFAULT_SETTINGS);

let passed = 0;
const failed: string[] = [];
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed.push(name);
    console.log(`  ✗ ${name}\n    ${String((e as Error).message).split('\n').slice(0, 40).join('\n    ')}`);
  }
}

const ab = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
async function pdfPages(rel: string): Promise<PdfPageData[]> {
  return readPdf(pdfjs as unknown as PdfJsLike, ab(readFileSync(join(PROJECTS, rel))));
}

// ---------- текст чертежей ----------
console.log('Текст чертежей');

await test('cleanMtext: коды форматирования, \\P, \\U+, %%-коды, дроби', () => {
  assert.equal(cleanMtext('\\H3.5;\\W0.965;\\Q15;\\Q15;\\W0.659;\\H10.00;Блок выхода сброса'), 'Блок выхода сброса');
  assert.equal(cleanMtext('141\\fSymbol_ASME;{\\W1.0;\\U+00B0}'), '141°');
  assert.equal(cleanMtext('R2\\P7 \\U+0440\\U+0430\\U+0434\\U+0438\\U+0443\\U+0441\\U+043E\\U+0432'), 'R2\n7 радиусов');
  assert.equal(cleanMtext('%%c10 %%p0,1 90%%d %%uподчёркнуто%%u 100%%%'), 'Ø10 ±0,1 90° подчёркнуто 100%');
  assert.equal(cleanMtext('{\\fArial|b1|i0;Покрытие:} \\LRAL 7035\\l'), 'Покрытие: RAL 7035');
  assert.equal(cleanMtext('\\S1/2;" резьба'), '1/2" резьба');
  assert.equal(cleanMtext('\\A1;Сталь\\~3 \\{скобки\\}'), 'Сталь 3 {скобки}');
});

await test('cleanPdfStr: символьный шрифт КОМПАС (Ç → Ø, Å → °, 27•45 → 27×45)', () => {
  assert.equal(cleanPdfStr('Ç'), 'Ø');
  assert.equal(cleanPdfStr('Å'), '°');
  assert.equal(cleanPdfStr('27•45'), '27×45');
  assert.equal(cleanPdfStr('ä'), '');
  assert.equal(cleanPdfStr('  Сварка\u0000 швом  '), 'Сварка швом');
});

await test('isNoise: размеры — шум, слова, резьба и толщина — нет', () => {
  for (const s of ['25', 'Ø10,5', 'R3', '2*', '141°', '27×45°', '(1:5)', 'L', 'A*', 'А-А', '*', 'Ra 25', 'С2', 'A(1:5)', 'Изометрический вид (1:15)']) assert.ok(isNoise(s), s);
  for (const s of ['4 отв.', '6 фасок', 'М6', 'M8-7H', 's2*', 'Линия сгиба', 'Покраска RAL 7035']) assert.ok(!isNoise(s), s);
});

await test('clipText: обрезка по строке с меткой', () => {
  const t = Array.from({ length: 50 }, (_, i) => `строка номер ${i}`).join('\n');
  const c = clipText(t, 200);
  assert.ok(c.length <= 200, `длина ${c.length}`);
  assert.ok(c.endsWith(CUT_MARK));
  assert.equal(clipText('коротко', 200), 'коротко');
});

await test('dxfTextLines: подписи граф убраны, «Масса»/«Масштаб» со значением, ТТ первыми', () => {
  const labels = [
    { x: 172.9, y: 44.4, str: '\\H3.5;\\W0.965;Масса' },
    { x: 172.5, y: 35.3, str: '\\H5.00;4,66' },
    { x: 187.8, y: 44.4, str: 'Масштаб' },
    { x: 192.6, y: 35.3, str: '\\H5.00;1:1' },
    { x: 20.5, y: 34.4, str: 'Разраб.' },
    { x: 8.5, y: 7.3, str: 'Инв. № подл.' },
    { x: 86.1, y: 38.1, str: '\\W0.659;\\H10.00;Блок выхода сброса' },
    { x: 85.7, y: 16.4, str: 'Сталь 10  ГОСТ 1050-88' },
    { x: 300, y: 200, str: '25' },
    { x: 10, y: 120, str: 'Технические требования\\P1. Покрытие: порошковая окраска RAL 7035\\P2. Острые кромки притупить' },
  ];
  const lines = dxfTextLines(labels);
  assert.deepEqual(lines, ['Технические требования', '1. Покрытие: порошковая окраска RAL 7035', '2. Острые кромки притупить', 'Блок выхода сброса', 'Сталь 10 ГОСТ 1050-88', 'Масса 4,66', 'Масштаб 1:1']);
  assert.ok(dxfText(labels, 60).endsWith(CUT_MARK));
});

await test('parseDxf: TEXT/MTEXT (коды 3+1) и ATTRIB в labels, вставка блока и дюймы', () => {
  const dxf = (units: number) =>
    [
      '0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1021', '9', '$INSUNITS', '70', String(units), '0', 'ENDSEC',
      '0', 'SECTION', '2', 'BLOCKS',
      '0', 'BLOCK', '2', 'B1', '10', '0', '20', '0',
      '0', 'TEXT', '8', '0', '10', '1', '20', '2', '40', '3', '1', 'В блоке',
      '0', 'ENDBLK',
      '0', 'ENDSEC',
      '0', 'SECTION', '2', 'ENTITIES',
      '0', 'LINE', '8', '0', '10', '0', '20', '0', '11', '100', '21', '0',
      '0', 'TEXT', '8', '0', '10', '5', '20', '6', '40', '3', '1', '%%c12 4 отв.',
      '0', 'MTEXT', '8', '0', '10', '7', '20', '8', '40', '3', '3', 'Начало длинного т', '1', 'екста',
      '0', 'INSERT', '8', '0', '2', 'B1', '10', '100', '20', '200',
      '0', 'ATTRIB', '8', '0', '10', '9', '20', '9', '40', '3', '1', 'Атрибут', '70', '0',
      '0', 'ATTRIB', '8', '0', '10', '9', '20', '9', '40', '3', '1', 'Скрытый', '70', '1',
      '0', 'ENDSEC', '0', 'EOF', '',
    ].join('\n');
  const toBuf = (s: string) => ab(Buffer.from(new TextEncoder().encode(s)));
  const d = parseDxf(toBuf(dxf(4)));
  assert.equal(d.prims.length, 1, 'геометрия не изменилась');
  assert.equal(d.texts.length, 3);
  assert.deepEqual(d.labels, [
    { x: 5, y: 6, str: '%%c12 4 отв.' },
    { x: 7, y: 8, str: 'Начало длинного текста' },
    { x: 101, y: 202, str: 'В блоке' },
    { x: 9, y: 9, str: 'Атрибут' },
  ]);
  const inch = parseDxf(toBuf(dxf(1)));
  assert.deepEqual(inch.labels![0], { x: 5 * 25.4, y: 6 * 25.4, str: '%%c12 4 отв.' });
  assert.deepEqual(inch.texts[0], { x: 5 * 25.4, y: 6 * 25.4 }, 'texts пересчитаны один раз');
});

await test('PDF БВС: ТТ первыми, штамп одной строкой, выноски, без размерных чисел', async () => {
  const pages = await pdfPages('3/БВС-305Х300.000 - Блок выхода сброса.pdf');
  const lines = pdfTextLines(pages);
  assert.equal(lines[0], 'Технические требования:');
  assert.equal(lines[2], '2 Внутренний радиус гибки 1 мм.');
  const title = lines.find((l) => l.startsWith('Штамп:'))!;
  assert.match(title, /БВС-305Х300\.000 «Блок выхода сброса»/);
  assert.match(title, /материал: Лист 2 ГОСТ 19904-90 \/ Ст3пс ГОСТ 16523-97/);
  assert.match(title, /масса 4,66 кг/);
  const notes = lines.find((l) => l.startsWith('Надписи:'))!;
  assert.match(notes, /Ø10,5 4 отв\./);
  assert.match(notes, /27×45° 6 фасок/);
  assert.ok(!lines.some((l) => /^\d+([.,]\d+)?$/.test(l)), 'нет голых чисел');
  assert.ok(!lines.join('\n').includes('Беляков'), 'фамилии из штампа не нужны');
});

await test('PDF НГЭН.745421.0001: многострочные пункты ТТ склеены, таблица исполнений компактно', async () => {
  const pages = await pdfPages('4/НГЭН.745421.0001.pdf');
  const lines = pdfTextLines(pages);
  assert.equal(lines[0], 'Технические требования:');
  assert.ok(lines.some((l) => l.startsWith('4 Сварные швы по ГОСТ 14771-76.') && l.endsWith('в объеме 100 %.')), 'пункт 4 целиком');
  assert.ok(lines.includes('Таблица: Обозначение | L, мм | Масса, кг'));
  assert.ok(lines.includes('НГЭН.745421.0001 | 2896 | 15,8'));
  assert.ok(lines.includes('-09 | 11348 | 62,0'));
});

await test('PDF рифлёный лист: материал «Лист ромб К-ПУ-3 …»', async () => {
  const pages = await pdfPages('4/НГЭН.А86.11.13.0002 Лист зашивочный.pdf');
  const title = pdfTextLines(pages).find((l) => l.startsWith('Штамп:'))!;
  assert.match(title, /«Лист зашивочный»/);
  assert.match(title, /материал: Лист ромб К-ПУ-3 ГОСТ 8568-77 \/ Ст3 ГОСТ 16523-97/);
});

await test('PDF с заголовком «Технические требования» над пунктами (синтетический лист А3)', () => {
  const t = (str: string, x: number, y: number, h = 5, angle = 0) => ({ str, x, y, w: str.length * h * 0.5, h, angle });
  const page: PdfPageData = {
    index: 0,
    width: 420,
    height: 297,
    paths: [],
    images: 0,
    texts: [
      t('Изм.', 231, 36, 3.5), t('Лист', 238, 36, 3.5), t('№ докум.', 251, 36, 3.5), t('Подп.', 272, 36, 3.5), t('Дата', 286, 36, 3.5),
      t('Разраб.', 231, 31, 3.5), t('Иванов', 248, 31, 3.5), t('Масса', 383, 41, 3.5), t('Масштаб', 399, 41, 3.5), t('2,4', 384, 31), t('1:2', 402, 31),
      t('АБВ.123456.001', 322, 49, 8), t('Кронштейн', 312, 30, 6), t('Лист', 297, 10.8), t('3 ГОСТ 19903-2015', 318, 14.7), t('Ст3сп ГОСТ 14637-89', 316, 6.8),
      t('Технические требования', 280, 120, 5),
      t('1 Покрытие: порошковая окраска RAL 7035,', 231, 112), t('толщина слоя 60-80 мкм.', 231, 106), t('2 Резьба М6 - 4 отв.', 231, 100), t('3 Острые кромки притупить.', 231, 94),
      t('Ø8', 60, 200), t('4 отв.', 60, 192), t('120', 100, 250), t('А-А', 150, 260), t('Ra 6,3', 190, 270),
      t('НЕ ЛИСТ', 12, 150, 3.5, 90), t('Инв. № подл.', 12, 10, 3.5, 90), t('АБВ.123456.001', 80, 287, 7, 180),
    ],
  };
  assert.deepEqual(pdfTextLines([page]), [
    'Технические требования:',
    '1 Покрытие: порошковая окраска RAL 7035, толщина слоя 60-80 мкм.',
    '2 Резьба М6 - 4 отв.',
    '3 Острые кромки притупить.',
    'Штамп: АБВ.123456.001 «Кронштейн»; материал: Лист 3 ГОСТ 19903-2015 / Ст3сп ГОСТ 14637-89; масса 2,4 кг; масштаб 1:2',
    'Надписи: Ø8 4 отв.; НЕ ЛИСТ',
  ]);
});

await test('PDF-счёт как документ: строки таблицы с « | »', async () => {
  const pages = await pdfPages('3/Счет на оплату № 467 от 03 августа 2026 г.pdf');
  const lines = documentLines(pages);
  assert.ok(lines.includes('2 Блок выхода сброса БВС-305Х300.000 | 3 шт | 1 368,00 | 4 104,00'), lines.join('\n'));
});

await test('mergeDrawingTexts: PDF первым, строки DXF без повторов', () => {
  assert.equal(mergeDrawingTexts('A\nB', 'B\nC'), 'A\nB\nТекст DXF: C');
  assert.equal(mergeDrawingTexts(undefined, 'C'), 'C');
  assert.equal(mergeDrawingTexts('A', 'A'), 'A');
});

await test('positionsFromPages: тексты чертежей у позиций, листы без чертежа → документ', async () => {
  const pages = await pdfPages('3/БВк-400х340.00.000 - Блок ввода кабеля.pdf');
  const r = positionsFromPages(pages, 'БВк.pdf', 'pdf:x', { materialId: 'st3', thickness: 2 });
  assert.equal(r.positions.length, 1);
  assert.match(r.positions[0].drawingText!, /^Технические требования:/);
  assert.ok(r.positions[0].drawingText!.length <= AI_LIMITS.drawingTextChars);
  assert.deepEqual(r.documents, []);
  const inv = await pdfPages('2/Счет на оплату № 9885 от 05 октября 2026 г.pdf');
  const r2 = positionsFromPages(inv, 'Счет.pdf', 'pdf:y', { materialId: 'st3', thickness: 2 });
  assert.equal(r2.positions.length, 0);
  assert.equal(r2.documents.length, 1);
  assert.match(r2.documents[0].text, /НГЭН\.745428\.0003-0700 amg2 s3mm 5шт/);
  assert.ok(r2.documents[0].text.length <= AI_LIMITS.documentChars);
  assert.equal(groupDrawings(inv).length, 1);
});

// ---------- контекст и хэш ----------
console.log('Контекст ИИ');

function plate(name: string, extra: Partial<OrderPosition> = {}): OrderPosition {
  return { ...manualPosition({ name, materialId: 'st3', thickness: 2, qty: 3, width: 300, height: 200, holes: 2, holeD: 10, bends: 0 }), ...extra };
}
const orderOf = (positions: OrderPosition[], patch: Partial<Order> = {}): Order => ({ ...emptyOrder(), title: 'Тест', positions, ...patch });

await test('cyrb53 и stableStringify: стабильно и не зависит от порядка ключей', () => {
  assert.equal(cyrb53('abc'), cyrb53('abc'));
  assert.notEqual(cyrb53('abc'), cyrb53('abd'));
  assert.equal(stableStringify({ b: 1, a: [1, { d: 2, c: 3 }], u: undefined }), '{"a":[1,{"c":3,"d":2}],"b":1}');
});

await test('contextHash: не зависит от времени, наценки, доставки, изображений; зависит от количества', () => {
  const ps = [plate('A'), plate('B', { qty: 5 })];
  const o = orderOf(ps);
  const h = contextHash(buildAiContext(o, null, book, settings, { now: new Date('2026-01-01') }));
  assert.equal(h, contextHash(buildAiContext(o, null, book, settings, { now: new Date('2026-06-01') })), 'createdAt');
  assert.equal(h, contextHash(buildAiContext({ ...o, markupPct: 100 }, null, book, settings)), 'наценка');
  assert.equal(h, contextHash(buildAiContext({ ...o, delivery: 3000 }, null, book, settings)), 'доставка');
  assert.equal(h, contextHash(buildAiContext(o, null, book, settings, { images: [{ index: 0, positionId: ps[0].id, caption: 'x' }] })), 'изображения');
  assert.equal(h, contextHash(buildAiContext(o, null, { ...book, updatedAt: '2030-01-01T00:00:00Z' }, settings)), 'время цен');
  assert.notEqual(h, contextHash(buildAiContext(orderOf([ps[0], { ...ps[1], qty: 6 }]), null, book, settings)), 'количество');
  assert.notEqual(h, contextHash(buildAiContext({ ...o, request: 'Прошу счёт: A — 10 шт' }, null, book, settings)), 'заявка');
  assert.match(h, /^[0-9a-z]+$/);
});

await test('buildAiContext: группы со всеми листами, цены позиций, исключённые без цены', () => {
  const ps = [plate('A'), plate('B', { disabled: true }), plate('C', { materialId: 'aisi304', thickness: 1.5 })];
  const o = orderOf(ps);
  const res = computeOrder(ps, book, orderSettings(o, settings));
  const ctx = buildAiContext(o, res, book, settings);
  assert.equal(ctx.version, 1);
  assert.equal(ctx.positions.length, 3);
  assert.equal(ctx.positions[1].disabled, true);
  assert.equal(ctx.positions[1].cost, undefined);
  assert.ok(ctx.positions[0].cost!.priceWithMarkup > ctx.positions[0].cost!.total);
  const g = ctx.groups.find((x) => x.key === 'st3|2')!;
  assert.equal(g.offers.length, res.groups.find((x) => x.key === 'st3|2')!.options.length);
  assert.match(g.mcUrl, /^https:\/\/mc\.ru\/region\/speterburg\/metalloprokat\/stal_listovaya_g_k_st3\/r1\/2$/);
  assert.equal(ctx.materials.length, 11);
  assert.equal(ctx.rates.extraOps.length, settings.extraRates.length);
  assert.equal(ctx.totals.total, Math.round(res.totals.total));
});

await test('buildAiContext: лимит позиций, общий бюджет текстов, размер JSON, повтор текста', () => {
  const long = 'Технические требования:\n' + 'Покрытие порошковое RAL 7035, зачистить кромки. '.repeat(60);
  const ps = Array.from({ length: 160 }, (_, i) => plate(`P${i}`, { drawingText: i % 2 ? long + i : long }));
  const docs = Array.from({ length: 12 }, (_, i) => ({ fileName: `d${i}.txt`, text: 'Заявка: позиция — 5 шт. '.repeat(400) }));
  const o = orderOf(ps, { documents: docs, request: 'Прошу счёт. '.repeat(1000) });
  const ctx = buildAiContext(o, null, book, settings);
  assert.equal(ctx.positions.length, AI_LIMITS.positions);
  assert.match(ctx.positions.at(-1)!.warnings.at(-1)!, /первые 150/);
  assert.ok(ctx.documents.length <= AI_LIMITS.documents);
  const total = ctx.order.request.length + ctx.documents.reduce((a, d) => a + d.text.length, 0) + ctx.positions.reduce((a, p) => a + (p.drawingText?.length ?? 0), 0);
  assert.ok(total <= AI_LIMITS.totalTextChars, `текстов ${total}`);
  assert.ok(ctx.order.request.length <= AI_LIMITS.requestChars);
  assert.ok(ctx.positions.every((p) => (p.drawingText?.length ?? 0) <= AI_LIMITS.drawingTextChars));
  assert.match(ctx.positions[2].drawingText!, /тот же, что у позиции «P0»/);
  assert.ok(new TextEncoder().encode(JSON.stringify(ctx)).length <= AI_LIMITS.contextBytes);
  assert.equal(ctx.totals.pieces, 160 * 3, 'итоги по всем позициям');
});

await test('shareBudget: короткие тексты целиком, остаток поровну', () => {
  assert.deepEqual(shareBudget([10, 1000, 1000], 610), [10, 300, 300]);
  assert.deepEqual(shareBudget([10, 20], 1000), [10, 20]);
});

// ---------- предложения ИИ ----------
console.log('Предложения ИИ');

const sug = (id: string, kind: AiSuggestion['kind'], v: Partial<AiSuggestion> = {}): AiSuggestion => ({ id, kind, reason: 'тест', ...v });
function analysisFor(reviews: AiAnalysis['positions']): AiAnalysis {
  return { summary: 'ok', confidence: 'medium', positions: reviews, questions: [], risks: [], recommendations: [], model: 'test', createdAt: '2026-10-16T00:00:00Z', durationMs: 1000 };
}

const pa = plate('A', { id: 'a', guessed: { material: true, thickness: false, qty: true } });
const pb = plate('B', { id: 'b', bends: 2, detectedBends: 0 });
const pc = plate('C', { id: 'c', disabled: true, guessed: { material: true, thickness: true, qty: true } });
const pd = plate('D', { id: 'd', bends: 4, detectedBends: 4 });
const pe = plate('E', { id: 'e', bends: 0, detectedBends: 0 });
const positions = [pa, pb, pc, pd, pe];
const analysis = analysisFor([
  {
    id: 'a',
    status: 'check',
    comment: 'x',
    operations: [],
    suggestions: [sug('a#1', 'material', { materialId: '08ps' }), sug('a#2', 'thickness', { value: 3 }), sug('a#3', 'qty', { value: 10 }), sug('a#4', 'extra', { label: 'Покраска', perPiece: 150 }), sug('a#5', 'qty', { value: 12 })],
  },
  { id: 'b', status: 'ok', comment: '', operations: [], suggestions: [sug('b#1', 'bends', { value: 4 })] },
  { id: 'c', status: 'problem', comment: '', operations: [], suggestions: [sug('c#1', 'qty', { value: 7 }), sug('c#2', 'extra', { label: 'Резьба', perPiece: 70 })] },
  { id: 'd', status: 'check', comment: '', operations: [], suggestions: [sug('d#1', 'bends', { value: 6 })] },
  { id: 'e', status: 'check', comment: '', operations: [], suggestions: [sug('e#1', 'bends', { value: 2 }), sug('e#2', 'material', { materialId: 'nope' })] },
]);

await test('defaultAccepted: доп. операции — да; материал/толщина/кол-во — только угаданные; гибы — если не найдены; пишет только true', () => {
  // нет ключа — предложение ждёт решения: толщина из файла (a#2), второе предложение поля (a#5), гибы введены
  // вручную (b#1), позиция исключена (c#*), гибы найдены в файле (d#1), неизвестный материал (e#2)
  assert.deepEqual(defaultAccepted(analysis, positions), {
    'a#1': true, // материал угадан
    'a#3': true, // количество угадано
    'a#4': true, // доп. операция
    'e#1': true, // гибов нет
  });
  assert.ok(Object.values(defaultAccepted(analysis, positions)).every((v) => v === true));
});

const state: AiState = { analysis, accepted: defaultAccepted(analysis, positions), contextHash: 'h' };

await test('effectivePositions: наложение, доп. операции с aiId, исключённые не трогаются', () => {
  const eff = effectivePositions(positions, state);
  assert.notEqual(eff, positions);
  assert.equal(eff[0].materialId, '08ps');
  assert.equal(eff[0].qty, 10);
  assert.equal(eff[0].thickness, 2);
  assert.deepEqual(eff[0].guessed, { material: false, thickness: false, qty: false });
  assert.deepEqual(eff[0].extras, [{ label: 'Покраска', perPiece: 150, aiId: 'a#4' }]);
  assert.equal(eff[1], positions[1], 'без изменений — тот же объект');
  assert.equal(eff[2], positions[2], 'исключённая');
  assert.equal(eff[4].bends, 2);
  assert.equal(positions[0].materialId, 'st3', 'исходные позиции не меняются');
  assert.equal(positions[0].extras.length, 0);
});

await test('effectivePositions: ничего не применено — тот же массив', () => {
  assert.equal(effectivePositions(positions, undefined), positions);
  const none: AiState = { ...state, accepted: {} };
  assert.equal(effectivePositions(positions, none), positions);
});

await test('changesFor: поле, было, стало, предложение', () => {
  const ch = changesFor(pa, state);
  assert.deepEqual(
    ch.map((c) => [c.field, c.from, c.to, c.suggestion.id]),
    [
      ['materialId', 'st3', '08ps', 'a#1'],
      ['qty', 3, 10, 'a#3'],
      ['extras', null, { label: 'Покраска', perPiece: 150 }, 'a#4'],
    ],
  );
  assert.deepEqual(changesFor(pc, { ...state, accepted: { 'c#1': true } }), [], 'исключённая позиция');
});

await test('toggleSuggestion: одно значение на поле', () => {
  const s2 = toggleSuggestion(state, 'a#5', true);
  assert.equal(s2.accepted['a#5'], true);
  assert.equal(s2.accepted['a#3'], false);
  assert.equal(effectivePositions(positions, s2)[0].qty, 12);
});

await test('onManualEdit: ручная правка снимает предложение поля; удалённая доп. операция ИИ — тоже', () => {
  const s1 = onManualEdit(state, 'a', { qty: 4 })!;
  assert.equal(s1.accepted['a#3'], false);
  assert.equal(s1.accepted['a#1'], true);
  const s2 = onManualEdit(state, 'a', { extras: [] })!;
  assert.equal(s2.accepted['a#4'], false);
  const s3 = onManualEdit(state, 'a', { extras: [{ label: 'Покраска', perPiece: 150, aiId: 'a#4' }, { label: 'Своя', perPiece: 10 }] })!;
  assert.equal(s3, state, 'строка ИИ не тронута — состояние то же');
  const s4 = onManualEdit(state, 'a', { extras: [{ label: 'Покраска', perPiece: 200, aiId: 'a#4' }] })!;
  assert.equal(s4.accepted['a#4'], false, 'изменённая цена — уже ручная строка');
  assert.equal(onManualEdit(state, 'zzz', { qty: 1 }), state);
  assert.equal(onManualEdit(undefined, 'a', { qty: 1 }), undefined);
});

await test('manualEdit: что писать в исходную позицию', () => {
  const eff = effectivePositions(positions, state)[0];
  const r1 = manualEdit(state, 'a', { extras: [...eff.extras, { label: 'Своя', perPiece: 10 }] });
  assert.deepEqual(r1.patch.extras, [{ label: 'Своя', perPiece: 10 }], 'строку ИИ добавит наложение');
  const r2 = manualEdit(state, 'a', { extras: [{ ...eff.extras[0], perPiece: 180 }] });
  assert.deepEqual(r2.patch.extras, [{ label: 'Покраска', perPiece: 180 }]);
  assert.equal(r2.ai!.accepted['a#4'], false);
  const base = { ...pa, ...r2.patch };
  assert.deepEqual(effectivePositions([base], r2.ai)[0].extras, [{ label: 'Покраска', perPiece: 180 }], 'без дубля');
});

await test('reviewFor / suggestionsFor', () => {
  assert.equal(reviewFor(state, 'a')!.status, 'check');
  assert.equal(suggestionsFor(state, 'a').length, 5);
  assert.deepEqual(suggestionsFor(state, 'zzz'), []);
  assert.equal(reviewFor(undefined, 'a'), undefined);
});

await test('решения: применено / отклонено / ждёт решения; сброс, применено всего, отмена всех', () => {
  assert.equal(decisionOf(state, 'a#1'), 'applied');
  assert.equal(decisionOf(state, 'a#2'), 'pending');
  assert.equal(decisionOf(toggleSuggestion(state, 'a#2', false), 'a#2'), 'rejected');
  assert.equal(decisionOf(undefined, 'a#1'), 'pending');
  const r = resetSuggestion(state, 'a#1');
  assert.equal(decisionOf(r, 'a#1'), 'pending');
  assert.equal(resetSuggestion(r, 'a#1'), r, 'нет ключа — то же состояние');
  assert.equal(appliedCount(state, positions), 4);
  assert.equal(appliedCount({ ...state, accepted: { ...state.accepted, 'c#1': true } }, positions), 4, 'исключённая позиция не считается');
  const all = revertAll(state);
  assert.ok(Object.values(all.accepted).every((v) => v === false));
  assert.deepEqual(Object.keys(all.accepted).sort(), Object.keys(state.accepted).sort(), 'ждущие решения остаются без ключа');
  assert.equal(revertAll(all), all);
  assert.equal(effectivePositions(positions, all), positions);
});

await test('pendingOffers: применимые без решения, позиция в расчёте; исключённая по ИИ — без предложений', () => {
  assert.deepEqual(
    pendingOffers(state, positions).map((x) => x.s.id),
    ['a#2', 'a#5', 'b#1', 'd#1'],
  );
  const dis: AiState = {
    analysis: analysisFor([{ id: 'b', status: 'check', comment: '', operations: [], suggestions: [sug('b#1', 'disable'), sug('b#2', 'qty', { value: 9 })] }]),
    accepted: {},
    contextHash: 'h',
  };
  assert.deepEqual(pendingOffers(dis, positions).map((x) => x.s.id), ['b#1', 'b#2']);
  const on = toggleSuggestion(dis, 'b#1', true);
  assert.ok(aiDisabled(on, 'b'));
  assert.deepEqual(pendingOffers(on, positions), [], 'исключена по ИИ — остальное не предлагается');
  assert.equal(effectivePositions(positions, on)[1].disabled, true);
  assert.equal(positions[1].disabled, undefined, 'базовая позиция в расчёте');
  assert.deepEqual(defaultAccepted(dis.analysis, positions), {}, 'исключение никогда не применяется само');
});

await test('onManualEdit: правка поля отклоняет ждущее решения предложение этого поля (чип исчезает)', () => {
  const s1 = onManualEdit(state, 'a', { thickness: 2.5 })!;
  assert.equal(s1.accepted['a#2'], false, 'толщина ждала решения → отклонено');
  assert.equal(s1.accepted['a#1'], true, 'другие поля не тронуты');
  assert.equal('a#5' in s1.accepted, false, 'второе предложение количества ждёт решения');
  const s2 = onManualEdit(state, 'a', { qty: 4 })!;
  assert.equal(s2.accepted['a#3'], false, 'применённое → снято');
  assert.equal(s2.accepted['a#5'], false, 'ждущее решения → отклонено');
  const s3 = onManualEdit(state, 'b', { materialId: 'aisi304' })!;
  assert.equal(s3, state, 'по полю нет предложений — то же состояние');
  const dis: AiState = {
    analysis: analysisFor([{ id: 'b', status: 'check', comment: '', operations: [], suggestions: [sug('b#1', 'disable')] }]),
    accepted: { 'b#1': true },
    contextHash: 'h',
  };
  assert.equal(onManualEdit(dis, 'b', { disabled: false })!.accepted['b#1'], false, '«Включить в расчёт» снимает исключение ИИ');
  assert.equal(onManualEdit({ ...dis, accepted: {} }, 'b', { disabled: false })!.accepted['b#1'], false, 'и отклоняет ждущее');
});

await test('aiStateFrom: перенос решений при повторном анализе (позиция + вид + значение)', () => {
  const prev: AiState = { analysis, accepted: { ...defaultAccepted(analysis, positions), 'a#3': false, 'a#2': false, 'd#1': true }, contextHash: 'h0' };
  // новый анализ: ид перенумерованы, часть значений другая
  const next = analysisFor([
    {
      id: 'a',
      status: 'check',
      comment: 'x',
      operations: [],
      suggestions: [
        sug('a#1', 'qty', { value: 10 }), // было a#3 — отклонено
        sug('a#2', 'extra', { label: '  покраска ', perPiece: 170 }), // было a#4 (Покраска) — применено, цена другая
        sug('a#3', 'material', { materialId: '08ps' }), // было a#1 — применено
        sug('a#4', 'thickness', { value: 4 }), // новое значение: прежнее решение (3 мм отклонено) не переносится
        sug('a#5', 'extra', { label: 'Резьба М6', perPiece: 40 }), // новая доп. операция — по умолчанию да
      ],
    },
    { id: 'd', status: 'check', comment: '', operations: [], suggestions: [sug('d#1', 'bends', { value: 6 })] }, // применено вручную ранее
    { id: 'e', status: 'check', comment: '', operations: [], suggestions: [sug('e#1', 'bends', { value: 3 })] }, // другое значение
  ]);
  const st = aiStateFrom(next, positions, 'h1', { prev });
  assert.equal(st.contextHash, 'h1');
  assert.deepEqual(st.accepted, {
    'a#1': false, // отклонённое остаётся отклонённым
    'a#2': true,
    'a#3': true,
    'a#5': true,
    'd#1': true,
    'e#1': true, // новое значение, гибов нет — по умолчанию
  });
  const review = aiStateFrom(next, positions, 'h1', { prev, defaults: false });
  assert.deepEqual(review.accepted, { 'a#1': false, 'a#2': true, 'a#3': true, 'd#1': true }, '«Посмотреть»: только перенесённое');
  assert.deepEqual(aiStateFrom(next, positions, 'h1').accepted, defaultAccepted(next, positions), 'без prev — политика по умолчанию');
});

await test('aiStateFrom: перенесённое «применено» поля блокирует автоприменение другого значения того же поля', () => {
  const p1 = plate('Q', { id: 'q', guessed: { material: false, thickness: false, qty: true } });
  const first = analysisFor([{ id: 'q', status: 'check', comment: '', operations: [], suggestions: [sug('q#1', 'qty', { value: 5 }), sug('q#2', 'qty', { value: 7 })] }]);
  const prev = toggleSuggestion(aiStateFrom(first, [p1], 'h'), 'q#2', true); // пользователь выбрал 7 шт
  assert.deepEqual(prev.accepted, { 'q#1': false, 'q#2': true });
  const again = analysisFor([{ id: 'q', status: 'check', comment: '', operations: [], suggestions: [sug('q#1', 'qty', { value: 6 }), sug('q#2', 'qty', { value: 7 })] }]);
  const st = aiStateFrom(again, [p1], 'h2', { prev });
  assert.deepEqual(st.accepted, { 'q#2': true }, '7 шт перенесено; 6 шт ждёт решения, а не применяется по умолчанию');
  assert.equal(effectivePositions([p1], st)[0].qty, 7);
  // исключение позиции переносится по позиции и виду
  const d1 = analysisFor([{ id: 'q', status: 'check', comment: '', operations: [], suggestions: [sug('q#1', 'disable', { reason: 'дубль' })] }]);
  const rejected = toggleSuggestion(aiStateFrom(d1, [p1], 'h'), 'q#1', false);
  const d2 = analysisFor([{ id: 'q', status: 'check', comment: '', operations: [], suggestions: [sug('q#3', 'disable', { reason: 'другая причина' })] }]);
  assert.deepEqual(aiStateFrom(d2, [p1], 'h3', { prev: rejected }).accepted, { 'q#3': false }, 'отклонённое исключение не предлагается снова');
});

await test('contextHash: не зависит от названия заказа, «угадано» и примечаний позиций', () => {
  const ps = [plate('A', { guessed: { material: true, thickness: true, qty: true } }), plate('B', { qty: 5 })];
  const o = orderOf(ps);
  const h = contextHash(buildAiContext(o, null, book, settings));
  assert.equal(h, contextHash(buildAiContext({ ...o, title: 'Другое название' }, null, book, settings)), 'название');
  const ack = [{ ...ps[0], guessed: { material: false, thickness: false, qty: false } }, ps[1]];
  assert.equal(h, contextHash(buildAiContext(orderOf(ack), null, book, settings)), '«Верно» по угаданному значению');
  assert.equal(h, contextHash(buildAiContext(orderOf([{ ...ps[0], note: 'из двух частей' }, ps[1]]), null, book, settings)), 'примечание');
  assert.notEqual(h, contextHash(buildAiContext(orderOf([{ ...ps[0], thickness: 3 }, ps[1]]), null, book, settings)), 'толщина');
  const ctx = buildAiContext(orderOf(ps, { title: 'Название' }), null, book, settings);
  assert.equal(ctx.order.title, 'Название', 'в контексте модели название остаётся');
  assert.deepEqual(ctx.positions[0].guessed, { material: true, thickness: true, qty: true }, 'и отметки «угадано» тоже');
});

// ---------- замечания и цитаты ----------
console.log('Замечания и цитаты');

await test('aiTitle: первое предложение — в заголовок, остальное — в пояснение, без повторов', () => {
  assert.deepEqual(splitSentence('В заявке 5 шт. по чертежу 1 шт. Проверьте.'), { head: 'В заявке 5 шт. по чертежу 1 шт', rest: 'Проверьте.' });
  assert.deepEqual(aiTitle('A', 'В заявке 5 шт, в расчёте 1 шт. Проверьте по письму.', 'x'), {
    title: 'A — В заявке 5 шт, в расчёте 1 шт',
    text: 'Проверьте по письму.',
  });
  assert.deepEqual(aiTitle('A', 'Толщина 1.5 мм по штампу «s1,5. Ст3». Остальное в порядке.', 'x'), {
    title: 'A — Толщина 1.5 мм по штампу «s1,5. Ст3»',
    text: 'Остальное в порядке.',
  });
  assert.deepEqual(aiTitle('A', '  ', 'ИИ просит проверить'), { title: 'A — ИИ просит проверить' });
  // длинное первое предложение: часть до «;» — заголовок, хвост — пояснение
  const long =
    'По штампу материал 08пс х/к (ГОСТ 19904), а в расчёте Ст3 г/к; деталь не помещается в лист 1000×2000 и режется из 2 частей, ' +
    'чертёж это допускает. Стык под сварку — вопрос клиенту.';
  assert.deepEqual(aiTitle('A', long, 'x'), {
    title: 'A — По штампу материал 08пс х/к (ГОСТ 19904), а в расчёте Ст3 г/к',
    text: 'Деталь не помещается в лист 1000×2000 и режется из 2 частей, чертёж это допускает. Стык под сварку — вопрос клиенту.',
  });
  // часть до «;» короче 20 символов — не делим; до 160 символов — заголовок целиком (короткий хвост не отрываем)
  const mid = 'В заявке 5 шт; на чертеже есть неуказанные радиусы гибов R=2 мм, а гибы в расчёте 0 — гибка не посчитана, проверьте по чертежу';
  assert.deepEqual(aiTitle('A', mid, 'x'), { title: `A — ${mid}` });
  // без «;» и длиннее 160 — по слову с «…», пояснение продолжает заголовок
  const flat =
    'Материал рифлёный по штампу (К-ПУ-3), количество 5 шт совпадает с заявкой, чертёж допускает изготовление из 4 частей — ' +
    'в расчёте деталь целиком на лист 1500×6000, стыки варит клиент сам.';
  const t = aiTitle('A', flat, 'x');
  assert.ok(t.title.endsWith('…') && t.title.length <= 'A — '.length + 111, t.title);
  assert.ok(t.text?.startsWith('…') && t.text.endsWith('сам.'), String(t.text));
  assert.ok(!t.text?.includes('Материал рифлёный'), 'пояснение не повторяет заголовок');
  // не режет внутри цитаты
  const q = aiTitle('A', `Длинная цитата ${'а'.repeat(60)} «${'б '.repeat(40)}конец» и ещё немного текста для длины без точки с запятой`, 'x');
  assert.equal((q.title.match(/«/g) ?? []).length, (q.title.match(/»/g) ?? []).length, q.title);
});

await test('textHints: ключевые слова по строкам; общие примечания и масштаб «М1:2» — не подсказки', () => {
  const text = [
    '1. Покрытие: порошковая окраска RAL 7035',
    '2. Общие допуски по ГОСТ 30893.1 — сварка не требуется',
    'Масштаб М1:2',
    'Резьба М8 — 4 отв.',
    'Сварные швы зачистить',
  ].join('\n');
  const hints = textHints(text);
  assert.deepEqual(
    hints.map((h) => h.key),
    ['paint', 'thread', 'weld'],
  );
  assert.equal(hints[0].fragment, '1. Покрытие: порошковая окраска RAL 7035');
  // одна строка — одна подсказка (фрагмент тот же), масштаб — не резьба
  assert.deepEqual(
    textHints('Масштаб М1:1\nГайка М6 запрессовать').map((h) => h.key),
    ['thread'],
  );
  const long = textHints(`${'х'.repeat(80)} цинковое покрытие ${'у'.repeat(80)}`)[0].fragment;
  assert.ok(long.startsWith('…') && long.endsWith('…') && long.length < 110, long);
});

await test('Цитаты: нормализация; где найдено (свой чертёж → заявка → документ → другой чертёж); выдуманная — нет', () => {
  assert.equal(normalize('  «Ст3 ГОСТ 19904–90»   Ёлка '), 'ст3 гост 19904-90 елка');
  assert.equal(normalize('CT3 PEM'), normalize('СТ3 РЕМ'), 'латиница-двойники');
  assert.deepEqual(extractQuotes('«s2» и «Сталь 3» и «вложенная «цитата» тут»'), ['Сталь 3', 'вложенная «цитата» тут']);
  const src = {
    drawings: [
      { positionId: 'a', name: 'А-1', text: 'Технические требования:\n1. Сталь 3 ГОСТ 19904' },
      { positionId: 'b', name: 'Б-2', text: 'Покрытие порошковое RAL 9016' },
    ],
    request: 'Прошу счёт: A — 5 шт',
    documents: [{ fileName: 'спец.txt', text: 'Резка лазером' }],
  };
  const ev = findEvidence(
    'По штампу «Сталь 3 ГОСТ 19904», в заявке «A - 5 шт», в спецификации «резка  лазером», у Б «покрытие порошковое RAL 9016», «выдумано целиком» и «Сталь… 19904»',
    src,
    'a',
  );
  assert.deepEqual(
    ev.map((e) => [e.found, e.where ?? null]),
    [
      ['drawing', null],
      ['request', null],
      ['document', 'спец.txt'],
      ['drawing', 'Б-2'],
      [null, null],
      ['drawing', null],
    ],
  );
});

await test('buildAttention: без ИИ — угаданное, подсказки, «Количество не сверено»; исключённые — без замечаний; «Верно» закрывает', () => {
  const ra = plate('A', { id: 'ra', guessed: { material: false, thickness: false, qty: true }, drawingText: 'Покрытие порошковое RAL 9016' });
  const rd = plate('D', { id: 'rd', disabled: true, guessed: { material: true, thickness: true, qty: true }, drawingText: 'Сварка' });
  const att = (o: Order) => {
    const positions = effectivePositions(o.positions, o.ai);
    const res = computeOrder(positions, book, orderSettings(o, settings));
    return buildAttention({ order: o, positions, res, baseRes: res, book, settings, live: false, priceIssue: null, aiContext: null, outdated: false });
  };
  const a1 = att(orderOf([ra, rd]));
  const kinds = a1.items.filter((x) => x.severity !== 'info').map((x) => `${x.kind}:${x.id}`);
  assert.deepEqual(kinds, ['guessed:guess:ra:qty:3', 'textHint:hint:ra:paint', 'qtyUnverified:qtyunverified:1']);
  assert.equal(a1.items.find((x) => x.kind === 'guessed')?.title, 'A — количество не найдено в файлах: стоит 3 шт');
  assert.deepEqual(a1.items.find((x) => x.kind === 'qtyUnverified')?.actions.map((x) => x.kind), ['runAi', 'ack']);
  assert.ok(!a1.items.some((x) => x.positionId === 'rd'), 'исключённая вручную — без замечаний');
  assert.deepEqual([a1.counts.check, a1.counts.total, a1.counts.resolved, a1.done], [3, 3, 0, false]);
  const a2 = att(orderOf([ra, rd], { checks: { 'qtyunverified:1': '2026-10-17T00:00:00Z', 'hint:ra:paint': '2026-10-17T00:00:00Z' } }));
  assert.deepEqual([a2.counts.check, a2.counts.total, a2.counts.resolved], [1, 3, 2]);
  assert.equal(a2.items.find((x) => x.kind === 'textHint')?.closedBy, 'check');
  assert.deepEqual(a2.open.map((x) => x.kind), ['guessed']);
});

await test('buildAttention: с ИИ — решённая проблема закрыта, предложения, объединение «— 2 поз.», исключение ИИ', () => {
  const ra = plate('A', { id: 'ra', guessed: { material: false, thickness: false, qty: true }, drawingText: 'Покрытие порошковое RAL 9016' });
  const rb = plate('B', { id: 'rb', qty: 1 });
  const rc = plate('C', { id: 'rc', qty: 1 });
  const an = analysisFor([
    { id: 'ra', status: 'problem', comment: 'В заявке 5 шт. Проверьте.', operations: [], suggestions: [sug('ra#1', 'qty', { value: 5 })] },
    { id: 'rb', status: 'ok', comment: '', operations: [], suggestions: [sug('rb#1', 'qty', { value: 5 }), sug('rb#2', 'disable', { reason: 'нет в заявке' })] },
    { id: 'rc', status: 'ok', comment: '', operations: [], suggestions: [sug('rc#1', 'qty', { value: 5 })] },
  ]);
  const ps = [ra, rb, rc];
  const att = (ai: AiState) => {
    const o = orderOf(ps, { ai });
    const eff = effectivePositions(ps, ai);
    const res = computeOrder(eff, book, orderSettings(o, settings));
    return buildAttention({ order: o, positions: eff, res, baseRes: res, book, settings, live: false, priceIssue: null, aiContext: null, outdated: false });
  };
  const ai = aiStateFrom(an, ps, 'h');
  assert.deepEqual(ai.accepted, { 'ra#1': true }, 'угаданное количество применено само');
  const a = att(ai);
  const prob = a.items.find((x) => x.kind === 'aiProblem')!;
  assert.deepEqual([prob.title, prob.text, prob.closed, prob.closedBy], ['A — В заявке 5 шт', 'Проверьте.', true, 'decision']);
  assert.ok(!a.items.some((x) => x.kind === 'guessed'), 'поле, изменённое ИИ, уже не «не найдено»');
  assert.ok(!a.items.some((x) => x.kind === 'textHint' || x.kind === 'qtyUnverified'), 'подсказки — только без ИИ');
  assert.deepEqual(
    a.items.filter((x) => x.kind === 'aiOffer').map((x) => x.title),
    ['B — Количество: 1 шт → 5 шт?', 'B — исключить из расчёта?', 'C — Количество: 1 шт → 5 шт?'],
  );
  assert.deepEqual(
    a.items.find((x) => x.id === 'offer:rb#2')?.actions.map((x) => (x.kind === 'accept' ? x.label : x.kind)),
    ['Исключить', 'reject'],
  );
  const auto = a.items.find((x) => x.kind === 'aiAuto')!;
  assert.equal(auto.title, 'A — Количество: 3 шт → 5 шт (ИИ)');
  assert.deepEqual(auto.actions, [{ kind: 'revert', suggestionIds: ['ra#1'], label: 'Вернуть 3 шт' }]);
  assert.deepEqual(
    a.offerGroups.map((g) => [g.title, g.suggestionIds]),
    [['Количество 1 → 5 шт — 2 поз.', ['rb#1', 'rc#1']]],
  );
  assert.deepEqual([a.counts.problem, a.counts.check, a.counts.total, a.counts.resolved], [0, 3, 4, 1]);
  // исключение принято: у B — только «исключена из расчёта (ИИ)» с «Вернуть в расчёт», группа распалась
  const b = att(toggleSuggestion(ai, 'rb#2', true));
  assert.deepEqual(
    b.items.filter((x) => x.positionId === 'rb').map((x) => [x.kind, x.title]),
    [['aiAuto', 'B — исключена из расчёта (ИИ)']],
  );
  assert.deepEqual(b.items.find((x) => x.id === 'auto:rb#2')?.actions, [{ kind: 'revert', suggestionIds: ['rb#2'], label: 'Вернуть в расчёт' }]);
  assert.deepEqual(b.offerGroups, []);
});

// ---------- цены ----------
console.log('Цены mc.ru');

const h = (n: number) => new Date(Date.now() - n * 3_600_000).toISOString();
const pbook: PriceBook = {
  updatedAt: h(1),
  region: 'Санкт-Петербург',
  materials: {
    st3: [
      { t: 2, w: 1250, l: 2500, pricePerKg: 60, name: 'a', mark: 'Ст3', fetchedAt: h(30) },
      { t: 2, w: 1500, l: 3000, pricePerKg: 61, name: 'b', mark: 'Ст3', fetchedAt: h(2) },
      { t: 3, w: 1500, l: 3000, pricePerKg: 62, name: 'c', mark: 'Ст3', fetchedAt: h(40) },
      { t: 4, w: 1500, l: 3000, pricePerKg: 63, name: 'd', mark: 'Ст3' },
    ],
  },
};

await test('pairAge: самая свежая запись пары; без отметки или без цен — Infinity', () => {
  assert.ok(Math.abs(pairAge(pbook, 'st3', 2) - 2) < 0.01);
  assert.ok(Math.abs(pairAge(pbook, 'st3', 3) - 40) < 0.01);
  assert.equal(pairAge(pbook, 'st3', 4), Infinity);
  assert.equal(pairAge(pbook, 'st3', 5), Infinity);
  assert.equal(pairAge(pbook, 'amg2', 2), Infinity);
});

await test('stalePairs: старше срока и неизвестные, без повторов и неизвестных материалов', () => {
  assert.deepEqual(
    stalePairs(pbook, [['st3', 2], ['st3', 3], ['st3', 3], ['st3', 4], ['nope', 2], ['st3', 0]], 24),
    [
      ['st3', 3],
      ['st3', 4],
    ],
  );
  assert.deepEqual(stalePairs(pbook, [['st3', 3]], 48), []);
});

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
const realFetch = globalThis.fetch;
function mockFetch(handler: Handler) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method ?? 'GET', body: init.body });
    return handler(url, init);
  }) as typeof fetch;
  return calls;
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

await test('ensurePrices: статическая версия — пропуск с причиной, без запросов', async () => {
  resetPriceAttempts();
  const calls = mockFetch(() => json(500, {}));
  const r = await ensurePrices({ book: pbook, pairs: [['st3', 3]], maxAgeHours: 24, live: false });
  assert.equal(r.skipped, true);
  assert.match(r.reason!, /Статическая версия/);
  assert.equal(calls.length, 0);
  assert.equal(r.book, pbook);
});

await test('ensurePrices: обновляет только устаревшие пары; 409 — пропуск; сеть — пропуск', async () => {
  resetPriceAttempts();
  let calls = mockFetch((_u, init) => {
    const pairs = JSON.parse(String(init.body)).pairs as [string, number][];
    const fresh = { ...pbook, materials: { st3: pbook.materials.st3.map((i) => (pairs.some(([, t]) => t === i.t) ? { ...i, pricePerKg: i.pricePerKg + 1, fetchedAt: new Date().toISOString() } : i)) } };
    return json(200, { book: fresh, errors: [] });
  });
  const r = await ensurePrices({ book: pbook, pairs: [['st3', 2], ['st3', 3], ['st3', 4]], maxAgeHours: 24, live: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(String(calls[0].body)).pairs, [['st3', 3], ['st3', 4]]);
  assert.equal(r.refreshed, 2);
  assert.equal(r.skipped, false);
  assert.equal(pairAge(r.book, 'st3', 3) < 1, true);
  // те же пары в этой вкладке уже пробовали — повторно не запрашиваем
  const again = await ensurePrices({ book: pbook, pairs: [['st3', 3]], maxAgeHours: 24, live: true });
  assert.equal(calls.length, 1);
  assert.equal(again.skipped, false);

  resetPriceAttempts();
  calls = mockFetch(() => json(409, { error: 'Обновление уже идёт' }));
  const busy = await ensurePrices({ book: pbook, pairs: [['st3', 3]], maxAgeHours: 24, live: true });
  assert.equal(busy.skipped, true);
  assert.match(busy.reason!, /уже обновляются/);
  assert.equal(busy.book, pbook);

  resetPriceAttempts();
  mockFetch(() => {
    throw new TypeError('fetch failed');
  });
  const net = await ensurePrices({ book: pbook, pairs: [['st3', 3]], maxAgeHours: 24, live: true });
  assert.equal(net.skipped, true);
  assert.match(net.reason!, /Сервер цен недоступен/);

  resetPriceAttempts();
  mockFetch(() => json(200, { book: pbook, errors: ['Ст3 3 мм: mc.ru включил проверку «я не робот» из-за частых запросов', 'Остановлено на 1 из 1'] }));
  const bot = await ensurePrices({ book: pbook, pairs: [['st3', 3]], maxAgeHours: 24, live: true });
  assert.equal(bot.skipped, true);
  assert.match(bot.reason!, /не робот/);
  globalThis.fetch = realFetch;
});

// ---------- API задач ИИ ----------
console.log('API ИИ');

const smallCtx = buildAiContext(orderOf([plate('A', { id: 'a' })]), null, book, settings);

await test('aiStatus: нет сервера или не JSON — не настроен', async () => {
  mockFetch(() => new Response('<html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
  assert.deepEqual(await aiStatus(), { configured: false, model: null, vision: false });
  mockFetch(() => {
    throw new TypeError('fetch failed');
  });
  assert.deepEqual(await aiStatus(), { configured: false, model: null, vision: false });
  mockFetch(() => json(200, { configured: true, model: 'm', vision: true }));
  assert.deepEqual(await aiStatus(), { configured: true, model: 'm', vision: true });
  globalThis.fetch = realFetch;
});

await test('analyzeOrder: POST → PUT изображений по порядку → опрос до done', async () => {
  const ctx = { ...smallCtx, images: [{ index: 0, positionId: 'a', caption: 'A, стр. 1' }, { index: 1, positionId: 'a', caption: 'A, стр. 2' }] };
  let polls = 0;
  const calls = mockFetch((url, init) => {
    if (url === '/api/ai/jobs' && init.method === 'POST') return json(201, { jobId: 'j1' });
    if (url.startsWith('/api/ai/jobs/j1/images/')) return new Response(null, { status: 204 });
    if (url === '/api/ai/jobs/j1') {
      polls++;
      if (polls === 1) return json(200, { status: 'queued', position: 1 });
      if (polls === 2) return json(200, { status: 'running', elapsedMs: 1500, model: 'm' });
      return json(200, { status: 'done', analysis });
    }
    return json(404, { error: 'нет' });
  });
  const states: string[] = [];
  const r = await analyzeOrder(ctx, [new Blob([new Uint8Array(10)]), new Blob([new Uint8Array(20)])], { pollMs: 5, onState: (s) => states.push(s.status) });
  assert.equal(r.model, 'test');
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), ['POST /api/ai/jobs', 'PUT /api/ai/jobs/j1/images/0', 'PUT /api/ai/jobs/j1/images/1', 'GET /api/ai/jobs/j1', 'GET /api/ai/jobs/j1', 'GET /api/ai/jobs/j1']);
  assert.deepEqual(states, ['waiting', 'waiting', 'queued', 'running', 'done']);
  assert.ok(JSON.parse(String(calls[0].body)).context.version === 1);
  // модель без зрения: сервер ответил imagesExpected 0 — изображения не отправляются
  const calls2 = mockFetch((url, init) => (init.method === 'POST' ? json(201, { jobId: 'j9', imagesExpected: 0 }) : json(200, { status: 'done', analysis })));
  await analyzeOrder(ctx, [new Blob([new Uint8Array(10)]), new Blob([new Uint8Array(20)])], { pollMs: 5 });
  assert.deepEqual(calls2.map((c) => c.method), ['POST', 'GET']);
  globalThis.fetch = realFetch;
});

await test('analyzeOrder: 429/413/503 и ошибка задачи — AiError с русским текстом', async () => {
  for (const [status, code] of [
    [429, 'busy'],
    [413, 'too_large'],
    [503, 'unavailable'],
  ] as const) {
    mockFetch(() => json(status, {}));
    await assert.rejects(analyzeOrder(smallCtx, [], { pollMs: 5 }), (e: unknown) => e instanceof AiError && e.code === code && /[а-я]/.test(e.message));
  }
  mockFetch((_u, init) => (init.method === 'POST' ? json(201, { jobId: 'j2' }) : json(200, { status: 'error', error: 'Модель вернула битый JSON' })));
  await assert.rejects(analyzeOrder(smallCtx, [], { pollMs: 5 }), (e: unknown) => e instanceof AiError && e.code === 'failed' && e.message === 'Модель вернула битый JSON');
  mockFetch(() => {
    throw new TypeError('fetch failed');
  });
  await assert.rejects(analyzeOrder(smallCtx, [], { pollMs: 5 }), (e: unknown) => e instanceof AiError && e.code === 'network');
  globalThis.fetch = realFetch;
});

await test('analyzeOrder: отмена — DELETE задачи и AiError aborted', async () => {
  const calls = mockFetch((_u, init) => (init.method === 'POST' ? json(201, { jobId: 'j3' }) : json(200, { status: 'running', elapsedMs: 100, model: 'm' })));
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 30);
  await assert.rejects(analyzeOrder(smallCtx, [], { pollMs: 5, signal: ctrl.signal }), (e: unknown) => e instanceof AiError && e.code === 'aborted');
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.url === '/api/ai/jobs/j3'), 'задача снята');
  globalThis.fetch = realFetch;
});

// ---------- конвейер ----------
console.log('Конвейер');

function cp1251(s: string): Uint8Array<ArrayBuffer> {
  const map: Record<string, number> = { Ё: 0xa8, ё: 0xb8, '—': 0x97, '–': 0x96, '№': 0xb9 };
  return new Uint8Array(
    [...s].map((ch) => {
      const c = ch.charCodeAt(0);
      if (c >= 0x410 && c <= 0x44f) return c - 0x350;
      return map[ch] ?? (c < 128 ? c : 0x3f);
    }),
  );
}

await test('decodeText: UTF-8, BOM, Windows-1251', () => {
  const s = 'Прошу счёт: БВС-305Х300.000 — 3 шт';
  assert.equal(decodeText(ab(Buffer.from(s, 'utf8'))), s);
  assert.equal(decodeText(ab(Buffer.from('\ufeff' + s, 'utf8'))), s);
  const w = 'Прошу счёт на А сталь, 3 шт';
  assert.equal(decodeText(cp1251(w).buffer as ArrayBuffer), w);
});

await test('parseFiles (Node): дубликаты, архивы, прочие файлы, TXT → документ, слияние DXF+PDF', async () => {
  const dir = join(PROJECTS, '3');
  const file = (n: string) => new File([readFileSync(join(dir, n))], n, { lastModified: 1 });
  const importPdf = async (f: File, defs: { materialId: string; thickness: number }) =>
    positionsFromPages(await readPdf(pdfjs as unknown as PdfJsLike, await f.arrayBuffer()), f.name, pdfFileKey(f), defs);
  const files = [
    file('БВС-305Х300.000 - Блок выхода сброса.dxf'),
    file('БВС-305Х300.000 - Блок выхода сброса.pdf'),
    file('БВС-305Х300.000 - Блок выхода сброса.m3d'),
    new File([cp1251('Прошу счет: БВС-305Х300.000 — 3 шт')], 'заявка.txt'),
    new File(['x'], 'чертежи.rar'),
  ];
  const progress: number[] = [];
  const r = await parseFiles(files, [], { materialId: 'st3', thickness: 2 }, (p) => progress.push(p.done), { importPdf });
  assert.equal(r.positions.length, 1, 'DXF и PDF одной детали — одна позиция');
  assert.equal(r.positions[0].detectedBends, 7);
  assert.match(r.positions[0].drawingText!, /Технические требования/);
  assert.deepEqual(r.addedIds, [r.positions[0].id]);
  assert.deepEqual(r.documents, [{ fileName: 'заявка.txt', text: 'Прошу счет: БВС-305Х300.000 — 3 шт' }]);
  assert.ok(r.warnings.some((w) => /распаковать/.test(w)));
  assert.ok(r.notes.some((n) => /Пропущено файлов/.test(n)));
  assert.deepEqual(progress, [1, 2, 3]);
  // количество — из заявки .txt («БВС-305Х300.000 — 3 шт»), без ИИ
  assert.equal(r.stats.noQty, 0);
  assert.equal(r.positions[0].qty, 3);
  assert.equal(r.positions[0].qtySource, 'request');
  // повторная загрузка тех же файлов — всё пропущено (браузерного хранилища в Node нет — PDF не «восстановлен»)
  const again = await parseFiles(files, { positions: r.positions, documents: r.documents }, { materialId: 'st3', thickness: 2 }, undefined, { importPdf });
  assert.equal(again.stats.duplicates, 3);
  assert.equal(again.stats.restored, 0);
  assert.equal(again.positions, r.positions);
});

await test('parseFiles (Node): одинаковые имена разных файлов в одной загрузке читаются все, повтор папки пропускается', async () => {
  const read = (rel: string) => readFileSync(join(PROJECTS, rel));
  const defs = { materialId: 'st3', thickness: 2 };
  const a = read('4/НГЭН.А86.11.11.1201.dxf');
  const b = read('4/НГЭН.745421.0001 st3 s2mm 5sht.dxf');
  // Корпус/Деталь.dxf и Крышка/Деталь.dxf — разные детали с одним именем; копия первой — ещё в одной папке;
  // три разных text.txt (projects/1, 3, 4 брошены вместе)
  const files = [
    new File([a], 'Деталь.dxf', { lastModified: 1 }),
    new File([b], 'Деталь.dxf', { lastModified: 1 }),
    new File([a], 'Деталь.dxf', { lastModified: 2 }),
    new File([read('1/text.txt')], 'text.txt'),
    new File([read('3/text.txt')], 'text.txt'),
    new File([read('4/text.txt')], 'text.txt'),
  ];
  const r = await parseFiles(files, [], defs);
  assert.equal(r.positions.length, 2, 'две разные детали «Деталь.dxf» — две позиции');
  assert.notEqual(Math.round(r.positions[0].geom.width), Math.round(r.positions[1].geom.width));
  assert.equal(r.stats.duplicates, 1, 'тот же файл (имя и размер) второй раз — пропущен');
  assert.deepEqual(
    r.documents.map((d) => d.fileName),
    ['text.txt', 'text (2).txt', 'text (3).txt'],
    'документы с одним именем различимы (убираются по имени)',
  );
  assert.equal(r.documents[1].text, clipText(decodeText(ab(read('3/text.txt'))), AI_LIMITS.documentChars), 'второй text.txt — текст projects/3');
  assert.ok(r.notes.some((n) => /^Одинаковые имена файлов: Деталь\.dxf ×2, text\.txt ×3 — /.test(n) && /«text \(2\)\.txt», «text \(3\)\.txt»/.test(n)), r.notes.join(' | '));
  assert.ok(r.notes.some((n) => /Одинаковые файлы в загрузке, пропущено: 1/.test(n)));
  // та же папка ещё раз — всё уже в заказе (по имени)
  const again = await parseFiles(files, { positions: r.positions, documents: r.documents }, defs);
  assert.equal(again.stats.duplicates, files.length);
  assert.equal(again.positions, r.positions);
  assert.equal(again.documents.length, 3);
  assert.deepEqual(again.addedIds, []);
});

await test('parseFiles (Node): PDF уже в заказе, но его нет в браузере — файл записан снова, позиция та же', async () => {
  const name = 'БВС-305Х300.000 - Блок выхода сброса.pdf';
  const bytes = readFileSync(join(PROJECTS, '3', name));
  const defs = { materialId: 'st3', thickness: 2 };
  const importPdf = async (f: File, d: { materialId: string; thickness: number }) =>
    positionsFromPages(await readPdf(pdfjs as unknown as PdfJsLike, await f.arrayBuffer()), f.name, pdfFileKey(f), d);
  const first = await parseFiles([new File([bytes], name, { lastModified: 5 })], [], defs, undefined, { importPdf });
  const key = first.positions[0].pdf!.fileKey;
  const calls: string[] = [];
  const restorePdf = async (f: File, k: string) => {
    calls.push(`${f.name}|${k}`);
    return true;
  };
  // тот же файл, скачанный заново (другая дата изменения): узнаём по имени и размеру, пишем под прежним ключом
  const r = await parseFiles([new File([bytes], name, { lastModified: 9 })], { positions: first.positions }, defs, undefined, { importPdf, restorePdf });
  assert.deepEqual(calls, [`${name}|${key}`]);
  assert.deepEqual([r.stats.restored, r.stats.duplicates, r.stats.files], [1, 0, 0]);
  assert.equal(r.positions, first.positions, 'новой позиции нет');
  assert.deepEqual(r.addedIds, []);
  assert.ok(r.notes.some((n) => n.startsWith(`Чертёж восстановлен: ${name}`)), r.notes.join(' | '));
  // файл на месте — обычный повтор
  const r2 = await parseFiles([new File([bytes], name, { lastModified: 5 })], { positions: first.positions }, defs, undefined, { importPdf, restorePdf: async () => false });
  assert.deepEqual([r2.stats.restored, r2.stats.duplicates], [0, 1]);
  assert.ok(r2.notes.some((n) => /Уже в заказе, пропущено: 1/.test(n)));
  // то же имя, другой файл (другой размер) — не восстанавливается, пропущен по имени
  calls.length = 0;
  const r3 = await parseFiles([new File([bytes.subarray(0, 1000)], name)], { positions: first.positions }, defs, undefined, { importPdf, restorePdf });
  assert.deepEqual(calls, []);
  assert.deepEqual([r3.stats.restored, r3.stats.duplicates], [0, 1]);
});

await test('pdfErrorText: ошибки pdf.js по-русски, «Приложение обновилось» при сбое загрузки модуля', async () => {
  const err = async (b: Uint8Array) => {
    try {
      await readPdf(pdfjs as unknown as PdfJsLike, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
      return 'прочитан';
    } catch (e) {
      return pdfErrorText(e);
    }
  };
  assert.equal(await err(new Uint8Array(0)), 'пустой файл');
  assert.equal(await err(new TextEncoder().encode('Привет, это текст, а не PDF')), 'не PDF или файл повреждён');
  assert.equal(pdfErrorText({ name: 'PasswordException', message: 'No password given' }), 'PDF защищён паролем');
  assert.equal(pdfErrorText(new TypeError('x is undefined')), 'не удалось прочитать PDF');
  assert.equal(pdfErrorText(new TypeError('Failed to fetch dynamically imported module: https://x/assets/pdf-AbC.js')), APP_UPDATED);
  assert.equal(pdfErrorText(new Error('error loading dynamically imported module: /assets/pdf-AbC.js')), APP_UPDATED);
  assert.equal(pdfErrorText(new TypeError('Importing a module script failed.')), APP_UPDATED);
});

await test('normalizeOrder: старый заказ без новых полей загружается, битый ИИ отброшен', () => {
  const old = { title: 'Старый', positions: [plate('A')], sheetChoice: {}, priceOverride: {}, markupPct: 0, delivery: 0 };
  const o = normalizeOrder(JSON.parse(JSON.stringify(old)));
  assert.equal(o.markupPct, 50);
  assert.equal(o.request, '');
  assert.deepEqual(o.documents, []);
  assert.deepEqual(o.requestLines, []);
  assert.equal(o.ai, undefined);
  const bad = normalizeOrder({ ...old, v: 2, markupPct: 30, ai: { analysis: null }, documents: [{ fileName: 'a' }, { fileName: 'b', text: 't' }] });
  assert.equal(bad.ai, undefined);
  assert.equal(bad.markupPct, 30);
  assert.deepEqual(bad.documents, [{ fileName: 'b', text: 't' }]);
  const good = normalizeOrder({ ...old, v: 2, ai: state });
  assert.equal(good.ai, state);
});

await test('runQuote: цены → ИИ (подменённый сервер) → расчёт с принятыми предложениями', async () => {
  resetPriceAttempts();
  const ps = [plate('A', { id: 'a', guessed: { material: false, thickness: false, qty: true } })];
  const an = analysisFor([{ id: 'a', status: 'check', comment: 'Количество по заявке', operations: ['лазерная резка'], suggestions: [sug('a#1', 'qty', { value: 7 }), sug('a#2', 'extra', { label: 'Зенковка', perPiece: 40 })] }]);
  mockFetch((url, init) => {
    if (url === '/api/prices/refresh') return json(200, { book, errors: [] });
    if (url === '/api/ai/status') return json(200, { configured: true, model: 'test-model', vision: false });
    if (url === '/api/ai/jobs' && init.method === 'POST') return json(201, { jobId: 'q1' });
    if (url === '/api/ai/jobs/q1') return json(200, { status: 'done', analysis: an });
    return json(404, {});
  });
  const seen: string[] = [];
  const r = await runQuote({ order: orderOf(ps), book, settings, live: true }, { onStages: (s) => seen.push(`${s.prices.status}/${s.ai.status}/${s.calc.status}`) });
  assert.equal(r.aiResult.status, 'done', r.aiResult.detail);
  assert.equal(r.positions[0].qty, 7);
  assert.deepEqual(r.positions[0].extras, [{ label: 'Зенковка', perPiece: 40, aiId: 'a#2' }]);
  assert.equal(r.res.positions.get('a')!.qty, 7);
  assert.equal(r.stages.calc.status, 'done');
  assert.match(r.stages.calc.detail, /Себестоимость .* цена клиенту .* выручка/);
  assert.equal(r.ai!.contextHash, contextHash(buildAiContext(orderOf(ps), null, r.book, settings)), 'хэш совпадает с текущим заказом');
  assert.ok(seen.length >= 5);

  // ИИ не настроен — этап пропущен, расчёт есть
  mockFetch((url2) => (url2 === '/api/ai/status' ? json(200, { configured: false, model: null, vision: false }) : json(200, { book, errors: [] })));
  const r2 = await runQuote({ order: orderOf(ps), book, settings, live: false });
  assert.equal(r2.aiResult.status, 'skipped');
  assert.equal(r2.ai, null);
  assert.equal(r2.positions[0].qty, 3);
  assert.equal(r2.stages.calc.status, 'done');
  globalThis.fetch = realFetch;
});

await test('updateStage: время начала и конца', () => {
  let s = initialStages();
  s = updateStage(s, 'ai', 'running', 'идёт', 100);
  assert.equal(s.ai.startedAt, 100);
  s = updateStage(s, 'ai', 'done', 'готово', 250);
  assert.deepEqual([s.ai.status, s.ai.detail, s.ai.finishedAt], ['done', 'готово', 250]);
  assert.equal(s.files.status, 'pending');
});


// ---------- сверка со счетами: распознавание без ИИ и модель резки ----------

const { qtyLinesFromText, applyRequestQty } = await import('../src/requestQty.ts');
const { mergeImports } = await import('../src/merge.ts');
const { detectMaterial } = await import('../src/core/pdfAnalyze.ts');

await test('количество из текста заявки: таблица, «— 5 шт», «10шт.», цена «руб/шт» не путается', () => {
  const lines = qtyLinesFromText(
    'Прошу счет на А сталь\n\nБлок выхода сброса БВС-305Х300.000\t3\tшт\nНГЭН.745535.0021-01 - 5 шт — 995 руб/шт (из стали 08пс)\nНГЭН.745428.0003-1700 10шт.\nНГЭН.1 кол-во 3',
  );
  assert.deepEqual(lines, [
    { designation: 'БВС-305Х300.000', qty: 3 },
    { designation: 'НГЭН.745535.0021-01', qty: 5 },
    { designation: 'НГЭН.745428.0003-1700', qty: 10 },
  ]);
});

await test('количество из заявки: только где не найдено в файлах или уже взято из заявки; ручная правка — не трогается', () => {
  const pos = (name: string, qty: number, guessed: boolean, qtySource?: 'request') =>
    ({ ...manualPosition({ name, materialId: 'st3', thickness: 2, qty, width: 100, height: 100, holes: 0, holeD: 0, bends: 0 }), guessed: { material: false, thickness: false, qty: guessed }, qtySource }) as OrderPosition;
  const ps = [pos('А-1.1', 1, true), pos('А-1.2', 7, false), pos('А-1.3', 4, false, 'request')];
  const r = applyRequestQty(ps, qtyLinesFromText('А-1.1 — 5 шт\nА-1.2 — 9 шт\nА-1.3 — 6 шт'));
  assert.equal(r.applied, 2);
  assert.deepEqual(r.positions.map((p) => [p.qty, p.guessed.qty, p.qtySource]), [[5, false, 'request'], [7, false, undefined], [6, false, 'request']]);
  assert.equal(applyRequestQty(ps, []).positions, ps);
});

await test('штамп: рифлёный АМг2 по номеру ТУ («квинтет» без слова «рифл»)', () => {
  const t = (str: string) => ({ str, x: 0, y: 0, w: 10, h: 3, angle: 0 });
  assert.equal(detectMaterial([t('Лист 3 ТУ 1-801-20-02'), t('АМг2 ГОСТ 21631-76')]).materialId, 'amg2r');
  assert.equal(detectMaterial([t('Лист 3 ГОСТ 21631-76'), t('АМг2 ГОСТ 21631-76')]).materialId, 'amg2');
});

await test('projects/2: DXF исполнений получают гибы, рифлёный материал и сверку массы с чертежа; базовое исполнение исключено', async () => {
  const dir = join(PROJECTS, '2');
  const files = ['НГЭН.745428.0003 Короб защитный (изм.2).pdf', 'НГЭН.745428.0003-0700 amg2 s3mm.dxf', 'НГЭН.745428.0003-1700 amg2 s3mm.dxf'].map(
    (n) => new File([readFileSync(join(dir, n))], n),
  );
  const r = await parseFiles(files, [], { materialId: 'st3', thickness: 2 }, undefined, {
    importPdf: async (f, defs) => positionsFromPages(await readPdf(pdfjs as unknown as PdfJsLike, await f.arrayBuffer()), f.name, pdfFileKey(f), defs),
  });
  const by = (n: string) => r.positions.find((p) => p.name === n)!;
  for (const n of ['НГЭН.745428.0003-0700', 'НГЭН.745428.0003-1700']) {
    const p = by(n);
    assert.equal(p.materialId, 'amg2r', `${n}: материал по штампу`);
    assert.equal(p.bends, 4, `${n}: гибы с чертежа`);
    assert.equal(p.disabled, undefined);
    assert.ok(p.pdf && p.pdf.meta.row >= 0, `${n}: строка таблицы для сверки массы`);
  }
  assert.equal(by('НГЭН.745428.0003').disabled, true);
  assert.ok(r.notes.some((n) => /базовое исполнение исключено/.test(n)));
});

await test('гибы с зеркального листа того же PDF; лист без файла, которого нет в заявке, исключается', () => {
  const mk = (name: string, file: string, bends: number, source: 'dxf' | 'pdf'): OrderPosition =>
    ({
      ...manualPosition({ name, materialId: '08ps', thickness: 2, qty: 1, width: 855, height: 1580, holes: 0, holeD: 0, bends: 0 }),
      bends,
      detectedBends: bends,
      bendLengths: bends ? Array(bends).fill(855) : undefined,
      source,
      pdf: { fileKey: 'k', geometryFromPdf: source === 'pdf', notes: [], meta: { fileName: file } as never },
    }) as OrderPosition;
  const m = mergeImports([mk('НГЭН.А86.11.11.1201', '1201.pdf', 0, 'dxf'), mk('НГЭН.А86.11.11.1201-01', '1201.pdf', 3, 'pdf')], [], [], [{ designation: 'НГЭН.А86.11.11.1201', qty: 5 }]);
  const [a, b] = m.positions;
  assert.deepEqual([a.bends, a.qty, a.disabled], [3, 5, undefined]);
  assert.equal(b.disabled, true);
});

await test('резка по прайсу: метры × ₽/м + врезки × ₽, 09Г2С ×1,15, толщина — по ближайшей большей строке; гибы по своим длинам', () => {
  const book: PriceBook = { updatedAt: null, region: 'СПб', materials: {} };
  const p = (id: string, materialId: string, thickness: number, extra: Partial<OrderPosition> = {}) =>
    ({ ...manualPosition({ name: id, materialId, thickness, qty: 1, width: 200, height: 100, holes: 3, holeD: 10, bends: 0 }), id, ...extra }) as OrderPosition;
  const s = structuredClone(DEFAULT_SETTINGS);
  const r = computeOrder([p('a', 'st3', 1.2), p('b', '09g2s', 10), p('c', 'st3', 2, { bends: 2, bendLength: 1500, bendLengths: [200, 1500] })], book, s);
  const a = r.positions.get('a')!;
  assert.equal(a.rate.rowT, 1.5);
  assert.equal(a.piece.pierce, 4 * 8); // контур + 3 отверстия, 1,5 мм — 8 ₽
  const b = r.positions.get('b')!;
  assert.ok(Math.abs(b.piece.cut - b.cutM * 167 * 1.15) < 1e-6);
  assert.ok(Math.abs(b.piece.pierce - 4 * 28 * 1.15) < 1e-6);
  const c = r.positions.get('c')!;
  const perBend = 70; // 2 мм
  assert.ok(Math.abs(c.piece.bend - perBend * (0.8 + 1.4)) < 1e-6, 'гиб 200 мм ×0,8 и гиб 1500 мм ×1,4');
});

console.log(`\n${passed} пройдено, ${failed.length} не пройдено${failed.length ? ': ' + failed.join('; ') : ''}`);
if (failed.length) process.exit(1);
