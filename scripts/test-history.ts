// Тесты истории заказов и входа: node scripts/test-history.ts [папка с распакованным projects/1/Обработанные.rar]
// Разбор счетов цехов (реальные PDF из projects/), к каким деталям относятся строки, факт по счёту,
// поиск той же детали и похожих, хранилище на сервере через HTTP (во временной папке), подсказка для ИИ,
// вход по паролю (cookie, форма, 401, перебор).
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { AiContext } from '../src/core/ai.ts';
import { documentLines } from '../src/core/drawingText.ts';
import { designationKey, findMatches, invoiceTotals, lineCalc, partFacts, remapInvoice, summaryOf, type HistoryOrder } from '../src/core/history.ts';
import { autoMatch, lineMaterial, lineThickness, looksLikeInvoice, money, parseInvoiceLines } from '../src/core/invoice.ts';
import { readPdf, type PdfJsLike } from '../src/core/pdf.ts';
import { computeOrder, DEFAULT_SETTINGS, type PriceBook } from '../src/core/pricing.ts';
import { historyHash, historyOrderFrom, matchQueries, orderFromHistory, positionsFromHistory, recalcHistory } from '../src/history/build.ts';
import { emptyOrder, orderSettings, type Order } from '../src/order.ts';
import { pdfFileKey, positionsFromPages } from '../src/pdfImport.ts';
import { importDefaults, parseFiles } from '../src/pipeline.ts';
import { AUTH_COOKIE, authGate, loginPage, passwordOk, resetAuthForTests, safeNext, signToken, verifyToken, type AuthConfig } from '../server/auth.ts';
import { handleHistory, historyNote, setHistoryDir } from '../server/history.ts';

const ROOT = new URL('../../projects/', import.meta.url).pathname;
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

async function pdfLines(path: string): Promise<string[]> {
  return documentLines(await readPdf(pdfjs as unknown as PdfJsLike, readFileSync(path).buffer as ArrayBuffer));
}

/** Заказ так, как его собирает приложение из папки (без счёта, без ИИ) */
async function loadOrder(dir: string, request = ''): Promise<Order> {
  const names = readdirSync(dir)
    .filter((f) => /\.(dxf|pdf|txt)$/i.test(f) && !/сч[её]т\s+на\s+оплату/i.test(f))
    .sort((a, b) => a.localeCompare(b, 'ru'));
  const files = names.map((n) => new File([readFileSync(join(dir, n))], n, { lastModified: Math.round(statSync(join(dir, n)).mtimeMs) }));
  const parsed = await parseFiles(files, { positions: [], request }, importDefaults([]), undefined, {
    importPdf: async (f, defs) => positionsFromPages(await readPdf(pdfjs as unknown as PdfJsLike, await f.arrayBuffer()), f.name, pdfFileKey(f), defs),
  });
  return { ...emptyOrder(), positions: parsed.positions, documents: parsed.documents, requestLines: parsed.requestLines, request };
}

function historyOf(o: Order, id: string, title: string): HistoryOrder {
  const res = computeOrder(o.positions, book, orderSettings(o, settings));
  return historyOrderFrom({ ...o, title }, o.positions, res, id);
}

const invoicePdf = (n: string) => join(ROOT, n, readdirSync(join(ROOT, n)).find((f) => /^Сч[её]т на оплату/i.test(f))!);

// ---------- разбор счёта ----------

console.log('Разбор счёта на оплату');

await test('деньги и признак счёта', () => {
  assert.equal(money('58 630,00'), 58630);
  assert.equal(money('2 384,50'), 2384.5);
  assert.equal(money('62,53'), 62.53);
  assert.ok(looksLikeInvoice('Счет на оплату № 1 от 1 января 2026 г.\nИтого: | 10,00'));
  assert.ok(!looksLikeInvoice('Прошу счёт: НГЭН.745421.0001 — 5 шт'));
});

await test('№ 9444 «Лазерная резка СПб»: 7 строк, наборы пластин по материалу и толщине', async () => {
  const inv = parseInvoiceLines(await pdfLines(invoicePdf('1')))!;
  assert.equal(inv.number, '9444');
  assert.equal(inv.date, '2026-09-22');
  assert.equal(inv.supplier, 'ООО "ЛАЗЕРНАЯ РЕЗКА СПБ"');
  assert.equal(inv.total, 798020);
  assert.equal(inv.vat, 143905.25);
  assert.equal(inv.items.length, 7);
  assert.deepEqual(
    inv.items.map((i) => [i.n, i.qty, i.unit, i.sum, lineMaterial(i.text), lineThickness(i.text)]),
    [
      [1, 1, 'компл', 58630, '09g2s', 10],
      [2, 20, 'шт', 47690, '09g2s', 20],
      [3, 1, 'компл', 59350, 'st3', 1.5],
      [4, 1, 'компл', 190710, 'st3', 2],
      [5, 1, 'компл', 398480, 'st3', 3],
      [6, 95, 'шт', 5940, 'st3', 6],
      [7, 1, 'компл', 37220, 'st3', 10],
    ],
  );
  assert.equal(inv.items.reduce((a, i) => a + i.sum, 0), inv.total);
});

await test('№ 9885: наименование на двух строках склеивается', async () => {
  const inv = parseInvoiceLines(await pdfLines(invoicePdf('2')))!;
  assert.equal(inv.number, '9885');
  assert.equal(inv.date, '2026-10-05');
  assert.equal(inv.items.length, 2);
  assert.match(inv.items[0].text, /^НГЭН\.745428\.0003-0700 .*толщиной 3мм, с гибкой$/);
  assert.deepEqual(
    inv.items.map((i) => [i.qty, i.price, i.sum]),
    [
      [5, 6394, 31970],
      [10, 10204, 102040],
    ],
  );
});

await test('№ 467 МИЛП: детали и покупка листа', async () => {
  const inv = parseInvoiceLines(await pdfLines(invoicePdf('3')))!;
  assert.equal(inv.supplier, 'ООО "МИЛП"');
  assert.equal(inv.number, '467');
  assert.equal(inv.date, '2026-08-03');
  assert.equal(inv.total, 17087);
  assert.equal(inv.items.length, 5);
  assert.equal(inv.items[2].text, 'Лист г/к 1,5, х100х2500, Ст3');
});

await test('не счёт — null; текст без разделителей ячеек тоже читается', () => {
  assert.equal(parseInvoiceLines(['Прошу счёт', 'НГЭН.745421.0001 — 5 шт']), null);
  const inv = parseInvoiceLines(['Счет на оплату № 12-А от 03.02.2026', '1 Кронштейн АБВ.123.456 2 шт. 1 200,00 2 400,00', 'Итого: 2 400,00'])!;
  assert.equal(inv.number, '12-А');
  assert.equal(inv.date, '2026-02-03');
  assert.deepEqual([inv.items[0].qty, inv.items[0].unit, inv.items[0].price, inv.items[0].sum], [2, 'шт', 1200, 2400]);
});

// ---------- строки счёта ↔ детали ----------

console.log('Строки счёта и детали');

const p2 = await loadOrder(join(ROOT, '2'), 'НГЭН.745428.0003-0700 — 5 шт\nНГЭН.745428.0003-1700 — 10 шт');
const h2 = historyOf(p2, 'test-p2-0001', 'Короб защитный');
const p3 = await loadOrder(join(ROOT, '3'));
const h3 = historyOf(p3, 'test-p3-0001', 'Блоки МИЛП');

await test('П2: строки по обозначению, базовое исполнение не цепляется', async () => {
  const inv = parseInvoiceLines(await pdfLines(invoicePdf('2')))!;
  const ids = autoMatch(inv.items, h2.parts);
  const names = ids.map((x) => x.map((id) => h2.parts.find((p) => p.id === id)!.name));
  assert.deepEqual(names, [['НГЭН.745428.0003-0700'], ['НГЭН.745428.0003-1700']]);
});

await test('П3: блоки — по обозначению, «Лист г/к 1,5» — ни к чему', async () => {
  const inv = parseInvoiceLines(await pdfLines(invoicePdf('3')))!;
  const ids = autoMatch(inv.items, h3.parts);
  assert.equal(ids[0].length, 1);
  assert.equal(designationKey(h3.parts.find((p) => p.id === ids[0][0])!.name), designationKey('БВк-400х340.00.000'));
  assert.equal(ids[1].length, 1);
  assert.equal(designationKey(h3.parts.find((p) => p.id === ids[1][0])!.name), designationKey('БВС-305Х300.000'));
  assert.deepEqual(ids.slice(2), [[], [], []]);
});

await test('строка на группу: «из Ст3 толщиной 3мм» — и рифлёный Ст3, и обычный; 09Г2С — только 09Г2С', () => {
  const parts = [
    { id: 'a', name: 'А.001', materialId: 'st3', thickness: 3, qty: 1 },
    { id: 'b', name: 'А.002', materialId: 'rifl', thickness: 3, qty: 1 },
    { id: 'c', name: 'А.003', materialId: '09g2s', thickness: 3, qty: 1 },
    { id: 'd', name: 'А.004', materialId: 'st3', thickness: 2, qty: 1 },
    { id: 'e', name: 'А.005', materialId: 'st3', thickness: 3, qty: 1, disabled: true },
  ];
  const ids = autoMatch([{ text: 'Набор пластин по чертежу из Ст3 толщиной 3мм' }, { text: 'Пластина по чертежу из 09г2с толщиной 3мм' }], parts);
  assert.deepEqual(ids, [['a', 'b'], ['c']]);
});

await test('факт по счёту: штучная строка — цена штуки, групповая — доля по расчёту', () => {
  const o: HistoryOrder = structuredClone(h2);
  const [a, b] = o.parts.filter((p) => !p.disabled);
  o.invoice = {
    supplier: 'Цех',
    number: '1',
    date: '2026-10-05',
    total: 134010,
    fileName: 'x.pdf',
    addedAt: new Date().toISOString(),
    lines: [{ n: 1, text: 'x', qty: 5, unit: 'шт', price: 6394, sum: 31970, partIds: [a.id] }],
  };
  assert.equal(partFacts(o).get(a.id)?.piece, 6394);
  // группа: сумма строки делится по нашему расчёту, в сумме — вся строка
  o.invoice.lines = [{ n: 1, text: 'набор', qty: 1, unit: 'компл', price: 1000, sum: 1000, partIds: [a.id, b.id] }];
  const f = partFacts(o);
  const total = f.get(a.id)!.piece * a.qty + f.get(b.id)!.piece * b.qty;
  assert.ok(Math.abs(total - 1000) < 1e-6);
  assert.ok(f.get(a.id)!.shared);
  assert.equal(lineCalc(o, o.invoice.lines[0]), a.calc!.total * a.qty + b.calc!.total * b.qty);
  const t = invoiceTotals(o);
  assert.equal(t.fact, 1000);
  assert.equal(t.unmatched, 0);
});

// ---------- поиск той же детали и похожих ----------

console.log('Поиск в истории');

await test('ключ обозначения: с цифрами — есть, «Пластина 200×100» — нет', () => {
  assert.equal(designationKey('НГЭН.745428.0003-0700 amg2 s3mm'), 'НГЭН.745428.0003-0700');
  assert.equal(designationKey('HГЭH.745428.0003-0700'), 'НГЭН.745428.0003-0700'); // латиница-двойник
  assert.equal(designationKey('Пластина 200×100'), null);
  assert.equal(designationKey('Деталь-1'), null);
});

await test('та же деталь в прошлом заказе: факт по счёту, свой заказ не находится', async () => {
  const inv = parseInvoiceLines(await pdfLines(invoicePdf('2')))!;
  const ids = autoMatch(inv.items, h2.parts);
  const saved: HistoryOrder = { ...h2, invoice: { ...inv, fileName: 'счёт.pdf', addedAt: new Date().toISOString(), lines: inv.items.map((it, i) => ({ ...it, partIds: ids[i] })) } };
  const res = computeOrder(p2.positions, book, orderSettings(p2, settings));
  const q = matchQueries(p2.positions, res);
  const found = findMatches(q, [saved, h3]);
  const id0700 = p2.positions.find((p) => p.name === 'НГЭН.745428.0003-0700')!.id;
  const m = found[id0700]?.find((x) => x.kind === 'same');
  assert.ok(m, 'нашлась та же деталь');
  assert.equal(m.fact, 6394);
  assert.equal(m.invoiceNumber, '9885');
  assert.equal(m.supplier, 'ООО "ЛАЗЕРНАЯ РЕЗКА СПБ"');
  assert.deepEqual(findMatches(q, [saved], saved.id), {});
});

await test('похожая деталь — только с фактом, тот же материал и толщина, габарит в пределах 30 %', () => {
  const o: HistoryOrder = structuredClone(h2);
  const part = o.parts.find((p) => !p.disabled)!;
  const q = { id: 'q', name: 'Новая деталь', materialId: part.materialId, thickness: part.thickness, width: part.geom.width * 1.1, height: part.geom.height * 0.95, cutM: (part.geom.cutLength / 1000) * 1.05, bends: part.bends, qty: 3 };
  assert.deepEqual(findMatches([q], [o]), {}, 'без счёта похожие не ищем');
  o.invoice = { supplier: '', number: '5', date: '2026-10-01', total: 100, fileName: '', addedAt: '', lines: [{ n: 1, text: 'x', qty: part.qty, unit: 'шт', price: 100, sum: 100 * part.qty, partIds: [part.id] }] };
  const ms = findMatches([q], [o]).q;
  assert.equal(ms?.length, 1);
  assert.equal(ms[0].kind, 'similar');
  assert.equal(ms[0].fact, 100);
  assert.deepEqual(findMatches([{ ...q, thickness: part.thickness + 1 }], [o]), {});
  assert.deepEqual(findMatches([{ ...q, width: part.geom.width * 2 }], [o]), {});
});

await test('заказ ↔ история: отпечаток, повторное открытие, пересчёт по текущим расценкам', () => {
  const res = computeOrder(p2.positions, book, orderSettings(p2, settings));
  const o = orderFromHistory(h2);
  assert.equal(o.positions.length, h2.parts.length);
  assert.equal(o.history?.id, h2.id);
  assert.equal(historyHash(o, o.positions), o.history?.hash, 'открытый заказ не «изменён»');
  const changed = { ...o, positions: o.positions.map((p, i) => (i ? p : { ...p, qty: p.qty + 1 })) };
  assert.notEqual(historyHash(changed, changed.positions), o.history?.hash);
  const now = recalcHistory(h2, book, settings);
  for (const p of h2.parts.filter((x) => x.calc)) assert.ok(Math.abs(now.get(p.id)! - res.positions.get(p.id)!.piece.total) < 0.01, p.name);
  const s = summaryOf(h2);
  assert.equal(s.parts, h2.parts.filter((p) => !p.disabled).length);
});

await test('строки счёта переходят на детали с тем же обозначением после повторной загрузки файлов', () => {
  const o: HistoryOrder = structuredClone(h2);
  const [a, b] = o.parts.filter((p) => !p.disabled);
  const inv = { supplier: '', number: '1', date: null, total: 1, fileName: '', addedAt: '', lines: [{ n: 1, text: 'x', qty: 1, unit: 'шт', price: 1, sum: 1, partIds: [a.id, b.id] }] };
  const parts = o.parts.map((p) => ({ ...p, id: `new-${p.id}` }));
  assert.deepEqual(remapInvoice(inv, o.parts, parts).lines[0].partIds, [`new-${a.id}`, `new-${b.id}`]);
  assert.deepEqual(remapInvoice(inv, o.parts, parts.filter((p) => p.name !== a.name)).lines[0].partIds, [`new-${b.id}`], 'детали больше нет — строка без неё');
  assert.deepEqual(positionsFromHistory(o).map((p) => p.id), o.parts.map((p) => p.id), 'открытый из истории заказ — с теми же id');
});

// ---------- хранилище на сервере (HTTP) ----------

console.log('История на сервере');

const dir = mkdtempSync(join(tmpdir(), 'metal-history-'));
setHistoryDir(dir);

interface Res {
  status: number;
  headers: Record<string, string>;
  body: string;
  json: () => any;
}

function fakeReq(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): IncomingMessage {
  const raw = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
  return Object.assign(Readable.from(raw), { method, url, headers, socket: { remoteAddress: '127.0.0.1' } }) as unknown as IncomingMessage;
}

function fakeRes(): { res: ServerResponse; out: Res } {
  const out: Res = { status: 0, headers: {}, body: '', json: () => JSON.parse(out.body) };
  const res = {
    headersSent: false,
    writeHead(code: number, h: Record<string, string> = {}) {
      out.status = code;
      for (const [k, v] of Object.entries(h)) out.headers[k.toLowerCase()] = String(v);
      this.headersSent = true;
      return this;
    },
    end(b?: string | Buffer) {
      if (b) out.body += b.toString();
    },
  };
  return { res: res as unknown as ServerResponse, out };
}

async function api(method: string, path: string, body?: unknown): Promise<Res> {
  const { res, out } = fakeRes();
  try {
    await handleHistory(fakeReq(method, path, body), res, path);
  } catch (e) {
    const err = e as { status?: number; message: string };
    out.status = err.status ?? 500;
    out.body = JSON.stringify({ error: err.message });
  }
  return out;
}

await test('сохранить, список, открыть', async () => {
  const r = await api('PUT', `/api/history/${h2.id}`, { ...h2, invoice: undefined });
  assert.equal(r.status, 201, r.body);
  assert.equal(r.json().id, h2.id);
  assert.ok(existsSync(join(dir, 'history.json')));
  assert.equal((await api('PUT', `/api/history/${h3.id}`, h3)).status, 201);
  const list = (await api('GET', '/api/history')).json().orders;
  assert.deepEqual(
    list.map((o: { id: string }) => o.id),
    [h3.id, h2.id],
  );
  assert.equal(list[1].title, 'Короб защитный');
  assert.equal((await api('GET', `/api/history/${h2.id}`)).json().parts.length, h2.parts.length);
});

await test('счёт к заказу; повторное сохранение заказа счёт не стирает', async () => {
  const inv = parseInvoiceLines(await pdfLines(invoicePdf('2')))!;
  const ids = autoMatch(inv.items, h2.parts);
  const invoice = { ...inv, fileName: 'Счет.pdf', addedAt: new Date().toISOString(), lines: inv.items.map((it, i) => ({ ...it, partIds: [...ids[i], 'чужая-деталь'] })) };
  const r = await api('PUT', `/api/history/${h2.id}/invoice`, invoice);
  assert.equal(r.status, 200, r.body);
  assert.deepEqual(r.json().invoice.lines[0].partIds, ids[0], 'чужие id отброшены');
  const again = await api('PUT', `/api/history/${h2.id}`, { ...h2, invoice: undefined, title: 'Короб защитный (изм.)' });
  assert.equal(again.json().invoice.number, '9885');
  assert.equal(again.json().title, 'Короб защитный (изм.)');
  const s = (await api('GET', '/api/history')).json().orders.find((o: { id: string }) => o.id === h2.id);
  assert.equal(s.invoice.fact, 134010);
  assert.ok(s.invoice.calc > 0);
});

await test('пересохранение с новыми id деталей (файлы загружены заново) — счёт остаётся привязан', async () => {
  const cur = (await api('GET', `/api/history/${h2.id}`)).json() as HistoryOrder;
  const parts = cur.parts.map((p) => ({ ...p, id: `re-${p.id}` }));
  const r = await api('PUT', `/api/history/${h2.id}`, { ...cur, invoice: undefined, parts });
  assert.equal(r.status, 200, r.body);
  const lines = r.json().invoice.lines as { partIds: string[] }[];
  assert.ok(lines.every((l) => l.partIds.length === 1 && l.partIds[0].startsWith('re-')), JSON.stringify(lines.map((l) => l.partIds)));
  // вернуть как было — дальше тесты ищут по прежним id
  const back = await api('PUT', `/api/history/${h2.id}`, { ...cur, invoice: undefined });
  assert.ok((back.json().invoice.lines as { partIds: string[] }[]).every((l) => l.partIds.length === 1 && !l.partIds[0].startsWith('re-')));
});

await test('поиск через API: та же деталь из другого заказа', async () => {
  const res = computeOrder(p2.positions, book, orderSettings(p2, settings));
  const r = await api('POST', '/api/history/match', { parts: matchQueries(p2.positions, res), exclude: 'другой-заказ' });
  assert.equal(r.status, 200, r.body);
  const id = p2.positions.find((p) => p.name === 'НГЭН.745428.0003-1700')!.id;
  assert.equal(r.json().matches[id][0].fact, 10204);
  const self = await api('POST', '/api/history/match', { parts: matchQueries(p2.positions, res), exclude: h2.id });
  assert.equal(self.json().matches[id], undefined);
});

await test('проверка данных: чужой материал, пустые детали, плохой id — 400/404', async () => {
  const badMat = await api('PUT', '/api/history/test-bad-0001', { ...h3, parts: [{ ...h3.parts[0], materialId: 'unobtainium' }] });
  assert.equal(badMat.status, 400);
  assert.match(badMat.json().error, /материал/);
  assert.equal((await api('PUT', '/api/history/test-bad-0002', { ...h3, parts: [] })).status, 400);
  assert.equal((await api('PUT', '/api/history/x', h3)).status, 404, 'короткий id');
  assert.equal((await api('PUT', '/api/history/test-bad-0003', '{не json')).status, 400);
  assert.equal((await api('GET', '/api/history/test-none-0001')).status, 404);
});

await test('выгрузка и загрузка: более новые записи не затираются', async () => {
  const exp = (await api('GET', '/api/history/export')).json();
  assert.equal(exp.orders.length, 2);
  const old = { ...exp.orders[0], title: 'старое', updatedAt: '2020-01-01T00:00:00.000Z' };
  const fresh = { ...h2, id: 'test-imp-0001', updatedAt: '2026-11-01T00:00:00.000Z' };
  const r = (await api('POST', '/api/history/import', { orders: [old, fresh, { id: '!' }] })).json();
  assert.deepEqual([r.added, r.updated, r.skipped], [1, 0, 2]);
  assert.equal((await api('GET', '/api/history/test-imp-0001')).json().updatedAt, '2026-11-01T00:00:00.000Z');
});

await test('удаление возвращает заказ (для «Вернуть»); резервная копия за день', async () => {
  const r = await api('DELETE', '/api/history/test-imp-0001');
  assert.equal(r.status, 200);
  assert.equal(r.json().id, 'test-imp-0001');
  assert.equal((await api('GET', '/api/history/test-imp-0001')).status, 404);
  const backups = readdirSync(join(dir, 'history-backups'));
  assert.equal(backups.length, 1);
  assert.match(backups[0], /^history-\d{4}-\d{2}-\d{2}\.json$/);
});

await test('подсказка ИИ: та же деталь и цена по счёту; свой заказ исключён', () => {
  const ctx: AiContext = JSON.parse(readFileSync(new URL('./fixtures/context-p4.json', import.meta.url), 'utf8'));
  assert.equal(historyNote(ctx), 'Совпадений с прошлыми заказами нет.');
  const p = ctx.positions[0];
  p.name = 'НГЭН.745428.0003-1700';
  const note = historyNote(ctx);
  assert.match(note, /НГЭН\.745428\.0003-1700 \(id p4-1\): та же деталь, АМг2 рифл\. 3 мм, 10 шт — счёт № 9885 ООО "ЛАЗЕРНАЯ РЕЗКА СПБ" от 05\.10\.2026: цех взял 10 204 ₽\/шт/);
  assert.match(note, /сейчас по расчёту 2 646 ₽\/шт \(−74% к счёту\)/);
  assert.equal(historyNote(ctx, h2.id), 'Совпадений с прошлыми заказами нет.');
});

rmSync(dir, { recursive: true, force: true });

// ---------- вход по паролю ----------

console.log('Вход по паролю');

const PW = 'секрет-пароль';
const on: AuthConfig = { password: PW, required: true };

async function gate(cfg: AuthConfig, method: string, url: string, opts: { body?: string; headers?: Record<string, string> } = {}): Promise<{ handled: boolean; out: Res }> {
  const { res, out } = fakeRes();
  const handled = await authGate(fakeReq(method, url, opts.body, opts.headers), res, cfg);
  return { handled, out };
}

await test('подпись cookie: верная, истёкшая, подделанная, после смены пароля', () => {
  const now = Math.floor(Date.now() / 1000);
  const t = signToken(PW, now + 100);
  assert.equal(verifyToken(PW, t, now), now + 100);
  assert.equal(verifyToken(PW, signToken(PW, now - 1), now), null, 'истекла');
  assert.equal(verifyToken(PW, t.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')), now), null, 'подпись испорчена');
  assert.equal(verifyToken(PW, t.replace(/v1\.\d+/, `v1.${now + 99999}`), now), null, 'продлить срок нельзя');
  assert.equal(verifyToken('другой', t, now), null, 'пароль сменили');
  assert.equal(verifyToken(PW, undefined, now), null);
  assert.ok(passwordOk(PW, PW));
  assert.ok(!passwordOk(PW, `${PW} `));
});

await test('куда вернуть после входа — только путь этого сайта', () => {
  assert.equal(safeNext('/#metal'), '/#metal');
  assert.equal(safeNext('//evil.example'), '/');
  assert.equal(safeNext('/\\evil'), '/');
  assert.equal(safeNext('https://evil.example'), '/');
  assert.equal(safeNext('/api/history'), '/');
});

await test('без пароля (не прод) — всё открыто; /api/auth/status: вход выключен', async () => {
  const off: AuthConfig = { password: null, required: false };
  assert.equal((await gate(off, 'GET', '/')).handled, false);
  assert.equal((await gate(off, 'GET', '/api/history')).handled, false);
  const st = await gate(off, 'GET', '/api/auth/status');
  assert.deepEqual(st.out.json(), { enabled: false, expiresAt: null });
});

await test('без входа: страница — форма входа (401), API — 401 JSON, health — открыт', async () => {
  const page = await gate(on, 'GET', '/?x=1');
  assert.ok(page.handled);
  assert.equal(page.out.status, 401);
  assert.match(page.out.body, /<form method="post" action="\/api\/auth\/login">/);
  assert.match(page.out.body, /name="next" value="\/\?x=1"/);
  assert.equal(page.out.headers['x-auth-required'], '1');
  const apiR = await gate(on, 'GET', '/api/history');
  assert.equal(apiR.out.status, 401);
  assert.equal(apiR.out.json().auth, 'required');
  const asset = await gate(on, 'GET', '/assets/index-abc.js');
  assert.equal(asset.out.status, 401);
  assert.doesNotMatch(asset.out.body, /<form/);
  assert.equal((await gate(on, 'GET', '/api/health')).handled, false);
});

await test('вход: неверный пароль — 401 с формой; верный — cookie на 30 дней и возврат', async () => {
  resetAuthForTests();
  const form = { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-proto': 'https' };
  const bad = await gate(on, 'POST', '/api/auth/login', { body: 'password=nope&next=%2F%23metal', headers: form });
  assert.equal(bad.out.status, 401);
  assert.match(bad.out.body, /Неверный пароль/);
  assert.match(bad.out.body, /name="next" value="\/#metal"/);
  const ok = await gate(on, 'POST', '/api/auth/login', { body: `password=${encodeURIComponent(PW)}&next=%2F%23metal`, headers: form });
  assert.equal(ok.out.status, 303);
  assert.equal(ok.out.headers.location, '/#metal');
  const cookie = ok.out.headers['set-cookie'];
  assert.match(cookie, new RegExp(`^${AUTH_COOKIE}=v1\\.\\d+\\.[\\w-]{43}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax; Secure$`));
  const value = cookie.split(';')[0];
  assert.equal((await gate(on, 'GET', '/', { headers: { cookie: value } })).handled, false, 'с cookie пускает');
  assert.equal((await gate(on, 'GET', '/api/history', { headers: { cookie: `x=1; ${value}` } })).handled, false);
  const st = await gate(on, 'GET', '/api/auth/status', { headers: { cookie: value } });
  assert.equal(st.out.json().enabled, true);
  const days = (Date.parse(st.out.json().expiresAt) - Date.now()) / 86_400_000;
  assert.ok(days > 29.9 && days <= 30, `${days} дн.`);
  const out = await gate(on, 'POST', '/api/auth/logout', { headers: { cookie: value } });
  assert.equal(out.out.status, 303);
  assert.match(out.out.headers['set-cookie'], /Max-Age=0/);
});

await test('перебор: после 10 неверных паролей — 429 даже с верным', async () => {
  resetAuthForTests();
  const h = { 'content-type': 'application/json', 'x-real-ip': '10.0.0.9' };
  for (let i = 0; i < 10; i++) assert.equal((await gate(on, 'POST', '/api/auth/login', { body: JSON.stringify({ password: `x${i}` }), headers: h })).out.status, 401);
  const r = await gate(on, 'POST', '/api/auth/login', { body: JSON.stringify({ password: PW }), headers: h });
  assert.equal(r.out.status, 429);
  assert.match(r.out.json().error, /Слишком много неверных попыток/);
  const other = await gate(on, 'POST', '/api/auth/login', { body: JSON.stringify({ password: PW }), headers: { ...h, 'x-real-ip': '10.0.0.10' } });
  assert.equal(other.out.status, 200, 'другой адрес не заблокирован');
  resetAuthForTests();
});

await test('прод без SITE_PASSWORD — закрыт: форма говорит, что пароль не задан', async () => {
  const closed: AuthConfig = { password: null, required: true };
  const page = await gate(closed, 'GET', '/');
  assert.equal(page.out.status, 401);
  assert.match(page.out.body, /не задан пароль входа/);
  assert.doesNotMatch(page.out.body, /<form/);
  const login = await gate(closed, 'POST', '/api/auth/login', { body: JSON.stringify({ password: 'что угодно' }), headers: { 'content-type': 'application/json' } });
  assert.equal(login.out.status, 503);
  assert.match(loginPage({ error: '<script>' }), /&lt;script&gt;/, 'текст ошибки экранируется');
});

// ---------- проект 1 (если распакован) ----------

const dir1 = process.argv[2];
if (dir1 && existsSync(dir1)) {
  console.log('Проект 1 (Обработанные.rar)');
  await test('№ 9444: наборы пластин относятся к группам, все детали в расчёте получают факт', async () => {
    const o = await loadOrder(dir1);
    const h = historyOf(o, 'test-p1-0001', 'П1');
    const inv = parseInvoiceLines(await pdfLines(invoicePdf('1')))!;
    const ids = autoMatch(inv.items, h.parts);
    assert.ok(ids.every((x) => x.length > 0), 'каждая строка к чему-то отнесена');
    const withInv: HistoryOrder = { ...h, invoice: { ...inv, fileName: '', addedAt: '', lines: inv.items.map((it, i) => ({ ...it, partIds: ids[i] })) } };
    const facts = partFacts(withInv);
    const active = h.parts.filter((p) => !p.disabled);
    // нержавейки AISI 321 в этом счёте нет (резали отдельно) — остальные детали получают факт
    const without = active.filter((p) => !facts.has(p.id)).map((p) => p.materialId);
    assert.deepEqual([...new Set(without)], ['aisi321'], 'без факта — только нержавейка');
    assert.ok(Math.abs(invoiceTotals(withInv).fact - inv.total) < 0.01);
    for (const l of withInv.invoice!.lines) {
      const c = lineCalc(withInv, l)!;
      console.log(`      ${l.text.slice(0, 48).padEnd(48)} деталей ${String(l.partIds.length).padStart(3)}  счёт ${Math.round(l.sum).toLocaleString('ru-RU').padStart(9)}  расчёт ${Math.round(c).toLocaleString('ru-RU').padStart(9)}  ${c >= l.sum ? '+' : ''}${Math.round(((c - l.sum) / l.sum) * 100)}%`);
    }
  });
} else console.log('Проект 1 пропущен: передайте папку распакованного projects/1/Обработанные.rar');

console.log(`\n${passed} прошло, ${failed.length} не прошло`);
if (failed.length) {
  console.log(failed.map((f) => `  ✗ ${f}`).join('\n'));
  process.exit(1);
}
