// Количество из заявки клиента без ИИ: строки «БВС-305Х300.000 — 3 шт», «НГЭН.745535.0021-01 - 5 шт.»,
// «Блок выхода сброса БВС-305Х300.000<таб>3<таб>шт» в тексте заявки (вставлен вручную) и в документах
// заказа (.txt, листы PDF без чертежа). Количество ищется после обозначения: «… 995 руб/шт» не путается.

import { findDesignation, keyDesig, type QtyLine } from './core/pdfAnalyze.ts';
import type { AiDocument } from './core/ai.ts';
import type { OrderPosition } from './order.ts';
import { desigKey } from './pdfImport.ts';

// \b в JS не видит границу кириллического слова — граница через отрицательный просмотр
const QTY_AFTER = /(?:^|[\s\-–—:,;|(])(\d{1,6})\s*(?:шт|штук|компл|pcs)(?![а-яёa-z])/i;

/** Строки «обозначение … N шт» из текста; одно обозначение — первая строка */
export function qtyLinesFromText(text: string): QtyLine[] {
  const out: QtyLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, ' ').trim();
    const d = findDesignation(line);
    if (!d) continue;
    const m = QTY_AFTER.exec(line.slice(line.indexOf(d) + d.length));
    if (!m) continue;
    const qty = parseInt(m[1], 10);
    if (qty > 0 && !out.some((x) => keyDesig(x.designation) === keyDesig(d))) out.push({ designation: d, qty });
  }
  return out;
}

/** Строки количества из заявки и текстовых документов заказа */
export function requestQtyLines(request: string | undefined, documents: AiDocument[] = []): QtyLine[] {
  const out: QtyLine[] = [];
  for (const t of [request ?? '', ...documents.map((d) => d.text)]) {
    for (const l of qtyLinesFromText(t)) if (!out.some((x) => keyDesig(x.designation) === keyDesig(l.designation))) out.push(l);
  }
  return out;
}

/** Проставляет количество из строк заявки позициям, где оно не найдено в файлах или уже взято из заявки
 *  (ручную правку не трогает). Возвращает те же позиции, если ничего не изменилось */
export function applyRequestQty(positions: OrderPosition[], lines: QtyLine[]): { positions: OrderPosition[]; applied: number } {
  if (!lines.length) return { positions, applied: 0 };
  const byKey = new Map(lines.map((l) => [keyDesig(l.designation), l.qty]));
  let applied = 0;
  const out = positions.map((p) => {
    if (!p.guessed.qty && p.qtySource !== 'request') return p;
    const q = byKey.get(desigKey(p.name));
    if (!q || (q === p.qty && !p.guessed.qty)) return p;
    applied++;
    return { ...p, qty: q, qtySource: 'request' as const, guessed: { ...p.guessed, qty: false } };
  });
  return applied ? { positions: out, applied } : { positions, applied };
}
