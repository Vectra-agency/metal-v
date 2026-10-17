// Офлайн-тесты ИИ-анализа — без сети и без ключа: разбор JSON из ответа модели, проверка ответа
// по данным заказа, проверка AiContext, лимит тела запроса, очередь задач на заглушке LLM_MOCK,
// проверка тела обновления цен и ответы HTTP API (без mc.ru).
// Запуск: node scripts/test-ai.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { aiStateFrom, effectivePositions } from '../src/ai/apply.ts';
import { cyrb53 } from '../src/ai/context.ts';
import { buildAttention } from '../src/attention.ts';
import { AI_RESPONSE_SCHEMA, type AiAnalysis, type AiContext } from '../src/core/ai.ts';
import { AI_OUTPUT_LIMITS, extractJson, sanitizeAnalysis, stripConfirmations } from '../src/core/aiSanitize.ts';
import { computeOrder, DEFAULT_SETTINGS, type PriceBook } from '../src/core/pricing.ts';
import { emptyOrder, manualPosition, orderSettings, type Order } from '../src/order.ts';
import type { LlmMessage } from '../server/llm.ts';

// заглушка вместо модели: тесты не ходят в сеть и не тратят деньги
process.env.LLM_MOCK = '1';
process.env.LLM_MOCK_DELAY_MS = '20';
const ai = await import('../server/ai.ts');
const api = await import('../server/api.ts');
const { readRaw } = api;

const fixture: AiContext = JSON.parse(readFileSync(new URL('./fixtures/context-p4.json', import.meta.url), 'utf8'));
const ctx = () => structuredClone(fixture);
const meta = { model: 'test/model', durationMs: 1234.4 };

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => unknown) {
  try {
    await fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${String((e as Error).stack ?? e).split('\n').slice(0, 6).join('\n        ')}`);
  }
}

/** Ошибка HTTP с нужным кодом (и текстом) */
async function rejectsHttp(fn: () => unknown, status: number, text?: RegExp) {
  try {
    await fn();
  } catch (e) {
    assert.ok(e instanceof ai.HttpError, `ожидалась HttpError, получено: ${String(e)}`);
    assert.equal(e.status, status, e.message);
    if (text) assert.match(e.message, text);
    return;
  }
  assert.fail(`ожидалась ошибка ${status}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitDone(id: string, ms = 3000) {
  const t0 = Date.now();
  for (;;) {
    const s = ai.getJob(id);
    if (s.status === 'done' || s.status === 'error') return s;
    if (Date.now() - t0 > ms) assert.fail(`задача не завершилась за ${ms} мс: ${JSON.stringify(s)}`);
    await sleep(10);
  }
}

const jpeg = (size = 2000) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size - 4, 7)]);
const withImages = (c: AiContext, n: number) => {
  c.images = Array.from({ length: n }, (_, i) => ({ index: i, positionId: c.positions[i % c.positions.length].id, caption: `чертёж ${i}` }));
  return c;
};

// ---------- extractJson ----------
console.log('extractJson');

await test('чистый JSON', () => {
  assert.deepEqual(extractJson('{"summary":"ok","positions":[]}'), { summary: 'ok', positions: [] });
});

await test('обёртка ```json и текст вокруг', () => {
  const v = extractJson('Вот анализ:\n```json\n{"summary":"в обёртке","positions":[]}\n```\nЕсли нужно — уточню.');
  assert.deepEqual(v, { summary: 'в обёртке', positions: [] });
});

await test('текст до и после без обёртки', () => {
  const v = extractJson('Конечно! Ответ: {"summary":"между текстом","questions":["?"]} — надеюсь, помог.');
  assert.deepEqual(v, { summary: 'между текстом', questions: ['?'] });
});

await test('скобки и кавычки внутри строк', () => {
  const v = extractJson('Ответ: {"summary":"скобки { и } и \\"кавычки\\" внутри","positions":[{"id":"a","comment":"}{"}]} конец') as { summary: string; positions: { comment: string }[] };
  assert.equal(v.summary, 'скобки { и } и "кавычки" внутри');
  assert.equal(v.positions[0].comment, '}{');
});

await test('рассуждения <think> и фигурные скобки в тексте перед ответом', () => {
  const v = extractJson('<think>схема {summary, positions}</think>Формат {как просили}: {"summary":"после think","positions":[]}');
  assert.deepEqual(v, { summary: 'после think', positions: [] });
});

await test('лишние запятые', () => {
  assert.deepEqual(extractJson('{"summary":"x","positions":[1,2,],}'), { summary: 'x', positions: [1, 2] });
});

await test('обрезанный ответ — ошибка, а не вложенный объект', () => {
  assert.throws(() => extractJson('```json\n{"summary":"x","positions":[{"id":"a","status":"ok"},{"id":"b","comm'), /обрезан/);
});

await test('нет JSON / пусто — ошибка', () => {
  assert.throws(() => extractJson('Не могу ответить на этот вопрос.'), /нет JSON/);
  assert.throws(() => extractJson('   '), /пустой/);
  assert.throws(() => extractJson('{не json}'), /не разбирается/);
});

// ---------- sanitizeAnalysis ----------
console.log('sanitizeAnalysis');

const noisy = {
  summary: '**Заказ** из 7 позиций.\n\n\n\nВторая   строка',
  confidence: 'very high',
  positions: [
    {
      id: 'p4-1',
      status: 'problem',
      comment: 'Материал по штампу — х/к.',
      operations: ['- лазерная резка', 'Лазерная  резка', 'гибка — 7 гибов', ''],
      suggestions: [
        { kind: 'material', materialId: 'steel-x', value: null, label: null, perPiece: null, reason: 'чужой материал' },
        { kind: 'material', materialId: 'st3', value: null, label: null, perPiece: null, reason: 'как сейчас' },
        { kind: 'material', materialId: '08ps', value: null, label: null, perPiece: null, reason: 'штамп: ГОСТ 19904 — х/к' },
        { kind: 'thickness', materialId: null, value: 0.1, label: null, perPiece: null, reason: 'мало' },
        { kind: 'thickness', materialId: null, value: 100, label: null, perPiece: null, reason: 'много' },
        { kind: 'thickness', materialId: null, value: 2, label: null, perPiece: null, reason: 'как сейчас' },
        { kind: 'thickness', materialId: null, value: '1,5', label: null, perPiece: null, reason: 'строкой с запятой' },
        { kind: 'qty', materialId: null, value: 2.5, label: null, perPiece: null, reason: 'дробное' },
        { kind: 'qty', materialId: null, value: 5, label: null, perPiece: null, reason: 'как сейчас' },
        { kind: 'qty', materialId: null, value: 0, label: null, perPiece: null, reason: 'ноль' },
        { kind: 'bends', materialId: null, value: 51, label: null, perPiece: null, reason: 'много' },
        { kind: 'bends', materialId: null, value: 7, label: null, perPiece: null, reason: 'как сейчас' },
        { kind: 'bends', materialId: null, value: 8, label: null, perPiece: null, reason: 'по виду сбоку' },
        { kind: 'extra', materialId: null, value: null, label: '  ', perPiece: 100, reason: 'без названия' },
        { kind: 'extra', materialId: null, value: null, label: 'Сварка стыка', perPiece: -5, reason: 'минус' },
        { kind: 'extra', materialId: null, value: null, label: 'Сварка стыка', perPiece: 2e6, reason: 'дорого' },
        { kind: 'extra', materialId: null, value: null, label: 'Сварка стыка', perPiece: 243.6049, reason: 'шов 0,348 м × 700 ₽/м' },
        { kind: 'extra', materialId: null, value: null, label: 'сварка  стыка!', perPiece: 300, reason: 'повтор' },
        { kind: 'paint', reason: 'неизвестный вид' },
        'не объект',
      ],
    },
    { id: 'НГЭН.745535.0021-01', status: 'warning', comment: '', operations: [], suggestions: [{ kind: 'qty', value: '5', reason: 'заявка: «НГЭН.745535.0021-01 - 5 шт»' }] },
    { id: 'p-unknown', status: 'problem', comment: 'чужая позиция', operations: [], suggestions: [] },
    { id: 'p4-3', status: 'ok', comment: '', operations: [], suggestions: [] },
    { id: 'p4-1', status: 'check', comment: 'Режется из двух частей.', operations: ['сварка стыка'], suggestions: [] },
  ],
  questions: [...Array.from({ length: 15 }, (_, i) => `Вопрос ${i + 1}?`), 'Вопрос 1?'],
  risks: 'Риск один\n2. Риск два',
  recommendations: [42, null, 'Рекомендация'],
};

await test('неизвестные id, чужие материалы, вне диапазона, повторы, как сейчас', () => {
  const c = ctx();
  const a = sanitizeAnalysis(noisy, c, meta);
  assert.deepEqual(
    a.positions.map((p) => p.id),
    ['p4-1', 'p4-2'],
  );
  const p1 = a.positions[0];
  assert.equal(p1.status, 'problem'); // худший из двух отзывов
  assert.equal(p1.comment, 'Материал по штампу — х/к. Режется из двух частей.');
  assert.deepEqual(p1.operations, ['лазерная резка', 'гибка — 7 гибов', 'сварка стыка']);
  assert.deepEqual(p1.suggestions, [
    { id: 'p4-1#1', kind: 'material', materialId: '08ps', reason: 'штамп: ГОСТ 19904 — х/к' },
    { id: 'p4-1#2', kind: 'thickness', value: 1.5, reason: 'строкой с запятой' },
    { id: 'p4-1#3', kind: 'bends', value: 8, reason: 'по виду сбоку' },
    { id: 'p4-1#4', kind: 'extra', label: 'Сварка стыка', perPiece: 243.6, reason: 'шов 0,348 м × 700 ₽/м' },
  ]);
  // по обозначению вместо id, статус warning → check, количество строкой
  assert.deepEqual(a.positions[1], { id: 'p4-2', status: 'check', comment: '', operations: [], suggestions: [{ id: 'p4-2#1', kind: 'qty', value: 5, reason: 'заявка: «НГЭН.745535.0021-01 - 5 шт»' }] });
  assert.equal(a.questions.length, AI_OUTPUT_LIMITS.items);
  assert.deepEqual(a.risks, ['Риск один', 'Риск два']);
  assert.deepEqual(a.recommendations, ['42', 'Рекомендация']);
  assert.equal(a.confidence, 'medium');
  assert.equal(a.summary, 'Заказ из 7 позиций.\n\nВторая строка');
  assert.equal(a.model, 'test/model');
  assert.equal(a.durationMs, 1234);
  assert.ok(!Number.isNaN(Date.parse(a.createdAt)));
  assert.deepEqual(c, fixture, 'контекст не должен меняться');
});

await test('ограничения длины и количества', () => {
  const c = ctx();
  const long = 'Очень длинный текст. '.repeat(200);
  const a = sanitizeAnalysis(
    {
      summary: long,
      confidence: 'high',
      positions: [
        {
          id: 'p4-2',
          status: 'check',
          comment: long,
          operations: Array.from({ length: 20 }, (_, i) => `операция ${i}`),
          suggestions: Array.from({ length: 20 }, (_, i) => ({ kind: 'extra', label: `Работа ${i}`, perPiece: 10 + i, reason: long })),
        },
      ],
      questions: [],
      risks: [],
      recommendations: [],
    },
    c,
    meta,
  );
  const p = a.positions[0];
  assert.ok(a.summary.length <= AI_OUTPUT_LIMITS.summary && a.summary.endsWith('…'));
  assert.ok(p.comment.length <= AI_OUTPUT_LIMITS.comment);
  assert.equal(p.operations.length, AI_OUTPUT_LIMITS.operations);
  assert.equal(p.suggestions.length, AI_OUTPUT_LIMITS.suggestions);
  assert.ok(p.suggestions.every((s) => s.reason.length <= AI_OUTPUT_LIMITS.reason));
  assert.deepEqual(
    p.suggestions.map((s) => s.id),
    Array.from({ length: 8 }, (_, i) => `p4-2#${i + 1}`),
  );
  assert.equal(a.confidence, 'high');
});

await test('доп. работа: perPiece расходится с расчётом в reason — не применяется', () => {
  const sug = (perPiece: number, reason: string) => ({ kind: 'extra', materialId: null, value: null, label: 'Сварка стыка', perPiece, reason });
  const run = (s: unknown) => sanitizeAnalysis({ summary: '', positions: [{ id: 'p4-1', status: 'check', comment: 'c', operations: [], suggestions: [s] }] }, ctx(), meta).positions[0].suggestions;
  assert.equal(run(sug(105, 'стык 348 мм: 0,348 м × 700 ₽/м = 244 ₽; уточнить')).length, 0);
  assert.equal(run(sug(243.6, '0,348 м × 700 ₽/м = 243,6 ₽ на 1 шт, на 5 шт = 1 218 ₽')).length, 1);
  assert.equal(run(sug(377, 'покраска: 2 × 0,29 м² × 650 ₽/м² = 377 ₽')).length, 1);
  assert.equal(run(sug(500, 'по ставке, без расчёта')).length, 1);
});

await test('пустой отзыв ok выбрасывается; доп. работа, которая уже есть у позиции, не предлагается', () => {
  const c = ctx();
  const a = sanitizeAnalysis(
    {
      summary: 's',
      positions: [
        { id: 'p4-3', status: 'ok', comment: '', operations: [], suggestions: [] },
        { id: 'p4-4', status: 'check', comment: 'Покраска по чертежу.', operations: [], suggestions: [{ kind: 'extra', label: 'Порошковая покраска', perPiece: 400, reason: '' }] },
      ],
    },
    { ...c, positions: c.positions.map((p) => (p.id === 'p4-4' ? { ...p, extras: [{ label: 'порошковая покраска!', perPiece: 377 }] } : p)) },
    meta,
  );
  assert.deepEqual(a.positions, [{ id: 'p4-4', status: 'check', comment: 'Покраска по чертежу.', operations: [], suggestions: [] }]);
});

await test('нечего сказать и предложить — позиция в порядке: только резка и гибка — отзыва нет, другая операция — ok', () => {
  const a = sanitizeAnalysis(
    {
      summary: 's',
      positions: [
        // предложение отброшено (такая работа уже есть), комментария нет — «проверить» нечего
        { id: 'p4-4', status: 'check', comment: '', operations: ['лазерная резка', 'гибка — 2 гиба'], suggestions: [] },
        { id: 'p4-5', status: 'problem', comment: '  ', operations: ['лазерная резка'], suggestions: [] },
        { id: 'p4-6', status: 'check', comment: '', operations: ['зенковка 4 отв. — ставки нет'], suggestions: [] },
      ],
    },
    ctx(),
    meta,
  );
  assert.deepEqual(a.positions, [{ id: 'p4-6', status: 'ok', comment: '', operations: ['зенковка 4 отв. — ставки нет'], suggestions: [] }]);
});

// предложение исключить позицию — как его пишет модель по схеме: все поля, кроме reason, null
const dis = (reason: unknown, extra: Record<string, unknown> = {}) => ({ kind: 'disable', reason, materialId: null, value: null, label: null, perPiece: null, ...extra });

await test('disable: только у включённой позиции, одно на позицию, без лишних полей, причина обязательна и обрезается', () => {
  const c = ctx();
  c.positions[5].disabled = true; // p4-6 уже исключена из расчёта
  const why = 'заявка называет только «НГЭН.А86.11.11.1201 - 5 шт», исполнения -01 в ней нет';
  const a = sanitizeAnalysis(
    {
      summary: 's',
      positions: [
        {
          id: 'p4-7',
          status: 'ok',
          comment: 'Исполнения -01 в заявке нет.',
          operations: [],
          suggestions: [
            { kind: 'qty', reason: 'подтверждение', materialId: null, value: 2, label: null, perPiece: null },
            dis(why, { materialId: 'amg2', value: 3, label: 'Исключить', perPiece: 100 }),
            dis('повтор'),
          ],
        },
        { id: 'p4-6', status: 'check', comment: 'Исключена, а заявка её просит.', operations: [], suggestions: [dis('уже исключена'), { kind: 'qty', reason: 'заявка', value: 7 }] },
        { id: 'p4-5', status: 'check', comment: 'без причины', operations: [], suggestions: [dis(''), dis('   '), dis(null)] },
        { id: 'p4-4', status: 'check', comment: 'длинная причина', operations: [], suggestions: [dis('очень длинная причина '.repeat(40))] },
      ],
    },
    c,
    meta,
  );
  const by = new Map(a.positions.map((r) => [r.id, r]));
  // ok с советом исключить — уже «проверить»; количество при disable не берём (применилось бы само);
  // номера предложений подряд: `${id}#${n}`
  assert.deepEqual(by.get('p4-7'), {
    id: 'p4-7',
    status: 'check',
    comment: 'Исполнения -01 в заявке нет.',
    operations: [],
    suggestions: [{ id: 'p4-7#1', kind: 'disable', reason: why }],
  });
  // исключённая позиция: отзыв остаётся, предложений нет никаких
  assert.deepEqual(by.get('p4-6'), { id: 'p4-6', status: 'check', comment: 'Исключена, а заявка её просит.', operations: [], suggestions: [] });
  assert.deepEqual(by.get('p4-5')?.suggestions, []);
  const long = by.get('p4-4')?.suggestions ?? [];
  assert.equal(long.length, 1);
  assert.equal(long[0].id, 'p4-4#1');
  assert.ok(long[0].reason.length <= AI_OUTPUT_LIMITS.reason && long[0].reason.endsWith('…'));
  assert.deepEqual(Object.keys(long[0]).sort(), ['id', 'kind', 'reason']);
});

await test('disable всех позиций расчёта — не предлагается (пустой заказ никому не нужен)', () => {
  const c = ctx();
  const every = sanitizeAnalysis({ summary: 's', positions: c.positions.map((p) => ({ id: p.id, status: 'check', comment: 'лишняя', operations: [], suggestions: [dis('не заказана')] })) }, c, meta);
  assert.equal(every.positions.length, c.positions.length);
  assert.ok(every.positions.every((r) => r.suggestions.length === 0));
  // в расчёте одна позиция — её не исключаем (а количество тогда остаётся); две — одну можно
  const one = ctx();
  one.positions.forEach((p, i) => (p.disabled = i > 0));
  const only = sanitizeAnalysis({ positions: [{ id: 'p4-1', status: 'check', comment: 'c', suggestions: [dis('нет в заявке'), { kind: 'qty', reason: 'заявка', value: 9 }] }] }, one, meta);
  assert.deepEqual(only.positions[0].suggestions, [{ id: 'p4-1#1', kind: 'qty', value: 9, reason: 'заявка' }]);
  one.positions[1].disabled = false;
  assert.deepEqual(sanitizeAnalysis({ positions: [{ id: 'p4-2', status: 'check', comment: 'c', suggestions: [dis('нет в заявке')] }] }, one, meta).positions[0].suggestions, [
    { id: 'p4-2#1', kind: 'disable', reason: 'нет в заявке' },
  ]);
});

await test('вопрос «подтвердите N шт» по детали, количество которой уже исправлено по заявке, — отбрасывается', () => {
  const qty = (value: number, reason: string) => ({ kind: 'qty', reason, materialId: null, value, label: null, perPiece: null });
  const a = sanitizeAnalysis(
    {
      summary: 's',
      positions: [
        { id: 'p4-1', status: 'problem', comment: 'В заявке 10 шт.', operations: [], suggestions: [qty(10, 'заявка: «НГЭН.745421.0001 — 10 шт.»')] },
        { id: 'p4-2', status: 'problem', comment: 'В заявке 5 шт.', operations: [], suggestions: [qty(5, 'заявка: «НГЭН.745535.0021-01 - 5 шт»')] },
        { id: 'p4-3', status: 'check', comment: 'Количество по имени файла.', operations: [], suggestions: [qty(4, 'имя файла: «4sht»')] },
      ],
      questions: [
        'Сколько штук канала НГЭН.745421.0001 нужно: в заявке 10, в расчёте 5 — подтвердите 10?',
        'Подтвердите количества: Корпус НГЭН.745535.0021-01 — 5 шт, Канал НГЭН.745421.0001 — 10 шт.',
        'Подтвердите количество НГЭН.А86.11.11.1201: 4 шт?', // исправлено не по заявке — спросить можно
        'Подтвердите количество НГЭН.745421.0001 и сварку стыка: 10 шт, стык сварите сами?', // другая тема
        'Подтвердите количество НГЭН.А86.11.11.1201-01 — 1 шт?', // исполнение — другая деталь
        'Сколько штук нужно НГЭН.745421.0001?', // не «подтвердите»
      ],
    },
    ctx(),
    meta,
  );
  assert.deepEqual(a.questions, [
    'Подтвердите количество НГЭН.А86.11.11.1201: 4 шт?',
    'Подтвердите количество НГЭН.745421.0001 и сварку стыка: 10 шт, стык сварите сами?',
    'Подтвердите количество НГЭН.А86.11.11.1201-01 — 1 шт?',
    'Сколько штук нужно НГЭН.745421.0001?',
  ]);
});

// комментарии настоящего анализа projects/4 (scratchpad integration/real-run.txt)
const REAL = {
  p0001:
    'В расчёте Ст3 г/к, а штамп ГОСТ 19904 — холоднокатаный лист 08пс; заявка 5 шт, в расчёте 5 шт. Деталь не помещается в лист 1000×2000, режется из двух частей; чертёж допускает составную до трёх частей со сваркой стыка.',
  p0002: 'Материал рифлёный по штампу (ромб К-ПУ-3), в расчёте 5 шт — совпадает с заявкой; разрезать на две части или прямой лист — по чертежу допустимо, но цех режет целиком.',
  p0004: 'Заявка 5 шт, в расчёте 5 шт; по заявке из двух частей, чертёж допускает.',
  p0021: 'В заявке 5 шт, в расчёте 1 шт — количество по заявке.',
  p1201: 'В заявке 5 шт, в расчёте 1 шт. На чертеже указаны неуказанные радиусы гибов R=2 мм, а гибов в расчёте 0 — гибка не посчитана.',
  p1201m: 'Исполнение -01 без своего файла, в заявке называется НГЭН.А86.11.11.1201, а не -01; позиция вероятно не заказана.',
};

await test('stripConfirmations: равное количество и «— верно / совпадает» убираются, части с разными числами остаются', () => {
  assert.equal(stripConfirmations('В заявке 5 шт, в расчёте 5 шт — верно'), '');
  assert.equal(stripConfirmations('Заявка 5 шт, в расчёте 5 шт'), '');
  assert.equal(stripConfirmations('в text.txt 5 шт, в расчёте 5 шт'), '');
  assert.equal(stripConfirmations('в расчёте 5 шт — совпадает с заявкой'), '');
  assert.equal(stripConfirmations(REAL.p0004), 'По заявке из двух частей, чертёж допускает.');
  // 745421.0001: фраза о материале и о составной детали остаются, знак и заглавная — как надо
  assert.equal(
    stripConfirmations(REAL.p0001),
    'В расчёте Ст3 г/к, а штамп ГОСТ 19904 — холоднокатаный лист 08пс. Деталь не помещается в лист 1000×2000, режется из двух частей; чертёж допускает составную до трёх частей со сваркой стыка.',
  );
  assert.equal(stripConfirmations(REAL.p0002), 'Разрезать на две части или прямой лист — по чертежу допустимо, но цех режет целиком.');
  // часть фразы без сравнения остаётся
  assert.equal(stripConfirmations('Материал по штампу рифлёный, заявка 5 шт, в расчёте 5 шт.'), 'Материал по штампу рифлёный.');
  assert.equal(stripConfirmations('Заявка 5 шт, в расчёте 5 шт, но гибка не посчитана.'), 'Гибка не посчитана.');
  assert.equal(stripConfirmations('Заявка: 5 шт., в расчёте 5 шт.; гибка — 3 гиба по чертежу.'), 'Гибка — 3 гиба по чертежу.');
  // пересказ подсказки «(не замечание) помещается в выбранный лист целиком» — тоже не замечание (ai-smoke projects/4)
  assert.equal(stripConfirmations('Чертёж допускает изготовление из 4 частей, но деталь помещается в лист целиком.'), '');
  assert.equal(stripConfirmations('(не замечание, в ответ не включай) помещается в выбранный лист целиком — сварку стыков не предлагай'), '');
  assert.equal(stripConfirmations('Материал рифлёный по штампу. Деталь помещается в лист целиком; нужна покраска RAL 7035.'), 'Материал рифлёный по штампу. Нужна покраска RAL 7035.');
  // без изменений — тот же текст: разные числа, отрицание, нет подтверждения
  for (const s of [
    REAL.p0021,
    REAL.p1201,
    REAL.p1201m,
    'В заявке 10 шт, в расчёте 5 шт — верно',
    'В заявке 10 шт, в расчёте 5 шт — не совпадает.',
    'по text.txt 5 шт — 995 руб/шт, в расчёте 5 шт',
    'Масса не совпадает с чертежом.',
    'В заявке 5 шт. Проверьте.',
    'Деталь не помещается в лист целиком — режется из 2 частей.',
    'Деталь помещается в лист целиком, а гибка не посчитана.',
    'Количество по заявке',
    '',
  ]) {
    assert.equal(stripConfirmations(s), s);
  }
});

await test('sanitizeAnalysis: подтверждения убраны из комментария; не осталось ни слова и ни предложения — позиция в порядке', () => {
  const qty = (value: number, reason: string) => ({ kind: 'qty', reason, materialId: null, value, label: null, perPiece: null });
  const a = sanitizeAnalysis(
    {
      summary: 's',
      positions: [
        { id: 'p4-1', status: 'problem', comment: REAL.p0001, operations: ['лазерная резка'], suggestions: [{ kind: 'material', reason: 'штамп: ГОСТ 19904', materialId: '08ps' }] },
        { id: 'p4-2', status: 'problem', comment: REAL.p0021, operations: [], suggestions: [qty(5, 'заявка: «НГЭН.745535.0021-01 - 5 шт»')] },
        { id: 'p4-4', status: 'check', comment: REAL.p0002, operations: ['лазерная резка'], suggestions: [] },
        { id: 'p4-5', status: 'check', comment: 'Заявка 5 шт, в расчёте 5 шт', operations: ['лазерная резка'], suggestions: [] },
        { id: 'p4-6', status: 'problem', comment: 'В заявке 5 шт, в расчёте 5 шт — верно', operations: ['лазерная резка', 'рифлёный лист 3 мм'], suggestions: [] },
      ],
    },
    ctx(),
    meta,
  );
  const by = new Map(a.positions.map((r) => [r.id, r]));
  assert.equal(by.get('p4-1')?.comment, stripConfirmations(REAL.p0001));
  assert.equal(by.get('p4-1')?.status, 'problem');
  assert.equal(by.get('p4-2')?.comment, REAL.p0021);
  assert.deepEqual([by.get('p4-4')?.status, by.get('p4-4')?.comment], ['check', 'Разрезать на две части или прямой лист — по чертежу допустимо, но цех режет целиком.']);
  assert.ok(!by.has('p4-5'), 'только подтверждение и резка — отзыва нет');
  assert.deepEqual(by.get('p4-6'), { id: 'p4-6', status: 'ok', comment: '', operations: ['лазерная резка', 'рифлёный лист 3 мм'], suggestions: [] });
});

await test('вопрос «подтвердите N шт» не задаётся и после исправления по документу заказа (reason с именем файла)', () => {
  const input = {
    summary: 's',
    positions: [
      { id: 'p4-2', status: 'problem', comment: 'По text.txt 5 шт, в расчёте 1 шт.', operations: [], suggestions: [{ kind: 'qty', reason: 'по text.txt: «НГЭН.745535.0021-01 - 5 шт — 995 руб/шт»', value: 5 }] },
    ],
    questions: ['Подтвердите количество НГЭН.745535.0021-01 — 5 шт?'],
  };
  const c = ctx();
  c.documents = [{ fileName: 'text.txt', text: 'НГЭН.745535.0021-01 - 5 шт — 995 руб/шт (из стали 08пс)' }];
  assert.deepEqual(sanitizeAnalysis(input, c, meta).questions, []);
  // такого документа в заказе нет — имя файла в reason ничего не подтверждает
  assert.deepEqual(sanitizeAnalysis(input, ctx(), meta).questions, input.questions);
});

await test('buildAttention: замечание ИИ из одних подтверждений не показывается (и в сохранённом анализе), id — по исходному тексту', () => {
  const book: PriceBook = JSON.parse(readFileSync(new URL('../public/prices.json', import.meta.url), 'utf8'));
  const settings = structuredClone(DEFAULT_SETTINGS);
  const plate = (id: string, name: string) => ({ ...manualPosition({ name, materialId: 'st3', thickness: 2, qty: 5, width: 300, height: 200, holes: 2, holeD: 10, bends: 0 }), id });
  const ps = [plate('a', 'A'), plate('b', 'B'), plate('c', 'C'), plate('d', 'D')];
  const reviews: AiAnalysis['positions'] = [
    { id: 'a', status: 'problem', comment: 'В заявке 5 шт, в расчёте 5 шт — верно', operations: [], suggestions: [] },
    { id: 'b', status: 'check', comment: REAL.p0004, operations: [], suggestions: [] },
    { id: 'c', status: 'problem', comment: 'Заявка 5 шт, в расчёте 5 шт', operations: [], suggestions: [{ id: 'c#1', kind: 'material', materialId: '08ps', reason: 'штамп: ГОСТ 19904' }] },
    { id: 'd', status: 'problem', comment: REAL.p1201, operations: [], suggestions: [] },
  ];
  const analysis: AiAnalysis = { summary: 's', confidence: 'medium', positions: reviews, questions: [], risks: [], recommendations: [], model: 'test', createdAt: '2026-10-17T00:00:00Z', durationMs: 1 };
  const aiState = aiStateFrom(analysis, ps, 'h');
  const order: Order = { ...emptyOrder(), title: 'Тест', positions: ps, ai: aiState };
  const eff = effectivePositions(ps, aiState);
  const res = computeOrder(eff, book, orderSettings(order, settings));
  const att = buildAttention({ order, positions: eff, res, baseRes: res, book, settings, live: false, priceIssue: null, aiContext: null, outdated: false });
  const items = att.items.filter((x) => x.kind === 'aiProblem' || x.kind === 'aiCheck');
  assert.ok(!items.some((x) => x.positionId === 'a'), 'только подтверждение — замечания нет');
  const b = items.find((x) => x.positionId === 'b');
  assert.equal(b?.title, 'B — По заявке из двух частей, чертёж допускает');
  assert.equal(b?.id.startsWith('ai:b:'), true);
  assert.equal(b?.id, `ai:b:${cyrb53('check' + REAL.p0004).toString(36)}`);
  // подтверждение и предложение — замечание с предложением, заголовок по умолчанию
  const c = items.find((x) => x.positionId === 'c');
  assert.equal(c?.title, 'C — ИИ нашёл проблему');
  assert.equal(c?.severity, 'problem');
  // расхождение — как было
  assert.equal(items.find((x) => x.positionId === 'd')?.title, 'D — В заявке 5 шт, в расчёте 1 шт');
  assert.equal(att.counts.problem, 2);
});

await test('usage и fallback из meta — в анализе (токены целые, ₽ до 4 знаков); без них — полей нет', () => {
  const a = sanitizeAnalysis({ summary: 's' }, ctx(), { ...meta, usage: { promptTokens: 1000.4, completionTokens: -5, costRub: 0.27 + 0.05 }, fallback: true });
  assert.deepEqual(a.usage, { promptTokens: 1000, completionTokens: 0, costRub: 0.32 });
  assert.equal(a.fallback, true);
  assert.equal(sanitizeAnalysis({ summary: 's' }, ctx(), { ...meta, usage: { promptTokens: 1, completionTokens: 2, costRub: Number.NaN } }).usage?.costRub, null);
  const plain = sanitizeAnalysis({ summary: 's' }, ctx(), meta);
  assert.ok(!('usage' in plain) && !('fallback' in plain));
});

await test('схема ответа: у предложения сначала kind и reason, потом числа; вид disable есть', () => {
  const s = AI_RESPONSE_SCHEMA.properties.positions.items.properties.suggestions.items;
  assert.deepEqual(Object.keys(s.properties).slice(0, 2), ['kind', 'reason']);
  assert.deepEqual(Object.keys(s.properties), ['kind', 'reason', 'materialId', 'value', 'label', 'perPiece']);
  assert.ok((s.properties.kind.enum as readonly string[]).includes('disable'));
  // strict json_schema: все свойства обязательны
  assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort());
});

await test('не объект — ошибка; мусор в полях — пустые значения', () => {
  assert.throws(() => sanitizeAnalysis('строка', ctx(), meta), /не объект/);
  assert.throws(() => sanitizeAnalysis([1, 2], ctx(), meta), /не объект/);
  const a = sanitizeAnalysis({ summary: 5, positions: 'нет', questions: { a: 1 } }, ctx(), meta);
  assert.equal(a.summary, '5');
  assert.deepEqual([a.positions, a.questions, a.risks, a.recommendations], [[], [], [], []]);
});

// ---------- проверка AiContext ----------
console.log('validateContext');

await test('фикстура проходит проверку', () => {
  const c = ai.validateContext({ context: ctx() });
  assert.equal(c.positions.length, fixture.positions.length);
});

await test('неверная версия, нет context, пустые позиции', async () => {
  await rejectsHttp(() => ai.validateContext({ context: { ...ctx(), version: 2 } }), 400, /Версия данных для ИИ \(2\)/);
  await rejectsHttp(() => ai.validateContext({}), 400, /context/);
  await rejectsHttp(() => ai.validateContext({ context: { ...ctx(), positions: [] } }), 400, /positions/);
});

await test('размеры по AI_LIMITS', async () => {
  const c1 = ctx();
  c1.positions[0].drawingText = 'т'.repeat(1501);
  await rejectsHttp(() => ai.validateContext({ context: c1 }), 400, /drawingText/);
  const c2 = ctx();
  c2.positions = Array.from({ length: 151 }, (_, i) => ({ ...c2.positions[0], id: `x${i}` }));
  await rejectsHttp(() => ai.validateContext({ context: c2 }), 400, /positions/);
  const c3 = ctx();
  c3.positions[1].id = c3.positions[0].id;
  await rejectsHttp(() => ai.validateContext({ context: c3 }), 400, /уникальная/);
  const c4 = ctx();
  c4.documents = Array.from({ length: 8 }, (_, i) => ({ fileName: `${i}.txt`, text: 'д'.repeat(6000) }));
  c4.order.request = 'з'.repeat(8000);
  c4.positions.forEach((p) => (p.drawingText = 'ч'.repeat(1500)));
  await rejectsHttp(() => ai.validateContext({ context: c4 }), 400, /вместе длиннее/);
  const c5 = ctx();
  c5.documents = [{ fileName: 'a.txt', text: 'д'.repeat(6001) }];
  await rejectsHttp(() => ai.validateContext({ context: c5 }), 400, /documents\[0\]/);
  await rejectsHttp(() => ai.validateContext({ context: withImages(ctx(), 13) }), 400, /images/);
  const c6 = withImages(ctx(), 2);
  c6.images[1].index = 0;
  await rejectsHttp(() => ai.validateContext({ context: c6 }), 400, /images\[1\]\.index/);
  const c7 = withImages(ctx(), 1);
  c7.images[0].positionId = 'нет такой';
  await rejectsHttp(() => ai.validateContext({ context: c7 }), 400, /positionId/);
  const c8 = ctx();
  (c8.groups[0] as unknown as Record<string, unknown>).junk = 'x'.repeat(20_000);
  await rejectsHttp(() => ai.validateContext({ context: c8 }), 400, /длинная строка/);
});

// ---------- тело запроса ----------
console.log('readRaw');

const fakeReq = (chunks: Buffer[], headers: Record<string, string> = {}) => Object.assign(Readable.from(chunks), { headers }) as unknown as IncomingMessage;

await test('тело в пределах лимита', async () => {
  const b = await readRaw(fakeReq([Buffer.from('аб'), Buffer.from('в')]), 100);
  assert.equal(b.toString('utf8'), 'абв');
});

await test('Content-Length больше лимита — 413 без чтения', async () => {
  await rejectsHttp(() => readRaw(fakeReq([Buffer.alloc(10)], { 'content-length': '2000000' }), 900_000), 413, /Слишком большой/);
});

await test('поток без Content-Length больше лимита — 413', async () => {
  const big = Array.from({ length: 4 }, () => Buffer.alloc(300_000, 1));
  await rejectsHttp(() => readRaw(fakeReq(big), 900_000), 413);
});

// ---------- обновление цен и ответы API (без mc.ru: запросы с верными парами сюда не попадают) ----------
console.log('API: /api/prices/refresh и ошибки');

await test('refreshPairs: строки, NaN, чужие материалы, вне 0,1…100 мм — не пары; ничего не осталось — 400', async () => {
  const none = /Не указаны толщины для обновления цен/;
  const bodies: unknown[] = [
    {},
    [],
    null,
    'st3',
    { pairs: [] },
    { pairs: 'st3' },
    { pairs: [5] },
    { pairs: [['st3', '2#']] },
    { pairs: [['st3', '../../alyuminievyj_list/r1/2#']] },
    { pairs: [['st3', Number.NaN]] },
    { pairs: [['st3', null]] },
    { pairs: [['st3', '2']] },
    { pairs: [['нет-такого', 2]] },
    { pairs: [[null, 2]] },
    { pairs: [['__proto__', 2]] },
    { pairs: [['st3', 0.05]] },
    { pairs: [['st3', 101]] },
    { pairs: [['st3', Number.POSITIVE_INFINITY]] },
  ];
  for (const body of bodies) await rejectsHttp(() => api.refreshPairs(body), 400, none);
  // своя толщина из интерфейса (2,7 мм) остаётся; до 3 знаков; повторы и мусор между парами отбрасываются
  assert.deepEqual(
    api.refreshPairs({ pairs: [['st3', 2], ['st3', '2#'], ['amg2', 2.7], ['st3', 2.0000001], 'мусор', ['08ps', 1.23456], ['st3', 2]] }),
    [
      ['st3', 2],
      ['amg2', 2.7],
      ['08ps', 1.235],
    ],
  );
  assert.deepEqual(api.refreshPairs({ pairs: [['st3', 0.1], ['st3', 100]] }), [
    ['st3', 0.1],
    ['st3', 100],
  ]);
  // больше 40 пар — первые 40
  const many = Array.from({ length: 60 }, (_, i) => ['st3', 1 + i / 10]);
  const got = api.refreshPairs({ pairs: many });
  assert.equal(got.length, api.REFRESH_MAX_PAIRS);
  assert.equal(got.length, 40);
  assert.deepEqual(got[39], ['st3', 4.9]);
});

await test('mc.ts: толщина не число — строки mc.ru не подходят, на mc.ru не ходим', async () => {
  const mc = await import('../server/mc.ts');
  const { MATERIAL_BY_ID } = await import('../src/core/materials.ts');
  const st3 = MATERIAL_BY_ID.get('st3')!;
  const rows = [
    { name: 'Лист г/к 2х1250х2500', mark: 'Ст3сп', base: 'Санкт-Петербург, Пушкин', price: 70000 },
    { name: 'Лист г/к 3х1500х6000', mark: 'Ст3сп', base: 'Санкт-Петербург, Пушкин', price: 69000 },
  ];
  assert.equal(mc.rowsToItems(st3, 2, rows, 't', 'speterburg').length, 1);
  assert.deepEqual(mc.rowsToItems(st3, Number.NaN, rows, 't', 'speterburg'), []);
  assert.deepEqual(mc.rowsToItems(st3, '2#' as unknown as number, rows, 't', 'speterburg'), []);
  const fetchWas = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    throw new Error('сеть в тесте не нужна');
  }) as typeof fetch;
  try {
    const base = { updatedAt: '2026-10-01T00:00:00Z', region: 'Санкт-Петербург', materials: { st3: [{ t: 2, w: 1250, l: 2500, pricePerKg: 70, name: 'x', mark: 'Ст3' }] } };
    const bad = [['st3', Number.NaN], ['st3', '2#'], ['st3', 0], ['st3', -2], ['нет', 2]] as unknown as [string, number][];
    const r = await mc.refreshPrices(base, bad);
    assert.equal(calls, 0);
    assert.deepEqual([r.book.materials, r.book.updatedAt, r.errors], [base.materials, base.updatedAt, []]);
  } finally {
    globalThis.fetch = fetchWas;
  }
});

/** Ответ handleApi: код, заголовки и тело */
function fakeRes() {
  const r = {
    status: 0,
    headers: {} as Record<string, string>,
    body: '',
    headersSent: false,
    writeHead(status: number, headers: Record<string, string> = {}) {
      Object.assign(r, { status, headers, headersSent: true });
      return r;
    },
    end(b?: string) {
      r.body = b ?? '';
      return r;
    },
  };
  return r;
}
const call = async (req: Readable, method: string, url: string, headers: Record<string, string> = {}) => {
  const res = fakeRes();
  await api.handleApi(Object.assign(req, { method, url, headers, socket: { remoteAddress: '127.0.0.1' } }) as unknown as IncomingMessage, res as unknown as ServerResponse);
  return { status: res.status, body: res.body, json: (res.body ? JSON.parse(res.body) : null) as { error?: string } | null };
};

await test('POST /api/prices/refresh: неверное тело — 400/413 по-русски, без обхода mc.ru; чужая ошибка — 500 без её текста', async () => {
  const post = (body: string, headers: Record<string, string> = {}) => call(Readable.from([Buffer.from(body)]), 'POST', '/api/prices/refresh', headers);
  for (const body of ['{}', 'null', '{"pairs":[]}', '{"pairs":[5]}', '{"pairs":[["st3","2#"]]}']) {
    const r = await post(body);
    assert.deepEqual([r.status, r.json?.error], [400, 'Не указаны толщины для обновления цен'], body);
  }
  for (const body of ['не json', '']) {
    const r = await post(body);
    assert.deepEqual([r.status, r.json?.error], [400, 'Тело запроса — не JSON'], body);
  }
  const big = await post(JSON.stringify({ pairs: [['st3', 'x'.repeat(20_000)]] }));
  assert.equal(big.status, 413);
  assert.match(big.json?.error ?? '', /Слишком большой запрос/);
  // ошибка не HttpError (здесь — обрыв чтения тела): в лог, наружу — общий текст
  const broken = Readable.from(
    (async function* () {
      yield Buffer.from('{"pairs":');
      throw new Error('секрет: /app/data/prices.json EACCES');
    })(),
  );
  const log = console.error;
  console.error = () => {};
  try {
    const r = await call(broken, 'POST', '/api/prices/refresh');
    assert.deepEqual([r.status, r.json?.error], [500, 'Внутренняя ошибка сервера']);
    assert.ok(!/секрет|EACCES/.test(r.body));
  } finally {
    console.error = log;
  }
});

// ---------- промпт ----------
console.log('buildPrompt');

await test('плейсхолдеры заполнены, «$» в данных не ломает замену', () => {
  const c = ctx();
  c.order.request = 'Цена $& и $1, шаблон {{today}}';
  const p = ai.buildPrompt(c);
  assert.ok(!/\{\{\w+\}\}/.test(p.system), 'в системном сообщении остался плейсхолдер');
  assert.ok(p.system.includes('"08ps"') && p.system.includes('Порошковая покраска'));
  assert.ok(!p.system.includes('<!--'), 'комментарии шаблона не уходят в модель');
  assert.ok(p.user.includes('Цена $& и $1, шаблон {{today}}'), 'данные вставлены как есть');
  assert.ok(p.user.includes('"p4-1"') && !p.user.includes('"materials"'));
  assert.equal(p.parts, null);
});

await test('промпт: шаблон и пример ответа — в порядке схемы (kind, reason, …), пример — корректный JSON с disable', () => {
  const sys = ai.buildPrompt(ctx()).system;
  const order = Object.keys(AI_RESPONSE_SCHEMA.properties.positions.items.properties.suggestions.items.properties);
  const objs = [...sys.matchAll(/\{"kind": [^{}]*\}/g)].map((m) => m[0]);
  assert.ok(objs.length >= 5, `предложений в шаблоне и примере: ${objs.length}`);
  for (const o of objs) assert.deepEqual(Object.keys(JSON.parse(o)), order, o);
  assert.match(objs[0], /"kind": "material\|thickness\|qty\|bends\|extra\|disable"/);
  const example = JSON.parse(/^\{"summary": "Заказ из 4.*$/m.exec(sys)?.[0] ?? '{}') as { positions?: { suggestions: { kind: string }[] }[] };
  assert.ok(example.positions?.some((p) => p.suggestions.some((s) => s.kind === 'disable')), 'в примере есть disable');
});

await test('обозначения в заявке: исполнения различаются, латиница = кириллица, пометки имени файла не мешают', () => {
  const c = ctx();
  const m = ai.requestMatches(c);
  assert.match(m, /- p4-4 НГЭН\.А86\.11\.13\.0002: в заявке клиента: «НГЭН\.А86\.11\.13\.0002 - 5 шт\.»\n/);
  assert.match(m, /- p4-5 НГЭН\.А86\.11\.13\.0002-01: в заявке клиента: «НГЭН\.А86\.11\.13\.0002-01 - 5 шт\.»\n/);
  assert.match(m, /- p4-7 НГЭН\.А86\.11\.11\.1201-01: не найдено/);
  c.order.request = 'Прошу счёт: HГЭH.745421.0001 — 3 шт (латинские H), НГЭН.745421.00012 — 1 шт';
  c.documents = [{ fileName: 'спец.txt', text: 'Поз. 1  нгэн.745421.0001  кол-во 2' }];
  assert.match(
    ai.requestMatches(c),
    /- p4-1 НГЭН\.745421\.0001: в заявке клиента: «Прошу счёт: HГЭH\.745421\.0001 — 3 шт \(латинские H\), НГЭН\.745421\.00012 — 1 шт»; в документе «спец\.txt»: «Поз\. 1 {2}нгэн\.745421\.0001 {2}кол-во 2»/,
  );
  assert.equal(ai.requestMatches({ ...c, order: { ...c.order, request: '' }, documents: [] }), 'Заявки и документов нет — сверять количество не с чем.');
  assert.match(ai.buildPrompt(ctx()).user, /Обозначения позиций в заявке и документах:\n- p4-1 НГЭН\.745421\.0001: в заявке клиента: «НГЭН\.745421\.0001 - 5 шт\.»/);
});

await test('документ — не заявка клиента: подсказки и таблица называют файл (прайс цеха projects/4 text.txt)', () => {
  const c = ctx();
  c.order.request = '';
  c.documents = [
    {
      fileName: 'text.txt',
      text: 'НГЭН.745535.0021-01 - 1 шт — 995 руб/шт (из стали 08пс)\nНГЭН.А86.11.11.1201 - 5 шт — 2553 руб/шт (из стали 08пс)\nНГЭН.999.0001 - 2 шт — 100 руб/шт',
    },
  ];
  const h = ai.positionHints(c);
  // количество из документа учитывается, но называется документом
  assert.match(h, /- p4-3 НГЭН\.А86\.11\.11\.1201: в документе «text\.txt» 5 шт \(«НГЭН\.А86\.11\.11\.1201 - 5 шт — 2553 руб\/шт \(из стали 08пс\)»\), а в расчёте qty = 1 \(в файлах количества нет\)/);
  assert.match(h, /- p4-2 НГЭН\.745535\.0021-01: в документе «text\.txt» 1 шт \(«[^»]+»\) — как в расчёте, но в файлах количества не было: предложи qty 1 \(подтверждение по документу «text\.txt»\)/);
  assert.match(h, /- p4-7 НГЭН\.А86\.11\.11\.1201-01: документ «text\.txt» называет НГЭН\.А86\.11\.11\.1201 \(«НГЭН\.А86\.11\.11\.1201 - 5 шт — 2553 руб\/шт \(из стали 08пс\)»\), а это исполнение — нет/);
  assert.match(h, /- p4-1 НГЭН\.745421\.0001: [^\n]*обозначения нет ни в заявке, ни в документах — спроси клиента/);
  assert.ok(!/заявк[аеи] клиента|в заявке \d/.test(h), `документ назван заявкой:\n${h}`);
  const m = ai.requestMatches(c);
  assert.match(m, /- p4-3 НГЭН\.А86\.11\.11\.1201: в документе «text\.txt»: «НГЭН\.А86\.11\.11\.1201 - 5 шт — 2553 руб\/шт \(из стали 08пс\)»/);
  assert.match(m, /нет позиции \(чертёж не приложен — вопрос клиенту\): в документе «text\.txt»: «НГЭН\.999\.0001 - 2 шт — 100 руб\/шт»/);
  assert.ok(!/заявке клиента/.test(m), m);
  // та же строка и в заявке клиента: подсказка — по заявке (она первая), в таблице — оба источника
  c.order.request = 'НГЭН.А86.11.11.1201 - 5 шт';
  assert.match(ai.positionHints(c), /- p4-3 НГЭН\.А86\.11\.11\.1201: в заявке клиента 5 шт \(«НГЭН\.А86\.11\.11\.1201 - 5 шт»\), а в расчёте qty = 1/);
  assert.match(ai.requestMatches(c), /- p4-3 НГЭН\.А86\.11\.11\.1201: в заявке клиента: «НГЭН\.А86\.11\.11\.1201 - 5 шт»; в документе «text\.txt»: «НГЭН\.А86\.11\.11\.1201 - 5 шт/);
});

await test('подсказки программы: количество из заявки, материал по штампу, гибка, составная деталь', () => {
  const h = ai.positionHints(ctx());
  assert.match(h, /- p4-1 НГЭН\.745421\.0001: штамп понят как «08пс х\/к» \(08ps\), а в расчёте st3; не помещается в лист, режется из 2 частей; чертёж допускает составную/);
  assert.match(h, /- p4-2 НГЭН\.745535\.0021-01: в заявке клиента 5 шт \(«НГЭН\.745535\.0021-01 - 5 шт»\), а в расчёте qty = 1 \(в файлах количества нет\)\n/);
  assert.match(h, /- p4-3 НГЭН\.А86\.11\.11\.1201: в заявке клиента 5 шт .*; признак гибки в тексте чертежа «3 Неуказанные радиусы гибов R=2 мм», а bends = 0; у p4-7 НГЭН\.А86\.11\.11\.1201-01 \(тот же чертёж\) найдено гибов: 3/);
  assert.match(h, /- p4-4 НГЭН\.А86\.11\.13\.0002: \(не замечание, в ответ не включай\) помещается в выбранный лист целиком/);
  // лист PDF «-01» без своего файла, а заявка называет только базовую деталь — вероятно, не заказан: disable + вопрос
  assert.match(
    h,
    /- p4-7 НГЭН\.А86\.11\.11\.1201-01: заявка клиента называет НГЭН\.А86\.11\.11\.1201 \(«НГЭН\.А86\.11\.11\.1201 - 5 шт»\), а это исполнение — нет, и своего файла у него нет \(лист PDF того же чертежа\): вероятно, не заказано — дай предложение исключить позицию из расчёта \(kind disable; .*\) и вопрос клиенту/,
  );
  assert.ok(!/p4-7[^\n]*обозначения нет ни в заявке/.test(h), 'общий вопрос вместо disable не нужен');
  assert.ok(!/^- p4-5 /m.test(h), h); // по ней простые проверки молчат
  // без заявки зеркальную «-01» не трогаем: левые и правые детали часто заказывают парой
  assert.ok(!/^- p4-7 /m.test(ai.positionHints({ ...ctx(), order: { ...fixture.order, request: '' } })));
});

await test('подсказки: базовое исполнение без своего файла и точный дубль — предложение disable', () => {
  // чертёж с таблицей исполнений: базовое — лист PDF, у исполнения -0700 свой DXF
  const c = ctx();
  c.order.request = '';
  c.positions[2].name = 'НГЭН.А86.11.11.1201-0700'; // p4-3, dxf
  const base = c.positions[6]; // p4-7, pdf
  base.name = 'НГЭН.А86.11.11.1201';
  base.drawingText = 'Штамп: НГЭН.А86.11.11.1201 «Лист опоры»\nТаблица: Обозначение | L, мм | Масса, кг\nНГЭН.А86.11.11.1201 | 100 | 1,2\n-0700 | 700 | 8,6';
  const hint = (x: AiContext) => /^- p4-7 .*$/m.exec(ai.positionHints(x))?.[0] ?? '';
  assert.match(
    hint(c),
    /в заказе файлы исполнений этого чертежа \(-0700\), а эта позиция — базовое исполнение по таблице \(«НГЭН\.А86\.11\.11\.1201 \| 100 \| 1,2»\) без своего файла, заявки и документов нет: вероятно, не заказано — дай предложение исключить позицию из расчёта \(kind disable/,
  );
  c.order.request = 'НГЭН.А86.11.11.1201-0700 — 2 шт.';
  assert.match(hint(c), /, заявка клиента называет -0700, а эта позиция — базовое исполнение .* его нет ни в заявке, ни в документах: вероятно, не заказано/);
  assert.ok(!/обозначения нет ни в заявке/.test(hint(c)));
  // исполнения называет не заявка, а документ заказа — так и сказано
  c.order.request = '';
  c.documents = [{ fileName: 'спецификация.txt', text: 'НГЭН.А86.11.11.1201-0700 — 2 шт.' }];
  assert.match(hint(c), /, документ «спецификация\.txt» называет -0700, а эта позиция — базовое исполнение .* его нет ни в заявке, ни в документах/);
  c.documents = [];
  c.order.request = 'НГЭН.А86.11.11.1201 — 1 шт., НГЭН.А86.11.11.1201-0700 — 2 шт.';
  assert.ok(!/disable/.test(hint(c)), 'базовое названо в заявке — заказано');
  c.order.request = '';
  base.disabled = true;
  assert.equal(hint(c), '', 'исключённые позиции не правим');

  // дубль: тот же чертёж под другим именем файла; поровну данных — исключить вторую из пары
  const d = ctx();
  d.positions.push({ ...structuredClone(d.positions[3]), id: 'p4-8', name: 'НГЭН.А86.11.13.0002', fileName: 'НГЭН.А86.11.13.0002.dxf' });
  const hd = ai.positionHints(d);
  assert.match(
    hd,
    /- p4-8 НГЭН\.А86\.11\.13\.0002: .*повторяет p4-4 НГЭН\.А86\.11\.13\.0002: то же обозначение и та же геометрия, материал и толщина, файлы «НГЭН\.А86\.11\.13\.0002 st3 s3mm rifleniy 5sht\.dxf» и «НГЭН\.А86\.11\.13\.0002\.dxf», в расчёте 5 и 5 шт — вероятно, один чертёж загружен дважды: дай предложение исключить эту позицию \(kind disable; reason — эта проверка\), количество для неё не предлагай — p4-4 остаётся в расчёте/,
  );
  assert.ok(!/^- p4-4 [^\n]*повторяет/m.test(hd), 'первая из пары — не дубль');
  d.positions[7].geometry.widthMm += 5;
  assert.ok(!/повторяет/.test(ai.positionHints(d)), 'другой габарит — другая деталь');

  // копия из файла без пометок стоит первой: материал и толщина по умолчанию, штампа нет — исключить её, а не полную
  const e = ctx();
  const bare = { ...structuredClone(e.positions[3]), id: 'p4-0', name: 'НГЭН.А86.11.13.0002', fileName: 'НГЭН.А86.11.13.0002.dxf', materialId: 'st3', thickness: 2, qty: 1 };
  bare.guessed = { material: true, thickness: true, qty: true };
  delete bare.titleBlock;
  delete bare.drawingText;
  e.positions.unshift(bare);
  const he = ai.positionHints(e);
  assert.match(he, /- p4-0 НГЭН\.А86\.11\.13\.0002: повторяет p4-4 НГЭН\.А86\.11\.13\.0002: то же обозначение и та же геометрия, файлы /);
  assert.ok(!/^- p4-0 [^\n]*в заявке клиента 5 шт/m.test(he), 'строка заявки — у позиции, которая остаётся');
  assert.ok(!/^- p4-4 [^\n]*повторяет/m.test(he), he);
  bare.guessed.material = false; // материал найден и другой — это другая деталь
  assert.ok(!/повторяет/.test(ai.positionHints(e)));
  assert.match(ai.positionHints(e), /^- p4-0 [^\n]*в заявке клиента 5 шт/m, 'не дубль — количество из заявки подсказывается');
});

await test('изображения — частями сообщения с подписями', () => {
  const c = withImages(ctx(), 2);
  const p = ai.buildPrompt(c, new Map([[1, { data: jpeg(), mime: 'image/jpeg' }]]));
  assert.equal(p.images, 1);
  assert.equal(p.parts?.length, 3);
  assert.match(JSON.stringify(p.parts?.[1]), /Изображение 1: чертёж 1/);
  assert.match((p.parts?.[2] as { image_url: { url: string } }).image_url.url, /^data:image\/jpeg;base64,\/9j\//);
});

// ---------- задачи (LLM_MOCK) ----------
console.log('задачи (заглушка LLM_MOCK)');

const L = ai.AI_SERVER_LIMITS;
const saved = { ...L };
const reset = () => {
  ai.resetAiJobsForTests();
  Object.assign(L, saved);
  process.env.LLM_MOCK = '1';
  process.env.LLM_MOCK_DELAY_MS = '20';
  delete process.env.LLM_VISION;
};

await test('статус и задача без изображений: queued → running → done', async () => {
  reset();
  assert.deepEqual(await ai.aiStatus(), { configured: true, model: 'mock', vision: false });
  const { jobId, imagesExpected } = await ai.createJob({ context: ctx() }, '10.0.0.1');
  assert.equal(imagesExpected, 0);
  assert.match(jobId, /^[0-9a-f-]{36}$/);
  assert.ok(['queued', 'running'].includes(ai.getJob(jobId).status));
  const s = await waitDone(jobId);
  assert.equal(s.status, 'done');
  if (s.status !== 'done') return;
  assert.equal(s.analysis.model, 'mock');
  assert.deepEqual(s.analysis.positions[0].suggestions[0], { id: 'p4-1#1', kind: 'qty', value: 6, reason: 'проверка применения предложений' });
  // заглушка советует исключить последнюю позицию — вид disable проходит весь путь сервера
  assert.deepEqual(s.analysis.positions.at(-1), {
    id: 'p4-7',
    status: 'check',
    comment: '',
    operations: [],
    suggestions: [{ id: 'p4-7#1', kind: 'disable', reason: 'заглушка: проверка предложения «Исключить из расчёта»' }],
  });
  // расход и «резервная модель» — в самом анализе (браузер получает только его) и, как раньше, рядом
  assert.ok(s.usage && s.usage.promptTokens > 1000);
  assert.deepEqual(s.analysis.usage, s.usage);
  assert.equal(s.analysis.usage?.costRub, 0);
  assert.equal(s.analysis.fallback, false);
  assert.deepEqual(Object.keys(s.analysis).slice(-2), ['usage', 'fallback']);
});

await test('задача с изображениями: ждёт, проверяет номер, тип и размер', async () => {
  reset();
  process.env.LLM_VISION = 'on';
  const { jobId, imagesExpected } = await ai.createJob({ context: withImages(ctx(), 2) }, '10.0.0.2');
  assert.equal(imagesExpected, 2);
  assert.deepEqual(ai.getJob(jobId), { status: 'waiting', imagesReceived: 0, imagesExpected: 2 });
  await rejectsHttp(() => ai.putImage(jobId, 5, jpeg()), 400, /не заявлено/);
  await rejectsHttp(() => ai.putImage(jobId, 0, Buffer.from('<html>не картинка</html>')), 415);
  await rejectsHttp(() => ai.putImage(jobId, 0, jpeg(900_001)), 413);
  ai.putImage(jobId, 0, jpeg());
  ai.putImage(jobId, 0, jpeg(3000)); // повтор того же номера заменяет изображение
  assert.deepEqual(ai.getJob(jobId), { status: 'waiting', imagesReceived: 1, imagesExpected: 2 });
  ai.putImage(jobId, 1, jpeg());
  assert.ok(['queued', 'running'].includes(ai.getJob(jobId).status));
  assert.equal((await waitDone(jobId)).status, 'done');
  await rejectsHttp(() => ai.putImage(jobId, 1, jpeg()), 409);
});

await test('модель без зрения: изображения не ждём, PUT принимается и игнорируется', async () => {
  reset();
  process.env.LLM_VISION = 'off';
  const { jobId, imagesExpected } = await ai.createJob({ context: withImages(ctx(), 2) }, '10.0.0.3');
  assert.equal(imagesExpected, 0);
  ai.putImage(jobId, 0, jpeg());
  assert.equal((await waitDone(jobId)).status, 'done');
  await rejectsHttp(() => ai.getJob('нет-такой'), 404);
});

await test('отмена: в очереди и во время запроса к модели', async () => {
  reset();
  process.env.LLM_MOCK_DELAY_MS = '400';
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await ai.createJob({ context: ctx() }, '10.0.0.4')).jobId);
  assert.equal(ai.getJob(ids[0]).status, 'running');
  assert.equal(ai.getJob(ids[1]).status, 'running');
  assert.deepEqual(ai.getJob(ids[2]), { status: 'queued', position: 1 });
  ai.cancelJob(ids[2]);
  assert.deepEqual(ai.getJob(ids[2]), { status: 'error', error: 'Анализ отменён' });
  ai.cancelJob(ids[0]);
  assert.deepEqual(await waitDone(ids[0], 300), { status: 'error', error: 'Анализ отменён' });
  assert.equal((await waitDone(ids[1])).status, 'done');
});

await test('очередь полна — 429 «Сервер ИИ занят»', async () => {
  reset();
  process.env.LLM_MOCK_DELAY_MS = '300';
  for (let i = 0; i < L.concurrency + L.queue; i++) await ai.createJob({ context: ctx() }, `10.1.0.${i}`);
  await rejectsHttp(() => ai.createJob({ context: ctx() }, '10.1.1.1'), 429, /занят/);
  reset();
});

await test('лимит задач с одного адреса в час — 429', async () => {
  reset();
  L.perIpHour = 3;
  for (let i = 0; i < 3; i++) await ai.createJob({ context: ctx() }, '10.2.0.1');
  await rejectsHttp(() => ai.createJob({ context: ctx() }, '10.2.0.1'), 429, /адреса/);
  await ai.createJob({ context: ctx() }, '10.2.0.2'); // другой адрес — можно
  reset();
});

await test('битый JSON от модели исправляется вторым запросом (LLM_MOCK=broken)', async () => {
  reset();
  process.env.LLM_MOCK = 'broken';
  const { jobId } = await ai.createJob({ context: ctx() }, '10.3.0.1');
  const s = await waitDone(jobId);
  assert.equal(s.status, 'done', JSON.stringify(s));
});

await test('ошибка модели — понятный текст (LLM_MOCK=fail); не настроен — 503', async () => {
  reset();
  process.env.LLM_MOCK = 'fail';
  const { jobId } = await ai.createJob({ context: ctx() }, '10.4.0.1');
  const s = await waitDone(jobId);
  assert.deepEqual(s, { status: 'error', error: 'Сервис ИИ недоступен (HTTP 502, LLM_MOCK=fail)' });
  const keep = { LLM_BASE_URL: process.env.LLM_BASE_URL, LLM_MODEL: process.env.LLM_MODEL, LLM_API_KEY: process.env.LLM_API_KEY };
  delete process.env.LLM_MOCK;
  delete process.env.LLM_BASE_URL;
  delete process.env.LLM_MODEL;
  delete process.env.LLM_API_KEY;
  try {
    assert.deepEqual(await ai.aiStatus(), { configured: false, model: null, vision: false });
    await rejectsHttp(() => ai.createJob({ context: ctx() }, '10.4.0.2'), 503, /не настроен/);
  } finally {
    for (const [k, v] of Object.entries(keep)) if (v !== undefined) process.env[k] = v;
    reset();
  }
});

await test('неверные данные в POST — 400 до постановки в очередь', async () => {
  reset();
  await rejectsHttp(() => ai.createJob({ context: { ...ctx(), version: 99 } }, '10.5.0.1'), 400, /Версия/);
  await rejectsHttp(() => ai.createJob({ context: { ...ctx(), images: 'много' } }, '10.5.0.1'), 400, /images/);
});

await test('PUT изображения через API: чужой id — 404 и готовая задача — 409 без чтения тела; без зрения в очереди — 204', async () => {
  reset();
  let read = false;
  const lazy = () =>
    new Readable({
      read() {
        read = true;
        this.push(jpeg());
        this.push(null);
      },
    });
  const put = (id: string, n: number) => call(lazy(), 'PUT', `/api/ai/jobs/${id}/images/${n}`, { 'content-type': 'image/jpeg' });
  const unknown = await put('00000000-0000-0000-0000-000000000000', 0);
  assert.equal(unknown.status, 404);
  assert.match(unknown.json?.error ?? '', /не найдена/);
  assert.equal(read, false, 'тело к чужой задаче не читается');
  // модель без зрения: изображения принимаются и выбрасываются, пока задача в очереди или идёт
  process.env.LLM_VISION = 'off';
  process.env.LLM_MOCK_DELAY_MS = '200';
  const { jobId } = await ai.createJob({ context: withImages(ctx(), 2) }, '10.6.0.1');
  assert.ok(['queued', 'running'].includes(ai.getJob(jobId).status));
  assert.equal((await put(jobId, 0)).status, 204);
  assert.equal(read, true);
  await waitDone(jobId);
  read = false;
  const late = await put(jobId, 1);
  assert.deepEqual([late.status, late.json?.error], [409, 'Задача уже не принимает изображения']);
  assert.equal(read, false, 'тело к готовой задаче не читается');
  reset();
});

await test('POST /api/ai/jobs: лимит тела — контекст плюс обёртка {"context":…} (как проверяет браузер)', async () => {
  reset();
  const body = (bytes: number) => {
    const c = ctx();
    c.documents = [{ fileName: 'pad.txt', text: '' }];
    const pad = bytes - Buffer.byteLength(JSON.stringify({ context: c }));
    c.documents[0].text = 'x'.repeat(pad);
    return Buffer.from(JSON.stringify({ context: c }));
  };
  // ровно на пределе браузера (contextBytes + 1000) — не 413 (дальше проверка данных: документ длинный — 400)
  const atClient = await call(Readable.from([body(900_000 + 1000)]), 'POST', '/api/ai/jobs');
  assert.equal(atClient.status, 400);
  assert.match(atClient.json?.error ?? '', /documents\[0\]/);
  const over = await call(Readable.from([body(900_000 + 1025)]), 'POST', '/api/ai/jobs');
  assert.equal(over.status, 413);
});

// ---------- complete(): поддельный шлюз на localhost ----------
console.log('complete() — поддельный шлюз');

const llm = await import('../server/llm.ts');
type Reply = { status?: number; body?: unknown; headers?: Record<string, string>; delayMs?: number };
const seen: { path: string; body: Record<string, unknown> }[] = [];
let replies: Reply[] = [];
let catalog: unknown = { data: [] };
const gw = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (req.method === 'GET' && req.url?.endsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(catalog));
    return;
  }
  seen.push({ path: req.url ?? '', body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') });
  const r = replies.shift() ?? { status: 500, body: { error: { message: 'нет ответа в сценарии' } } };
  if (r.delayMs) await sleep(r.delayMs);
  if (res.destroyed) return;
  res.writeHead(r.status ?? 200, { 'Content-Type': 'application/json', ...r.headers }).end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
});
await new Promise<void>((r) => gw.listen(0, '127.0.0.1', r));
const gwPort = (gw.address() as AddressInfo).port;
const ok = (content: string, model = 'good/model', extra: Record<string, unknown> = {}): Reply => ({
  body: { model, choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 100, cost: 35 }, ...extra },
});
const keepEnv = Object.fromEntries(['LLM_BASE_URL', 'LLM_MODEL', 'LLM_API_KEY', 'LLM_FALLBACK_MODELS', 'LLM_MOCK', 'LLM_VISION', 'LLM_TIMEOUT_MS', 'LLM_JSON'].map((k) => [k, process.env[k]]));
function gateway(env: Record<string, string> = {}) {
  seen.length = 0;
  replies = [];
  delete process.env.LLM_MOCK;
  delete process.env.LLM_VISION;
  delete process.env.LLM_TIMEOUT_MS;
  delete process.env.LLM_JSON;
  // «hubris.pw» в пути — чтобы клиент считал адрес шлюзом (models, reasoning, usage.cost)
  Object.assign(process.env, { LLM_BASE_URL: `http://127.0.0.1:${gwPort}/hubris.pw/v1`, LLM_MODEL: 'dead/model', LLM_API_KEY: 'test-key', LLM_FALLBACK_MODELS: 'good/model', ...env });
}
const msgs: LlmMessage[] = [{ role: 'user', content: 'привет' }];
async function rejectsLlm(fn: () => Promise<unknown>, text: RegExp) {
  await assert.rejects(fn, (e: unknown) => e instanceof llm.LlmError && text.test(e.message));
}

await test('404 model_not_found → модель выкидывается из цепочки; models, reasoning, response_format, usage', async () => {
  gateway();
  replies = [{ status: 404, body: { error: { code: 'model_not_found', message: 'Model dead/model not found' } } }, ok('{"summary":"x"}')];
  const r = await llm.complete({ messages: msgs });
  assert.equal(r.content, '{"summary":"x"}');
  assert.equal(r.model, 'good/model');
  assert.deepEqual(r.usage, { promptTokens: 1000, completionTokens: 100, costRub: 0.35 });
  assert.equal(r.finishReason, 'stop');
  assert.equal(seen.length, 2);
  assert.equal(seen[0].path, '/hubris.pw/v1/chat/completions');
  assert.deepEqual(seen[0].body.models, ['dead/model', 'good/model']);
  assert.deepEqual(seen[0].body.reasoning, { enabled: false });
  assert.deepEqual((seen[0].body.response_format as { json_schema: { name: string; strict: boolean } }).json_schema.name, 'order_analysis');
  assert.equal(seen[1].body.model, 'good/model');
  assert.equal(seen[1].body.models, undefined);
});

await test('резервная модель: ответила не LLM_MODEL (дата версии и префикс провайдера не в счёт); заглушка — никогда', () => {
  const hubris = llm.llmConfig({
    LLM_BASE_URL: 'https://api.hubris.pw/v1',
    LLM_MODEL: 'anthropic/claude-haiku-5.5',
    LLM_API_KEY: 'k',
    LLM_FALLBACK_MODELS: 'nvidia/nemotron-3.5-super-vl:free,google/gemma-4-31b-it:free',
  });
  assert.equal(llm.isFallbackModel('anthropic/claude-haiku-5.5', hubris), false);
  assert.equal(llm.isFallbackModel('nvidia/nemotron-3.5-super-vl:free', hubris), true);
  assert.equal(llm.isFallbackModel('google/gemma-4-31b-it:free', hubris), true);
  assert.equal(llm.isFallbackModel('claude-haiku-5.5-20261001', hubris), false);
  assert.equal(llm.isFallbackModel('', hubris), false);
  assert.equal(llm.isFallbackModel('mock', llm.llmConfig({ LLM_MOCK: '1' })), false);
  const openai = llm.llmConfig({ LLM_BASE_URL: 'https://api.openai.com/v1', LLM_MODEL: 'gpt-4o-mini', LLM_API_KEY: 'k' });
  assert.equal(llm.isFallbackModel('gpt-4o-mini-2024-07-18', openai), false);
  assert.equal(llm.isFallbackModel('gpt-4o', openai), true);
});

await test('анализ через шлюз: ответила резервная модель → fallback; usage в анализе; схема — kind, reason первыми', async () => {
  const answer = JSON.stringify({
    summary: 'Проверка',
    confidence: 'high',
    positions: [{ id: 'p4-7', status: 'check', comment: 'Исполнения -01 нет в заявке.', operations: [], suggestions: [dis('в заявке только «НГЭН.А86.11.11.1201 - 5 шт»')] }],
    questions: ['Нужно ли исполнение -01?'],
    risks: [],
    recommendations: [],
  });
  gateway(); // основная dead/model снята, отвечает good/model из LLM_FALLBACK_MODELS
  replies = [{ status: 404, body: { error: { code: 'model_not_found', message: 'Model dead/model not found' } } }, ok(answer, 'good/model')];
  const r = await ai.analyzeContext(ctx());
  assert.equal(r.analysis.model, 'good/model');
  assert.equal(r.analysis.fallback, true);
  assert.deepEqual(r.analysis.usage, { promptTokens: 1000, completionTokens: 100, costRub: 0.35 });
  assert.deepEqual(r.usage, r.analysis.usage);
  assert.deepEqual(r.analysis.positions[0].suggestions, [{ id: 'p4-7#1', kind: 'disable', reason: 'в заявке только «НГЭН.А86.11.11.1201 - 5 шт»' }]);
  type Sent = { json_schema: { schema: typeof AI_RESPONSE_SCHEMA } };
  const sent = (seen[0].body.response_format as Sent).json_schema.schema.properties.positions.items.properties.suggestions.items.properties;
  assert.deepEqual(Object.keys(sent).slice(0, 2), ['kind', 'reason']);
  // ответила сама основная модель — не резервная
  gateway({ LLM_MODEL: 'good/model', LLM_FALLBACK_MODELS: 'other/model:free' });
  replies = [ok(answer, 'good/model')];
  assert.equal((await ai.analyzeContext(ctx())).analysis.fallback, false);
});

await test('400 из-за response_format → один повтор без него; LLM_JSON=object', async () => {
  gateway({ LLM_MODEL: 'good/model', LLM_FALLBACK_MODELS: '' });
  replies = [{ status: 400, body: { error: { code: 'invalid_request', message: 'response_format json_schema is not supported by this model' } } }, ok('{}')];
  await llm.complete({ messages: msgs });
  assert.equal(seen.length, 2);
  assert.ok(seen[0].body.response_format && !seen[1].body.response_format);
  gateway({ LLM_MODEL: 'good/model', LLM_JSON: 'object' });
  replies = [ok('{}')];
  await llm.complete({ messages: msgs });
  assert.deepEqual(seen[0].body.response_format, { type: 'json_object' });
});

await test('429 с retry-after → один повтор; лимит ключа и 401/402 — без повтора', async () => {
  gateway({ LLM_MODEL: 'good/model' });
  replies = [{ status: 429, headers: { 'retry-after': '1' }, body: { error: { message: 'rate-limited upstream' } } }, ok('{}')];
  const t0 = Date.now();
  await llm.complete({ messages: msgs });
  assert.ok(Date.now() - t0 >= 950, 'ждал retry-after');
  assert.equal(seen.length, 2);
  gateway({ LLM_MODEL: 'good/model' });
  replies = [{ status: 429, headers: { 'retry-after': '36000' }, body: { error: { code: 'daily_limit_exceeded', message: 'Daily limit' } } }];
  await rejectsLlm(() => llm.complete({ messages: msgs }), /суточный/);
  assert.equal(seen.length, 1);
  gateway({ LLM_MODEL: 'good/model' });
  replies = [{ status: 401, body: { error: { code: 'invalid_api_key', message: 'Missing API key' } } }];
  await rejectsLlm(() => llm.complete({ messages: msgs }), /LLM_API_KEY/);
  replies = [{ status: 402, body: { error: { code: 'insufficient_balance' } } }];
  await rejectsLlm(() => llm.complete({ messages: msgs }), /балансе/);
  assert.equal(seen.length, 2);
});

await test('5xx дважды → понятная ошибка; пустой ответ → повтор', async () => {
  gateway({ LLM_MODEL: 'good/model' });
  replies = [{ status: 502, body: { error: { code: 'upstream_error' } } }, { status: 502, body: { error: { code: 'upstream_error' } } }];
  await rejectsLlm(() => llm.complete({ messages: msgs }), /недоступен \(HTTP 502\)/);
  assert.equal(seen.length, 2);
  gateway({ LLM_MODEL: 'good/model' });
  replies = [ok(''), ok('{"summary":"второй"}')];
  assert.equal((await llm.complete({ messages: msgs })).content, '{"summary":"второй"}');
});

await test('изображения: в цепочке остаются модели со зрением; нет таких — изображения убираются', async () => {
  catalog = { data: [{ id: 'text/only', input_modalities: ['text'] }, { id: 'eyes/model', input_modalities: ['text', 'image'], pricing: { input_rub_per_million: 10, output_rub_per_million: 50 } }] };
  const withImg: LlmMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'чертёж' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }] }];
  gateway({ LLM_MODEL: 'text/only', LLM_FALLBACK_MODELS: 'eyes/model' });
  replies = [ok('{}', 'eyes/model')];
  await llm.complete({ messages: withImg });
  assert.equal(seen[0].body.model, 'eyes/model');
  assert.ok(Array.isArray((seen[0].body.messages as LlmMessage[])[0].content));
  assert.equal(await llm.visionEnabled(), false); // основная модель без зрения
  gateway({ LLM_MODEL: 'text/only', LLM_FALLBACK_MODELS: '' });
  replies = [ok('{}', 'text/only')];
  await llm.complete({ messages: withImg });
  assert.equal((seen[0].body.messages as LlmMessage[])[0].content, 'чертёж');
});

await test('тайм-аут запроса и отмена задачи', async () => {
  gateway({ LLM_MODEL: 'good/model', LLM_TIMEOUT_MS: '5000' });
  replies = [{ ...ok('{}'), delayMs: 6000 }];
  await rejectsLlm(() => llm.complete({ messages: msgs }), /не ответила за 5 с/);
  gateway({ LLM_MODEL: 'good/model' });
  replies = [{ ...ok('{}'), delayMs: 3000 }];
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 200);
  const t0 = Date.now();
  await rejectsLlm(() => llm.complete({ messages: msgs, signal: ctrl.signal }), /отменён/);
  assert.ok(Date.now() - t0 < 1000);
});

await test('нет соединения → два бесплатных повтора и один обычный, потом ошибка', async () => {
  // свободный порт: занять и сразу освободить — соединение будет отклонено (ECONNREFUSED)
  const tmp = createServer();
  await new Promise<void>((r) => tmp.listen(0, '127.0.0.1', r));
  const closed = (tmp.address() as AddressInfo).port;
  await new Promise((r) => tmp.close(r));
  gateway({ LLM_BASE_URL: `http://127.0.0.1:${closed}/v1`, LLM_MODEL: 'good/model' });
  const t0 = Date.now();
  await rejectsLlm(() => llm.complete({ messages: msgs }), /Нет связи с сервисом ИИ/);
  assert.ok(Date.now() - t0 >= 7500, 'паузы 2 + 4 + 2 с');
});

gw.close();
for (const [k, v] of Object.entries(keepEnv)) {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

console.log(`\n${passed} прошло, ${failed} не прошло`);
process.exit(failed ? 1 : 0);
