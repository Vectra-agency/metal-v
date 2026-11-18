// Начальная история из реальных заказов projects/1–4: каждый заказ — как его собирает приложение
// (все файлы папки, кроме счёта; без ИИ), с текущими расценками; счёт цеха — из PDF счёта на оплату
// (у проекта 4 счёта нет — цены за штуку из text.txt). Результат — файл в формате выгрузки истории:
// «История → Загрузить из файла…» в приложении (на проде — после входа).
//   node scripts/seed-history.ts [папка распакованного projects/1/Обработанные.rar] [куда, по умолчанию data/history-seed.json]
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { documentLines } from '../src/core/drawingText.ts';
import { HISTORY_VERSION, invoiceTotals, type HistoryInvoice, type HistoryOrder } from '../src/core/history.ts';
import { autoMatch, parseInvoiceLines } from '../src/core/invoice.ts';
import { readPdf, type PdfJsLike } from '../src/core/pdf.ts';
import { computeOrder, DEFAULT_SETTINGS, type PriceBook } from '../src/core/pricing.ts';
import { historyOrderFrom } from '../src/history/build.ts';
import { emptyOrder, orderSettings, type Order } from '../src/order.ts';
import { pdfFileKey, positionsFromPages } from '../src/pdfImport.ts';
import { importDefaults, parseFiles } from '../src/pipeline.ts';

const ROOT = new URL('../../projects/', import.meta.url).pathname;
const book: PriceBook = JSON.parse(readFileSync(new URL(existsSync(new URL('../data/prices.json', import.meta.url)) ? '../data/prices.json' : '../public/prices.json', import.meta.url), 'utf8'));
const settings = structuredClone(DEFAULT_SETTINGS);
const isInvoice = (f: string) => /^сч[её]т\s+на\s+оплату/i.test(f);

async function load(dir: string, title: string, request = ''): Promise<Order> {
  const names = readdirSync(dir)
    .filter((f) => /\.(dxf|pdf|txt)$/i.test(f) && !isInvoice(f))
    .sort((a, b) => a.localeCompare(b, 'ru'));
  const files = names.map((n) => new File([readFileSync(join(dir, n))], n, { lastModified: Math.round(statSync(join(dir, n)).mtimeMs) }));
  const parsed = await parseFiles(files, { positions: [], request }, importDefaults([]), undefined, {
    importPdf: async (f, defs) => positionsFromPages(await readPdf(pdfjs as unknown as PdfJsLike, await f.arrayBuffer()), f.name, pdfFileKey(f), defs),
  });
  // количества из заявки parseFiles уже проставил (как в приложении)
  return { ...emptyOrder(), title, positions: parsed.positions, documents: parsed.documents, requestLines: parsed.requestLines, request };
}

function history(o: Order, id: string, at: string): HistoryOrder {
  const res = computeOrder(o.positions, book, orderSettings(o, settings));
  const h = historyOrderFrom(o, o.positions, res, id);
  return { ...h, createdAt: at, updatedAt: at };
}

async function invoiceFrom(dir: string, h: HistoryOrder): Promise<HistoryInvoice> {
  const name = readdirSync(dir).find(isInvoice)!;
  const pages = await readPdf(pdfjs as unknown as PdfJsLike, readFileSync(join(dir, name)).buffer as ArrayBuffer);
  const inv = parseInvoiceLines(documentLines(pages));
  if (!inv) throw new Error(`${name}: не счёт`);
  const ids = autoMatch(inv.items, h.parts);
  return { ...inv, fileName: name, addedAt: h.updatedAt, lines: inv.items.map((it, i) => ({ ...it, partIds: ids[i] })) };
}

const orders: HistoryOrder[] = [];
const dir1 = process.argv[2];

if (dir1 && existsSync(dir1)) {
  const o = await load(dir1, 'НГ-Энерго, заявка 17.09.2026 — металл и резка (гибка отдельным счётом ≈ 300 тыс.)');
  const h = history(o, 'seed-p1-9444', '2026-09-22T09:00:00.000Z');
  // счёт за металл и резку; гибка по нему не выставлена — сверка по строкам «материал + резка»
  h.invoice = await invoiceFrom(join(ROOT, '1'), h);
  orders.push(h);
} else console.warn('Проект 1 пропущен: передайте папку распакованного projects/1/Обработанные.rar первым аргументом');

{
  const o = await load(join(ROOT, '2'), 'НГЭН.745428.0003 Короб защитный', 'НГЭН.745428.0003-0700 — 5 шт\nНГЭН.745428.0003-1700 — 10 шт');
  const h = history(o, 'seed-p2-9885', '2026-10-05T09:00:00.000Z');
  h.invoice = await invoiceFrom(join(ROOT, '2'), h);
  orders.push(h);
}
{
  const o = await load(join(ROOT, '3'), 'Блок ввода кабеля и блок выхода сброса (МИЛП)');
  const h = history(o, 'seed-p3-467', '2026-08-03T09:00:00.000Z');
  h.invoice = await invoiceFrom(join(ROOT, '3'), h);
  orders.push(h);
}
{
  // счёта нет: цены за штуку из переписки (text.txt) — как строки счёта «N шт × цена»
  const dir = join(ROOT, '4');
  const o = await load(dir, 'НГЭН, 6 деталей по 5 шт (цены из переписки)');
  const at = new Date(statSync(join(dir, 'text.txt')).mtimeMs).toISOString();
  const h = history(o, 'seed-p4-text', at);
  const rows = readFileSync(join(dir, 'text.txt'), 'utf8')
    .split('\n')
    .map((l) => /^(\S+)\s*-\s*(\d+)\s*шт\.?\s*—\s*(\d+)\s*руб\/шт\s*(.*)$/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => !!m);
  const items = rows.map((m, i) => ({ n: i + 1, text: `${m[1]} ${m[4]}`.trim(), qty: Number(m[2]), unit: 'шт', price: Number(m[3]), sum: Number(m[2]) * Number(m[3]) }));
  const ids = autoMatch(items, h.parts);
  h.invoice = {
    supplier: 'Цены из переписки (text.txt)',
    number: '',
    date: at.slice(0, 10),
    total: items.reduce((a, i) => a + i.sum, 0),
    fileName: 'text.txt',
    addedAt: at,
    lines: items.map((it, i) => ({ ...it, partIds: ids[i] })),
  };
  orders.push(h);
}

for (const h of orders) {
  const t = invoiceTotals(h);
  const free = h.invoice!.lines.filter((l) => !l.partIds.length).length;
  const d = t.fact ? Math.round(((t.calc - t.fact) / t.fact) * 100) : 0;
  console.log(
    `${h.id.padEnd(14)} ${String(h.parts.length).padStart(3)} дет.  счёт ${Math.round(t.fact).toLocaleString('ru-RU').padStart(9)}  расчёт ${Math.round(t.calc).toLocaleString('ru-RU').padStart(9)}  ${d >= 0 ? '+' : ''}${d}%${free ? `  (строк без деталей: ${free})` : ''}`,
  );
}

const out = process.argv[3] ?? new URL('../data/history-seed.json', import.meta.url).pathname;
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ version: HISTORY_VERSION, exportedAt: new Date().toISOString(), orders }, null, 1));
console.log(`\n${orders.length} заказов → ${out}\nЗагрузить: «История» → «Загрузить из файла…»`);
