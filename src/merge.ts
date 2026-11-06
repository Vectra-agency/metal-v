// Слияние результатов импорта: DXF и PDF одной детали — одна позиция
// (контур точнее из DXF, гибы/материал/масса — из PDF), количество — из заявки.
// Материал и толщина из штампа чертежа важнее пометок в имени файла: имя файла пишет менеджер
// («st3 s2mm»), а штамп — конструктор («Лист 2 ГОСТ 19904 / Ст3» — это холоднокатаный 08пс).

import { mergeDrawingTexts } from './core/drawingText.ts';
import { getMaterial } from './core/materials.ts';
import type { QtyLine } from './core/pdfAnalyze.ts';
import type { OrderPosition } from './order.ts';
import { newId } from './order.ts';
import { desigKey, geometryPatch } from './pdfImport.ts';

export interface MergeResult {
  positions: OrderPosition[];
  notes: string[];
}

const stampOf = (p: OrderPosition): { materialId?: string; thickness?: number } => p.pdf?.meta.title ?? {};

/** Материал и толщина для позиции DXF + PDF: штамп важнее имени файла, имя файла — важнее значения по умолчанию */
function stampFields(dxf: OrderPosition, pdf: OrderPosition, notes: string[], name: string): Pick<OrderPosition, 'materialId' | 'thickness' | 'guessed'> {
  const T = stampOf(pdf);
  const materialId = T.materialId ?? (dxf.guessed.material ? pdf.materialId : dxf.materialId);
  const thickness = T.thickness ?? (dxf.guessed.thickness ? pdf.thickness : dxf.thickness);
  if (T.materialId && !dxf.guessed.material && T.materialId !== dxf.materialId)
    notes.push(`${name}: материал по штампу — ${getMaterial(T.materialId).short} (в имени файла — ${getMaterial(dxf.materialId).short})`);
  if (T.thickness && !dxf.guessed.thickness && Math.abs(T.thickness - dxf.thickness) > 1e-9) notes.push(`${name}: толщина по штампу — ${T.thickness} мм (в имени файла — ${dxf.thickness} мм)`);
  return {
    materialId,
    thickness,
    guessed: {
      material: dxf.guessed.material && pdf.guessed.material && !T.materialId,
      thickness: dxf.guessed.thickness && pdf.guessed.thickness && !T.thickness,
      qty: dxf.guessed.qty && pdf.guessed.qty,
    },
  };
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
    const f = stampFields(d, p, notes, p.name);
    list[i] = {
      ...p,
      ...f,
      geom: d.geom,
      preview: d.preview,
      fileName: d.fileName,
      warnings: d.warnings,
      qty: d.guessed.qty ? p.qty : d.qty,
      guessed: { ...f.guessed, qty: p.guessed.qty && d.guessed.qty },
      source: 'dxf',
      pdf: p.pdf ? { ...p.pdf, geometryFromPdf: false } : undefined,
      drawingText: mergeDrawingTexts(p.drawingText, d.drawingText),
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
    const f = stampFields(p, q, notes, p.name);
    const patch: Partial<OrderPosition> = { pdf: q.pdf ? { ...q.pdf, geometryFromPdf: false } : undefined, drawingText: mergeDrawingTexts(q.drawingText, p.drawingText) };
    if (p.bends === 0 && q.bends > 0) {
      patch.bends = q.bends;
      patch.detectedBends = q.bends;
      patch.bendLength = q.bendLength;
      patch.bendLengths = q.bendLengths;
      got.push(`гибы (${q.bends})`);
    }
    if (f.materialId !== p.materialId) got.push('материал');
    if (f.thickness !== p.thickness) got.push('толщина');
    patch.materialId = f.materialId;
    patch.thickness = f.thickness;
    patch.guessed = { ...f.guessed, qty: p.guessed.qty };
    list[i] = { ...p, ...patch };
    notes.push(`${p.name}: из PDF добавлено ${got.length ? got.join(', ') : 'сверка массы'}`);
  }

  // DXF исполнения из таблицы исполнений чертежа («…-0700.dxf» к чертежу «…» с таблицей L, A…):
  // своего штампа и линий гиба у такого DXF нет — гибы, материал, толщина и масса для сверки — с чертежа
  const variantBases = new Map<string, string[]>(); // id базовой позиции → исполнения с файлами
  for (let i = 0; i < list.length; i++) {
    const d = list[i];
    if (d.source !== 'dxf' || d.pdf) continue;
    const key = desigKey(d.name);
    const base = list.find((p) => p.pdf?.geometryFromPdf && p.pdf.meta.table?.rows.some((r) => desigKey(r.designation) === key));
    if (!base) continue;
    const row = base.pdf!.meta.table!.rows.findIndex((r) => desigKey(r.designation) === key);
    const meta = { ...base.pdf!.meta, row };
    const g = geometryPatch(meta);
    const f = stampFields(d, base, notes, d.name);
    const got: string[] = [];
    const patch: Partial<OrderPosition> = {
      ...f,
      guessed: { ...f.guessed, qty: d.guessed.qty },
      pdf: { ...base.pdf!, meta, geometryFromPdf: false, notes: [...base.pdf!.notes, `исполнение из таблицы чертежа ${base.name}`] },
      drawingText: mergeDrawingTexts(base.drawingText, d.drawingText),
    };
    if (d.bends === 0 && (g.bends ?? 0) > 0) {
      patch.bends = g.bends;
      patch.detectedBends = g.detectedBends;
      patch.bendLength = g.bendLength;
      patch.bendLengths = g.bendLengths;
      got.push(`гибы (${g.bends})`);
    }
    if (f.materialId !== d.materialId) got.push('материал');
    list[i] = { ...d, ...patch };
    variantBases.set(base.id, [...(variantBases.get(base.id) ?? []), d.name]);
    notes.push(`${d.name}: исполнение чертежа ${base.name} — ${got.length ? `с чертежа взяты ${got.join(', ')}` : 'сверка массы по таблице'}`);
  }

  // в заявке исполнения, а прислан один чертёж с таблицей — создаём позицию на каждое исполнение
  const requested = new Set(qty.map((l) => desigKey(l.designation)));
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
    variantBases.set(base.id, [...(variantBases.get(base.id) ?? []), line.designation]);
  }
  // базовый вид чертежа с таблицей не заказан, если заказаны исполнения (файлами или заявкой), а сам он в заявке не назван
  for (const [id, variants] of variantBases) {
    const i = list.findIndex((p) => p.id === id);
    if (i < 0 || list[i].disabled || requested.has(desigKey(list[i].name))) continue;
    list[i] = { ...list[i], disabled: true };
    notes.push(`${list[i].name}: базовое исполнение исключено из расчёта — в заказе исполнения ${variants.slice(0, 4).join(', ')}${variants.length > 4 ? '…' : ''}`);
  }

  // количество из заявки
  let applied = 0;
  for (const line of qty) {
    const key = desigKey(line.designation);
    for (let i = 0; i < list.length; i++) {
      if (desigKey(list[i].name) !== key) continue;
      list[i] = { ...list[i], qty: line.qty, qtySource: 'request', guessed: { ...list[i].guessed, qty: false } };
      applied++;
    }
  }
  if (applied) notes.push(`Количество из заявки проставлено у ${applied} поз.`);

  // лист PDF без своего файла (зеркальное «-01» и т. п.), которого нет в заявке, хотя соседний чертёж того же PDF в ней есть
  if (requested.size) {
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (p.disabled || p.source !== 'pdf' || !p.pdf || requested.has(desigKey(p.name))) continue;
      const file = p.pdf.meta.fileName;
      const sibling = list.find((q) => q !== p && q.pdf?.meta.fileName === file && requested.has(desigKey(q.name)));
      if (!sibling) continue;
      list[i] = { ...p, disabled: true };
      notes.push(`${p.name}: исключено из расчёта — лист чертежа ${file}, в заявке только ${sibling.name}`);
    }
  }

  // гибы с зеркального исполнения того же чертежа («…1201» и «…1201-01» на листах одного PDF, тот же габарит):
  // линии гиба часто проставлены только на одном из видов
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (p.bends !== 0 || p.detectedBends !== 0 || !p.pdf) continue;
    const twin = list.find(
      (q) =>
        q !== p &&
        q.detectedBends > 0 &&
        q.pdf?.meta.fileName === p.pdf!.meta.fileName &&
        Math.abs(Math.max(q.geom.width, q.geom.height) - Math.max(p.geom.width, p.geom.height)) <= 2 &&
        Math.abs(Math.min(q.geom.width, q.geom.height) - Math.min(p.geom.width, p.geom.height)) <= 2,
    );
    if (!twin) continue;
    list[i] = { ...p, bends: twin.detectedBends, bendLength: twin.bendLength, bendLengths: twin.bendLengths };
    notes.push(`${p.name}: гибы (${twin.detectedBends}) взяты с исполнения ${twin.name} того же чертежа — у этого вида линий гиба нет`);
  }

  const unmatched = qty.filter((l) => !list.some((p) => desigKey(p.name) === desigKey(l.designation)));
  if (unmatched.length) notes.push(`В заявке без чертежа: ${unmatched.slice(0, 8).map((l) => `${l.designation} — ${l.qty} шт`).join('; ')}${unmatched.length > 8 ? '…' : ''}`);
  return { positions: list, notes };
}
