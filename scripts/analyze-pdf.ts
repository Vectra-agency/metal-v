// Распознавание PDF-чертежей из командной строки: npm run analyze-pdf -- <файлы или папки>
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readPdf, type PdfJsLike } from '../src/core/pdf.ts';
import { analyzePdf, buildGeometry, findDesignation, massCheck } from '../src/core/pdfAnalyze.ts';
import { getMaterial } from '../src/core/materials.ts';

const files: string[] = [];
const over = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const [f, d] = a.split('=>');
  if (statSync(f).isDirectory()) for (const x of readdirSync(f)) { if (/\.pdf$/i.test(x)) files.push(join(f, x)); }
  else { files.push(f); if (d) over.set(f, d); }
}
for (const f of files) {
  const buf = readFileSync(f);
  const t0 = performance.now();
  const pages = await readPdf(pdfjs as unknown as PdfJsLike, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const desig = over.get(f) ?? findDesignation(basename(f).replace(/\.[^.]+$/, '')) ?? undefined;
  const an = analyzePdf(pages, basename(f), desig);
  const ms = performance.now() - t0;
  console.log(`\n### ${basename(f)}  [${desig}]  ${ms.toFixed(0)} мс, стр. ${pages.length}, кандидатов ${an.candidates.length}`);
  if (!an.meta) { console.log('   ', an.warnings.join('; ')); continue; }
  const m = an.meta;
  const T = m.title;
  console.log(`   штамп: ${T.designation ?? '?'} | ${T.materialText ?? '?'} (${T.materialId ?? '?'}) | t=${T.thickness ?? '?'} | масса ${T.mass ?? (T.massInTable ? 'в таблице' : '?')} | М ${T.sheetScale ? '1:' + T.sheetScale : '?'}`);
  if (m.table) console.log(`   таблица: ${m.table.cols.map((c) => c.key).join(',')} × ${m.table.rows.length} строк; выбрано: ${m.row >= 0 ? m.table.rows[m.row].designation + ' ' + JSON.stringify(m.table.rows[m.row].values) : 'нет'}; оси ${JSON.stringify(m.axes)}`);
  const g = buildGeometry(m);
  const mid = T.materialId ?? 'st3';
  const mc = massCheck(m, g, mid, T.thickness ?? 2);
  const c = an.candidates[an.pick!.cand];
  console.log(`   вид: стр.${m.page + 1}, линия ${c.width} мм, ${(c.bbox.maxX - c.bbox.minX).toFixed(1)}×${(c.bbox.maxY - c.bbox.minY).toFixed(1)} мм на листе → масштаб 1:${m.scale} (${m.scaleWhy}), score ${an.pick!.score.toFixed(1)}`);
  console.log(`   деталь: ${g.width.toFixed(1)}×${g.height.toFixed(1)} мм, S=${(g.netArea / 1e6).toFixed(4)} м², рез ${(g.cutLength / 1000).toFixed(3)} м, врезок ${g.pierces}, гибов ${g.bends.length}${g.bends.length ? ' (макс ' + g.bendMax.toFixed(0) + ' мм)' : ''}${g.stretched.length ? ', по таблице: ' + g.stretched.join(', ') : ''}`);
  console.log(`   масса: расчёт ${mc.calc.toFixed(2)} кг (${getMaterial(mid).short}), чертёж ${mc.drawing ?? '—'}${mc.ratio ? ` → ${((mc.ratio - 1) * 100).toFixed(1)}%` : ''}`);
  const others = an.candidates.map((x, i) => `${i === an.pick!.cand ? '*' : ''}p${x.page + 1}/w${x.width}/${(x.bbox.maxX - x.bbox.minX).toFixed(0)}×${(x.bbox.maxY - x.bbox.minY).toFixed(0)}${x.label ? x.label.text : ''}${x.isoFrac > 0.25 ? 'iso' : ''}`).slice(0, 14).join(' ');
  console.log('   кандидаты:', others);
}
