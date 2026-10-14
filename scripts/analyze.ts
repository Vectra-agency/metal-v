import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { parseDxf } from '../src/core/dxf.ts';
import { analyze, metricsOf } from '../src/core/geometry.ts';

const files: string[] = [];
for (const arg of process.argv.slice(2)) {
  if (statSync(arg).isDirectory()) for (const f of readdirSync(arg)) { if (f.toLowerCase().endsWith('.dxf')) files.push(join(arg, f)); }
  else files.push(arg);
}
const rows = [];
for (const f of files.sort()) {
  const buf = readFileSync(f);
  const t0 = performance.now();
  const dwg = parseDxf(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const an = analyze(dwg);
  const m = metricsOf(an.parts, an.bends);
  const ms = performance.now() - t0;
  rows.push({ file: basename(f), ...m, annotations: an.annotations.length, stray: an.stray.length, warnings: an.warnings, ms });
  console.log(
    basename(f).padEnd(52),
    `parts=${m.count}`.padEnd(9),
    `${m.width.toFixed(1)}x${m.height.toFixed(1)}`.padEnd(15),
    `net=${(m.netArea / 1e6).toFixed(4)}м²`.padEnd(16),
    `bb=${(m.bboxArea / 1e6).toFixed(4)}`.padEnd(13),
    `cut=${(m.cutLength / 1000).toFixed(3)}м`.padEnd(13),
    `pier=${m.pierces}`.padEnd(9),
    `bends=${m.bendCount}`.padEnd(9),
    `anno=${an.annotations.length} stray=${an.stray.length}`,
    an.warnings.length ? '⚠ ' + an.warnings.join('; ') : '',
    `${ms.toFixed(0)}ms`
  );
}
if (process.env.JSON_OUT) (await import('node:fs')).writeFileSync(process.env.JSON_OUT, JSON.stringify(rows, null, 1));
