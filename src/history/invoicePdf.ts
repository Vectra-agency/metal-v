// Счёт цеха из PDF (или из текста документа заказа) → строки счёта и к каким деталям они относятся.
import type { AiDocument } from '../core/ai.ts';
import { documentLines } from '../core/drawingText.ts';
import type { HistoryInvoice, HistoryOrder } from '../core/history.ts';
import { autoMatch, looksLikeInvoice, parseInvoiceLines, type ParsedInvoice } from '../core/invoice.ts';
import { readPdf } from '../core/pdf.ts';
import { pdfErrorText, pdfjs } from '../pdfImport.ts';

/** Счёт из PDF; не счёт или скан — понятная ошибка */
export async function invoiceFromPdf(file: File): Promise<ParsedInvoice> {
  let lines: string[];
  try {
    lines = documentLines(await readPdf(await pdfjs(), await file.arrayBuffer(), 10));
  } catch (e) {
    throw new Error(`Не удалось прочитать «${file.name}»: ${pdfErrorText(e)}`);
  }
  const inv = parseInvoiceLines(lines);
  if (!inv) {
    throw new Error(
      lines.length
        ? `В «${file.name}» не нашлось строк счёта (№, наименование, количество, цена, сумма)`
        : `«${file.name}» — скан без текста: строки счёта не прочитать`,
    );
  }
  return inv;
}

/** Документ заказа (лист PDF без чертежа), похожий на счёт на оплату */
export function invoiceDocument(docs: readonly AiDocument[] | undefined): { doc: AiDocument; inv: ParsedInvoice } | null {
  for (const doc of docs ?? []) {
    if (!looksLikeInvoice(doc.text)) continue;
    const inv = parseInvoiceLines(doc.text.split('\n'));
    if (inv) return { doc, inv };
  }
  return null;
}

/** Счёт для истории: строки с деталями, найденными автоматически */
export function draftInvoice(inv: ParsedInvoice, h: HistoryOrder, fileName: string): HistoryInvoice {
  const ids = autoMatch(inv.items, h.parts);
  return {
    supplier: inv.supplier,
    number: inv.number,
    date: inv.date,
    total: inv.total,
    fileName,
    addedAt: new Date().toISOString(),
    lines: inv.items.map((it, i) => ({ ...it, partIds: ids[i] })),
  };
}
