// Слияние результатов импорта: DXF и PDF одной детали — одна позиция
// (контур точнее из DXF, гибы/материал/масса — из PDF), количество — из заявки.

import type { QtyLine } from './core/pdfAnalyze.ts';
import type { OrderPosition } from './order.ts';
import { newId } from './order.ts';
import { desigKey, geometryPatch } from './pdfImport.ts';

export interface MergeResult {
  positions: OrderPosition[];
  notes: string[];
}

export function mergeImports(existing: OrderPosition[], dxf: OrderPosition[], pdf: OrderPosition[], qty: QtyLine[]): MergeResult {
  const list = existing.slice();
  const notes: string[] = [];
  const findBy = (key: string, pred: (p: OrderPosition) => boolean) => list.findIndex((p) => desigKey(p.name) === key && pred(p));

  // DXF к уже распознанному PDF: берём точный контур, остальное оставляем
  for (const d of dxf) {
    const i = findBy(desigKey(d.name), (p) => p.source === 'pdf' && !!p.pdf?.geometryFromPdf);
    if (i < 0) {
      list.push(d);
      continue;
    }
    const p = list[i];
    list[i] = {
      ...p,
      geom: d.geom,
      preview: d.preview,
      fileName: d.fileName,
      warnings: d.warnings,
      qty: d.guessed.qty ? p.qty : d.qty,
      materialId: p.guessed.material && !d.guessed.material ? d.materialId : p.materialId,
      thickness: p.guessed.thickness && !d.guessed.thickness ? d.thickness : p.thickness,
      guessed: { material: p.guessed.material && d.guessed.material, thickness: p.guessed.thickness && d.guessed.thickness, qty: p.guessed.qty && d.guessed.qty },
      source: 'dxf',
      pdf: p.pdf ? { ...p.pdf, geometryFromPdf: false } : undefined,
    };
    notes.push(`${d.name}: контур из DXF, гибы и материал из PDF`);
  }

  // PDF к уже загруженному DXF: дополняем гибами, материалом, сверкой массы
  for (const q of pdf) {
    const i = findBy(desigKey(q.name), (p) => p.source === 'dxf' && !p.pdf);
    if (i < 0) {
      list.push(q);
      continue;
    }
    const p = list[i];
    const got: string[] = [];
    const patch: Partial<OrderPosition> = { pdf: q.pdf ? { ...q.pdf, geometryFromPdf: false } : undefined };
    if (p.bends === 0 && q.bends > 0) {
      patch.bends = q.bends;
      patch.detectedBends = q.bends;
      patch.bendLength = q.bendLength;
      got.push(`гибы (${q.bends})`);
    }
    if (p.guessed.material && !q.guessed.material) {
      patch.materialId = q.materialId;
      got.push('материал');
    }
    if (p.guessed.thickness && !q.guessed.thickness) {
      patch.thickness = q.thickness;
      got.push('толщина');
    }
    patch.guessed = {
      material: p.guessed.material && q.guessed.material,
      thickness: p.guessed.thickness && q.guessed.thickness,
      qty: p.guessed.qty,
    };
    list[i] = { ...p, ...patch };
    notes.push(`${p.name}: из PDF добавлено ${got.length ? got.join(', ') : 'сверка массы'}`);
  }

  // в заявке исполнения, а прислан один чертёж с таблицей — создаём позицию на каждое исполнение
  const variantBases = new Set<string>();
  for (const line of qty) {
    const key = desigKey(line.designation);
    if (list.some((p) => desigKey(p.name) === key)) continue;
    const base = list.find((p) => p.pdf?.geometryFromPdf && p.pdf.meta.table?.rows.some((r) => desigKey(r.designation) === key));
    if (!base) continue;
    const row = base.pdf!.meta.table!.rows.findIndex((r) => desigKey(r.designation) === key);
    const meta = { ...base.pdf!.meta, row };
    list.push({
      ...base,
      ...geometryPatch(meta, base),
      id: newId(),
      name: base.pdf!.meta.table!.rows[row].designation,
      qty: line.qty,
      guessed: { ...base.guessed, qty: false },
      disabled: false,
      warnings: base.warnings.filter((w) => !/таблица исполнений/.test(w)),
      pdf: { ...base.pdf!, meta },
    });
    variantBases.add(base.id);
  }
  for (const id of variantBases) {
    const i = list.findIndex((p) => p.id === id);
    if (i >= 0 && !qty.some((l) => desigKey(l.designation) === desigKey(list[i].name))) {
      list[i] = { ...list[i], disabled: true };
      notes.push(`${list[i].name}: по заявке созданы исполнения из таблицы, базовая позиция исключена`);
    }
  }

  // количество из заявки
  let applied = 0;
  for (const line of qty) {
    const key = desigKey(line.designation);
    for (let i = 0; i < list.length; i++) {
      if (desigKey(list[i].name) !== key) continue;
      list[i] = { ...list[i], qty: line.qty, guessed: { ...list[i].guessed, qty: false } };
      applied++;
    }
  }
  if (applied) notes.push(`Количество из заявки проставлено у ${applied} поз.`);
  const unmatched = qty.filter((l) => !list.some((p) => desigKey(p.name) === desigKey(l.designation)));
  if (unmatched.length) notes.push(`В заявке без чертежа: ${unmatched.slice(0, 8).map((l) => `${l.designation} — ${l.qty} шт`).join('; ')}${unmatched.length > 8 ? '…' : ''}`);
  return { positions: list, notes };
}
