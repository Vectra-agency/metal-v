// Полная выгрузка цен mc.ru → public/prices.json (снимок, вшивается в сборку)
// Запуск: npm run prices   (регион: --region msk)
// Можно ограничить материалами: npm run prices -- amg2 amg2r
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { refreshPrices } from '../server/mc.ts';
import { MATERIALS } from '../src/core/materials.ts';
import type { PriceBook } from '../src/core/pricing.ts';

const args = process.argv.slice(2);
const region = args.includes('--region') ? args[args.indexOf('--region') + 1] : 'speterburg';
const only = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--region');
const snap = new URL('../public/prices.json', import.meta.url);
// дополняем существующий снимок, а не перезаписываем
const base: PriceBook = existsSync(snap) ? JSON.parse(readFileSync(snap, 'utf8')) : { updatedAt: null, region: '', materials: {} };
const pairs = only.length ? MATERIALS.filter((m) => only.includes(m.id)).flatMap((m) => m.thicknesses.map((t) => [m.id, t] as [string, number])) : null;
const t0 = Date.now();
const { book, errors } = await refreshPrices(base, pairs, region, (p) => {
  if (p.done % 10 === 0 || p.done === p.total) console.log(`${p.done}/${p.total}  ошибок: ${p.errors.length}`);
});
console.log(`\nГотово за ${((Date.now() - t0) / 1000).toFixed(0)} с`);
for (const [id, items] of Object.entries(book.materials)) {
  const ts = [...new Set(items.map((i) => i.t))].sort((a, b) => a - b);
  console.log(`${id.padEnd(8)} ${String(items.length).padStart(4)} позиций; толщины: ${ts.join(', ')}`);
}
if (errors.length) console.log('Ошибки:\n  ' + errors.join('\n  '));
const json = JSON.stringify(book);
writeFileSync(new URL('../public/prices.json', import.meta.url), json);
mkdirSync(new URL('../data/', import.meta.url), { recursive: true });
writeFileSync(new URL('../data/prices.json', import.meta.url), json);
console.log('Сохранено: public/prices.json, data/prices.json');
