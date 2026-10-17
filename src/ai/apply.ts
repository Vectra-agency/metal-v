// Предложения ИИ поверх позиций заказа: что применять по умолчанию, как получить позиции
// для расчёта (наложение, исходные позиции не меняются), какие значения изменены (значки «ИИ»)
// и как ручная правка снимает предложение по тому же полю.

import type { AiAnalysis, AiPositionReview, AiState, AiSuggestion, AiSuggestionKind } from '../core/ai.ts';
import { MATERIAL_BY_ID } from '../core/materials.ts';
import type { Extra } from '../core/pricing.ts';
import type { OrderPosition } from '../order.ts';

export type AiField = 'materialId' | 'thickness' | 'qty' | 'bends' | 'extras' | 'disabled';

export const FIELD_OF: Record<AiSuggestionKind, AiField> = {
  material: 'materialId',
  thickness: 'thickness',
  qty: 'qty',
  bends: 'bends',
  extra: 'extras',
  disable: 'disabled',
};

export interface AiChange {
  field: AiField;
  from: unknown; // значение в позиции (для extras — null)
  to: unknown; // значение по предложению (для extras — { label, perPiece })
  suggestion: AiSuggestion;
}

/** Предложение можно применить к позиции (значение корректно) */
export function isApplicable(s: AiSuggestion): boolean {
  return applicable(s);
}

function applicable(s: AiSuggestion): boolean {
  switch (s.kind) {
    case 'material':
      return !!s.materialId && MATERIAL_BY_ID.has(s.materialId);
    case 'thickness':
      return typeof s.value === 'number' && s.value > 0;
    case 'qty':
      return typeof s.value === 'number' && s.value >= 1;
    case 'bends':
      return typeof s.value === 'number' && s.value >= 0;
    case 'extra':
      return !!s.label?.trim() && typeof s.perPiece === 'number' && s.perPiece >= 0;
    case 'disable':
      return true;
  }
}

/** Политика автоприменения: доп. операции — да; материал/толщина/кол-во — только если парсер не нашёл
 *  значение (стоит по умолчанию); гибы — только если гибов не найдено и не введено; исключение позиции —
 *  никогда. Пишутся только true: остальное — предложение, ждёт решения (ключа нет).
 *  skipKinds — `${positionId}|${kind}`, где уже есть перенесённое «применено» (повторный анализ). */
export function defaultAccepted(analysis: AiAnalysis, positions: OrderPosition[], skipKinds?: ReadonlySet<string>): Record<string, boolean> {
  const byId = new Map(positions.map((p) => [p.id, p]));
  const out: Record<string, boolean> = {};
  for (const r of analysis.positions) {
    const p = byId.get(r.id);
    if (!p || p.disabled) continue;
    const taken = new Set<AiSuggestionKind>(); // одно значение на поле: первое подходящее
    for (const s of r.suggestions) {
      if (!applicable(s)) continue;
      let on = false;
      if (s.kind === 'extra') on = true;
      else if (!taken.has(s.kind) && !skipKinds?.has(`${r.id}|${s.kind}`)) {
        if (s.kind === 'material') on = p.guessed.material;
        else if (s.kind === 'thickness') on = p.guessed.thickness;
        else if (s.kind === 'qty') on = p.guessed.qty;
        else if (s.kind === 'bends') on = (p.detectedBends ?? 0) === 0 && p.bends === 0;
      }
      if (!on) continue;
      if (s.kind !== 'extra') taken.add(s.kind);
      out[s.id] = true;
    }
  }
  return out;
}

/** Ключ «то же предложение» для переноса решения: вид + значение (доп. работа — название без регистра) */
function sameOffer(a: AiSuggestion, b: AiSuggestion): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'material':
      return a.materialId === b.materialId;
    case 'thickness':
    case 'qty':
    case 'bends':
      return a.value === b.value;
    case 'extra':
      return (a.label ?? '').trim().toLowerCase() === (b.label ?? '').trim().toLowerCase();
    case 'disable':
      return true;
  }
}

/** Новое состояние ИИ после анализа. prev — прежнее состояние: решения по тем же предложениям (та же позиция,
 *  вид и значение) переносятся; defaults (по умолчанию да) — политика автоприменения для остального, кроме
 *  полей, где уже перенесено «применено». defaults: false — всё новое ждёт решения («Посмотреть»). */
export function aiStateFrom(analysis: AiAnalysis, positions: OrderPosition[], contextHash: string, opts: { prev?: AiState; defaults?: boolean } = {}): AiState {
  const { prev, defaults = true } = opts;
  const accepted: Record<string, boolean> = {};
  const inheritedOn = new Set<string>();
  if (prev) {
    const old = new Map(prev.analysis.positions.map((r) => [r.id, r]));
    for (const r of analysis.positions) {
      const was = old.get(r.id);
      if (!was) continue;
      for (const s of r.suggestions) {
        const o = was.suggestions.find((x) => sameOffer(x, s) && typeof prev.accepted[x.id] === 'boolean');
        if (!o) continue;
        const v = prev.accepted[o.id];
        // одно значение на поле: второе перенесённое «применено» того же вида не включаем
        if (v && s.kind !== 'extra' && inheritedOn.has(`${r.id}|${s.kind}`)) continue;
        accepted[s.id] = v;
        if (v && s.kind !== 'extra') inheritedOn.add(`${r.id}|${s.kind}`);
      }
    }
  }
  if (defaults) {
    for (const [id, v] of Object.entries(defaultAccepted(analysis, positions, inheritedOn))) if (!(id in accepted)) accepted[id] = v;
  }
  return { analysis, accepted, contextHash };
}

/** Решение по предложению: true — применено, false — отклонено, нет ключа — ждёт решения */
export type Decision = 'applied' | 'rejected' | 'pending';

export function decisionOf(ai: AiState | null | undefined, id: string): Decision {
  const v = ai?.accepted[id];
  return v === true ? 'applied' : v === false ? 'rejected' : 'pending';
}

/** Вернуть предложение в «ждёт решения» (убрать ключ) */
export function resetSuggestion(ai: AiState, id: string): AiState {
  if (!(id in ai.accepted)) return ai;
  const accepted = { ...ai.accepted };
  delete accepted[id];
  return { ...ai, accepted };
}

/** Позиция исключена по принятому предложению ИИ */
export function aiDisabled(ai: AiState | null | undefined, positionId: string): boolean {
  return !!reviewFor(ai, positionId)?.suggestions.some((s) => s.kind === 'disable' && ai!.accepted[s.id] === true);
}

/** Предложения, ждущие решения: применимые, позиция есть и в расчёте (и не исключена по предложению ИИ) */
export function pendingOffers(ai: AiState | null | undefined, positions: OrderPosition[]): { positionId: string; s: AiSuggestion }[] {
  if (!ai) return [];
  const byId = new Map(positions.map((p) => [p.id, p]));
  const out: { positionId: string; s: AiSuggestion }[] = [];
  for (const r of ai.analysis.positions) {
    const p = byId.get(r.id);
    if (!p || p.disabled) continue;
    if (r.suggestions.some((s) => s.kind === 'disable' && ai.accepted[s.id] === true)) continue;
    for (const s of r.suggestions) if (applicable(s) && decisionOf(ai, s.id) === 'pending') out.push({ positionId: r.id, s });
  }
  return out;
}

/** Сколько предложений применено (позиция есть и в расчёте) */
export function appliedCount(ai: AiState | null | undefined, positions: OrderPosition[]): number {
  if (!ai) return 0;
  const byId = new Map(positions.map((p) => [p.id, p]));
  let n = 0;
  for (const r of ai.analysis.positions) {
    const p = byId.get(r.id);
    if (!p || p.disabled) continue;
    for (const s of r.suggestions) if (ai.accepted[s.id] === true && applicable(s)) n++;
  }
  return n;
}

/** «Отменить изменения ИИ»: все применённые → отклонены */
export function revertAll(ai: AiState): AiState {
  let changed = false;
  const accepted = { ...ai.accepted };
  for (const [id, v] of Object.entries(accepted)) {
    if (v === true) {
      accepted[id] = false;
      changed = true;
    }
  }
  return changed ? { ...ai, accepted } : ai;
}

export function reviewFor(ai: AiState | null | undefined, id: string): AiPositionReview | undefined {
  return ai?.analysis.positions.find((r) => r.id === id);
}

export function suggestionsFor(ai: AiState | null | undefined, id: string): AiSuggestion[] {
  return reviewFor(ai, id)?.suggestions ?? [];
}

export const isAccepted = (ai: AiState | null | undefined, suggestionId: string) => !!ai?.accepted[suggestionId];

function findSuggestion(ai: AiState, suggestionId: string): { review: AiPositionReview; s: AiSuggestion } | null {
  for (const review of ai.analysis.positions) {
    const s = review.suggestions.find((x) => x.id === suggestionId);
    if (s) return { review, s };
  }
  return null;
}

/** Включить/выключить предложение; у материала, толщины, количества и гибов включено не больше одного на позицию */
export function toggleSuggestion(ai: AiState, suggestionId: string, on: boolean): AiState {
  const f = findSuggestion(ai, suggestionId);
  if (!f) return ai;
  const accepted = { ...ai.accepted, [suggestionId]: on };
  if (on && f.s.kind !== 'extra') {
    for (const o of f.review.suggestions) if (o.id !== suggestionId && o.kind === f.s.kind) accepted[o.id] = false;
  }
  return { ...ai, accepted };
}

/** Применённые предложения позиции, по одному на поле (последнее включённое), доп. операции — все */
function acceptedFor(ai: AiState, id: string): AiSuggestion[] {
  const r = reviewFor(ai, id);
  if (!r) return [];
  const byKind = new Map<AiSuggestionKind, AiSuggestion>();
  const extras: AiSuggestion[] = [];
  for (const s of r.suggestions) {
    if (!ai.accepted[s.id] || !applicable(s)) continue;
    if (s.kind === 'extra') extras.push(s);
    else byKind.set(s.kind, s);
  }
  return [...byKind.values(), ...extras];
}

const extraOf = (s: AiSuggestion): Extra => ({ label: s.label!.trim(), perPiece: Math.round(s.perPiece! * 100) / 100, aiId: s.id });

/** Применённые изменения позиции (для значков «ИИ»): позиция — исходная (базовая) */
export function changesFor(position: OrderPosition, ai: AiState | null | undefined): AiChange[] {
  if (!ai || position.disabled) return [];
  const out: AiChange[] = [];
  for (const s of acceptedFor(ai, position.id)) {
    const field = FIELD_OF[s.kind];
    if (s.kind === 'extra') {
      if (position.extras.some((e) => e.aiId === s.id)) continue; // уже перенесена в позицию
      const e = extraOf(s);
      out.push({ field, from: null, to: { label: e.label, perPiece: e.perPiece }, suggestion: s });
      continue;
    }
    if (s.kind === 'disable') {
      out.push({ field, from: false, to: true, suggestion: s });
      continue;
    }
    const to = s.kind === 'material' ? s.materialId! : s.kind === 'qty' || s.kind === 'bends' ? Math.round(s.value!) : s.value!;
    const from = position[field as 'materialId' | 'thickness' | 'qty' | 'bends'];
    if (from !== to) out.push({ field, from, to, suggestion: s });
  }
  return out;
}

/** Позиции для расчёта: исходные + применённые предложения ИИ. Ничего не применено — тот же массив */
export function effectivePositions(positions: OrderPosition[], ai: AiState | null | undefined): OrderPosition[] {
  if (!ai) return positions;
  let changed = false;
  const out = positions.map((p) => {
    const ch = changesFor(p, ai);
    if (!ch.length) return p;
    changed = true;
    const q: OrderPosition = { ...p, guessed: { ...p.guessed }, extras: p.extras.slice() };
    for (const c of ch) {
      if (c.field === 'extras') q.extras.push(extraOf(c.suggestion));
      else if (c.field === 'materialId') {
        q.materialId = c.to as string;
        q.guessed.material = false;
      } else if (c.field === 'thickness') {
        q.thickness = c.to as number;
        q.guessed.thickness = false;
      } else if (c.field === 'qty') {
        q.qty = c.to as number;
        q.guessed.qty = false;
      } else if (c.field === 'bends') q.bends = c.to as number;
      else if (c.field === 'disabled') q.disabled = true;
    }
    return q;
  });
  return changed ? out : positions;
}

const PATCH_KIND: Partial<Record<keyof OrderPosition, AiSuggestionKind>> = {
  materialId: 'material',
  thickness: 'thickness',
  qty: 'qty',
  bends: 'bends',
  disabled: 'disable', // «Включить в расчёт» снимает предложение исключить позицию
};

/** Ручная правка поля снимает применённое предложение ИИ по этому полю, а ждущее решения — отклоняет.
 *  Доп. операции: предложение снимается, если пользователь удалил строку ИИ или изменил её (тогда это уже ручная строка). */
export function onManualEdit(ai: AiState, positionId: string, patch: Partial<OrderPosition>): AiState;
export function onManualEdit(ai: AiState | null | undefined, positionId: string, patch: Partial<OrderPosition>): AiState | undefined;
export function onManualEdit(ai: AiState | null | undefined, positionId: string, patch: Partial<OrderPosition>): AiState | undefined {
  if (!ai) return undefined;
  const r = reviewFor(ai, positionId);
  if (!r) return ai;
  const kinds = new Set<AiSuggestionKind>();
  for (const k of Object.keys(patch) as (keyof OrderPosition)[]) {
    const kind = PATCH_KIND[k];
    if (kind && patch[k] !== undefined) kinds.add(kind);
  }
  const accepted = { ...ai.accepted };
  let changed = false;
  for (const s of r.suggestions) {
    if (accepted[s.id] === false) continue;
    if (accepted[s.id] === undefined) {
      // ждёт решения: ручная правка поля отвечает на предложение — чип исчезает (доп. работы — без изменений)
      if (s.kind !== 'extra' && kinds.has(s.kind)) {
        accepted[s.id] = false;
        changed = true;
      }
      continue;
    }
    let drop = kinds.has(s.kind);
    if (s.kind === 'extra' && patch.extras) {
      const e = patch.extras.find((x) => x.aiId === s.id);
      drop = !e || !applicable(s) || e.label.trim() !== s.label!.trim() || Math.abs((Number(e.perPiece) || 0) - extraOf(s).perPiece) > 0.005;
    }
    if (drop) {
      accepted[s.id] = false;
      changed = true;
    }
  }
  return changed ? { ...ai, accepted } : ai;
}

/** Ручная правка в таблице, где показаны позиции с предложениями ИИ: что записать в исходную позицию
 *  и новое состояние ИИ. Строки доп. работ от ИИ без изменений в позицию не пишутся (их добавляет наложение),
 *  изменённые — становятся обычными ручными строками. */
export function manualEdit(ai: AiState | null | undefined, positionId: string, patch: Partial<OrderPosition>): { patch: Partial<OrderPosition>; ai: AiState | undefined } {
  const next = onManualEdit(ai, positionId, patch);
  if (!patch.extras) return { patch, ai: next };
  const extras = patch.extras.flatMap((e): Extra[] => {
    if (!e.aiId) return [e];
    if (next?.accepted[e.aiId]) return []; // без изменений — остаётся предложением
    return [{ label: e.label, perPiece: e.perPiece }];
  });
  return { patch: { ...patch, extras }, ai: next };
}

/** Позиции, по которым ИИ просит внимания (для списка «Проверьте»), в порядке заказа */
export function attentionList(ai: AiState | null | undefined, positions: OrderPosition[]): { position: OrderPosition; review: AiPositionReview }[] {
  if (!ai) return [];
  const out: { position: OrderPosition; review: AiPositionReview }[] = [];
  for (const p of positions) {
    const r = reviewFor(ai, p.id);
    if (r && r.status !== 'ok') out.push({ position: p, review: r });
  }
  const rank = { problem: 0, check: 1, ok: 2 } as const;
  return out.sort((a, b) => rank[a.review.status] - rank[b.review.status]);
}

/** Анализ устарел: данные заказа изменились после него */
export const isOutdated = (ai: AiState | null | undefined, currentHash: string) => !!ai && ai.contextHash !== currentHash;
