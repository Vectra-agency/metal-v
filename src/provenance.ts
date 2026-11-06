// Откуда взято значение позиции: имя файла, штамп PDF, заявка, ИИ, вручную или по умолчанию (ui-spec §5.4).
// Когда у позиции появится собственное поле origin, оно заменит эту функцию.
import type { AiChange } from './ai/apply.ts';
import { parseFileName } from './core/materials.ts';
import type { QtyLine } from './core/pdfAnalyze.ts';
import type { OrderPosition } from './order.ts';
import { desigKey } from './pdfImport.ts';

export type Origin = 'file' | 'stamp' | 'request' | 'ai' | 'manual' | 'default';

export const ORIGIN_LABEL: Record<Origin, string> = {
  file: 'имя файла',
  stamp: 'штамп PDF',
  request: 'заявка',
  ai: 'ИИ',
  manual: 'вручную',
  default: 'по умолчанию',
};

export type OriginField = 'material' | 'thickness' | 'qty';

const AI_FIELD: Record<OriginField, AiChange['field']> = { material: 'materialId', thickness: 'thickness', qty: 'qty' };

const sameT = (a: number | null | undefined, b: number) => a != null && Math.abs(a - b) < 1e-6;

/** Источник значения поля базовой позиции; правила — по порядку, первое совпавшее */
export function originOf(base: OrderPosition, field: OriginField, changes: AiChange[], requestLines: QtyLine[]): Origin {
  if (changes.some((c) => c.field === AI_FIELD[field])) return 'ai';
  if (base.guessed[field]) return 'default';
  if (base.source === 'manual') return 'manual';
  const title = base.pdf?.meta.title;
  const fromName = base.fileName ? parseFileName(base.fileName) : null;
  if (field === 'material') {
    if (title?.materialId && title.materialId === base.materialId) return 'stamp';
    if (fromName?.materialId === base.materialId) return 'file';
    return 'manual';
  }
  if (field === 'thickness') {
    if (sameT(title?.thickness, base.thickness)) return 'stamp';
    if (sameT(fromName?.thickness, base.thickness)) return 'file';
    return 'manual';
  }
  if (base.qtySource === 'request') return 'request';
  if (fromName?.qty === base.qty) return 'file';
  const key = desigKey(base.name);
  if (key && requestLines.some((l) => l.qty === base.qty && desigKey(l.designation) === key)) return 'request';
  return 'manual';
}
