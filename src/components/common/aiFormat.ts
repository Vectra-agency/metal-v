// Подписи полей и значений для предложений и изменений ИИ: «Материал», «1,5 мм», «5 шт», «3 гиба», «+ Сварка 244 ₽».
import type { AiField } from '@/ai/apply.ts';
import type { AiSuggestion } from '@/core/ai.ts';
import { MATERIAL_BY_ID } from '@/core/materials.ts';
import { n0, NBSP, plural, rub, thick } from '@/format.ts';

const FIELD_LABEL: Record<AiField, string> = {
  materialId: 'Материал',
  thickness: 'Толщина',
  qty: 'Количество',
  bends: 'Гибы',
  extras: 'Доп. работа',
  disabled: 'Расчёт',
};

export function fieldLabel(f: AiField): string {
  return FIELD_LABEL[f];
}

const bendsText = (n: number) => `${n0(n)}${NBSP}${plural(Math.round(n), 'гиб', 'гиба', 'гибов')}`;
const extraText = (label: string, perPiece: number) => `${label.trim()} ${rub(perPiece)}`;

/** Значение поля по-человечески; нет значения — «—» */
export function formatAiValue(f: AiField, v: unknown): string {
  if (v == null) return '—';
  switch (f) {
    case 'materialId':
      return MATERIAL_BY_ID.get(String(v))?.short ?? String(v);
    case 'thickness':
      return thick(Number(v));
    case 'qty':
      return `${n0(Number(v))}${NBSP}шт`;
    case 'bends':
      return bendsText(Number(v));
    case 'extras': {
      const e = v as { label?: string; perPiece?: number };
      return extraText(e.label ?? '', Number(e.perPiece) || 0);
    }
    case 'disabled':
      return v ? 'исключена' : 'в расчёте';
  }
}

/** Текст чипа предложения без «✦» и «?»: «08пс х/к», «1,5 мм», «5 шт», «3 гиба», «+ Сварка 244 ₽», «Исключить из расчёта» */
export function suggestionLabel(s: AiSuggestion): string {
  switch (s.kind) {
    case 'material':
      return formatAiValue('materialId', s.materialId);
    case 'thickness':
      return formatAiValue('thickness', s.value);
    case 'qty':
      return formatAiValue('qty', s.value);
    case 'bends':
      return formatAiValue('bends', s.value);
    case 'extra':
      return `+ ${extraText(s.label ?? '', s.perPiece ?? 0)}`;
    case 'disable':
      return 'Исключить из расчёта';
  }
}
