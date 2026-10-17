// Контекст ИИ-анализа для папки заказа — так же, как его собирает приложение:
//   node scripts/build-context.ts <папка> [--request заявка.txt] [--out ctx.json] [--with-invoices] [--prices prices.json]
// DXF/PDF/TXT папки → parseFiles (PDF читается pdfjs-dist/legacy) → computeOrder → buildAiContext.
// Счета цехов («Счет на оплату…») по умолчанию пропускаются: в них готовый ответ, клиент их не присылает.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readPdf, type PdfJsLike } from '../src/core/pdf.ts';
import { computeOrder, DEFAULT_SETTINGS, type PriceBook, type Settings } from '../src/core/pricing.ts';
import { buildAiContext, contextHash } from '../src/ai/context.ts';
import { emptyOrder, orderSettings, type Order } from '../src/order.ts';
import { pdfFileKey, positionsFromPages } from '../src/pdfImport.ts';
import { decodeText, importDefaults, parseFiles } from '../src/pipeline.ts';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const flag = (name: string) => {
  const i = args.indexOf(name);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
};
const requestFile = opt('--request');
const outFile = opt('--out');
const pricesFile = opt('--prices');
const withInvoices = flag('--with-invoices');
const dir = args[0];
if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) {
  console.error('Использование: node scripts/build-context.ts <папка> [--request заявка.txt] [--out ctx.json] [--with-invoices]');
  process.exit(1);
}

const names = readdirSync(dir)
  .filter((f) => /\.(dxf|pdf)$/i.test(f))
  .filter((f) => withInvoices || !/сч[её]т\s+на\s+оплату/i.test(f))
  .sort((a, b) => a.localeCompare(b, 'ru'));
const files = names.map((n) => {
  const p = join(dir, n);
  return new File([readFileSync(p)], n, { lastModified: Math.round(statSync(p).mtimeMs) });
});

const book: PriceBook = (() => {
  for (const f of [pricesFile, new URL('../data/prices.json', import.meta.url).pathname, new URL('../public/prices.json', import.meta.url).pathname]) {
    if (f && existsSync(f)) return JSON.parse(readFileSync(f, 'utf8')) as PriceBook;
  }
  return { updatedAt: null, region: 'Санкт-Петербург', materials: {} };
})();
const settings: Settings = structuredClone(DEFAULT_SETTINGS);

const toArrayBuffer = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

const t0 = performance.now();
const parsed = await parseFiles(files, [], importDefaults([]), undefined, {
  importPdf: async (f, defs) => {
    const pages = await readPdf(pdfjs as unknown as PdfJsLike, await f.arrayBuffer());
    return positionsFromPages(pages, f.name, pdfFileKey(f), defs);
  },
});
const order: Order = {
  ...emptyOrder(),
  title: `Заказ из папки ${basename(dir)}`,
  positions: parsed.positions,
  documents: parsed.documents,
  requestLines: parsed.requestLines,
  request: requestFile ? decodeText(toArrayBuffer(readFileSync(requestFile))).trim() : '',
};
const res = computeOrder(order.positions, book, orderSettings(order, settings));
const ctx = buildAiContext(order, res, book, settings);
const compact = JSON.stringify(ctx);
const bytes = Buffer.byteLength(compact);
if (outFile) writeFileSync(outFile, JSON.stringify(ctx, null, 1));

console.log(`Папка: ${dir}  файлов: ${files.length} (${names.join(', ')})`);
for (const m of [...parsed.errors, ...parsed.warnings, ...parsed.notes]) console.log('  ·', m);
console.log(`Позиций: ${ctx.positions.length}, групп металла: ${ctx.groups.length}, документов: ${ctx.documents.length}, заявка: ${ctx.order.request.length} симв.`);
for (const p of ctx.positions) {
  console.log(
    `  ${p.name} [${p.source}] ${p.materialId} ${p.thickness} мм × ${p.qty}${p.guessed.qty ? '?' : ''} шт, ${p.geometry.widthMm}×${p.geometry.heightMm}, гибов ${p.bends}/${p.detectedBends}` +
      `${p.massCheck ? `, масса ${p.massKg} / ${p.massCheck.drawingKg ?? '—'} (${p.massCheck.status})` : ''}, текст ${p.drawingText?.length ?? 0} симв., ${p.cost ? `${p.cost.total} ₽/шт` : 'исключена'}`,
  );
}
for (const g of ctx.groups) console.log(`  группа ${g.key}: лист ${g.chosenSheet}, металл ${g.materialCost} ₽, вариантов листа ${g.offers.length}, цены от ${g.pricesFetchedAt ?? '—'}`);
const T = ctx.totals;
console.log(`Итого: себестоимость ${T.cost} ₽, наценка ${T.markup} ₽ (${ctx.order.markupPct} %), цена клиенту ${T.total} ₽`);
console.log(`JSON: ${bytes} байт (лимит ${900_000}), хэш ${contextHash(ctx)}, ${(performance.now() - t0).toFixed(0)} мс${outFile ? ` → ${outFile}` : ''}`);
