// Модель «Требует внимания»: замечания по позициям и заказу (ошибки расчёта, предложения ИИ, угаданные
// значения, цены, раскрой, заявка), их порядок для разбора и что закрывает каждое (ui-spec §5.1).
// Только данные, без React: работает и в Node (тесты), поэтому подписи значений — свои, как в aiFormat.ts.

import { aiDisabled, changesFor, decisionOf, FIELD_OF, isApplicable, reviewFor, type AiChange, type AiField } from './ai/apply.ts';
import { cyrb53 } from './ai/context.ts';
import type { AiContext, AiPositionReview, AiSuggestion } from './core/ai.ts';
import { stripConfirmations } from './core/aiSanitize.ts';
import { MATERIAL_BY_ID } from './core/materials.ts';
import { CUT_GROUPS, fmtSheet, type GroupResult, type OrderResult, type PriceBook, type Settings } from './core/pricing.ts';
import { evidenceSources, findEvidence, type EvidenceSources } from './evidence.ts';
import { dateDay, kg, m as meters, n0, n1, NBSP, plural, rub } from './format.ts';
import type { Order, OrderPosition } from './order.ts';
import { desigKey, pdfCheck } from './pdfImport.ts';
import { pairFetchedAt } from './prices.ts';
import type { PriceIssue, SheetFocus, TableFilter } from './store/types.ts';

export type Severity = 'problem' | 'check' | 'info';
export type SectionId = 'errors' | 'offers' | 'guessed' | 'check' | 'prices' | 'nesting' | 'request' | 'auto';

export const SECTION_TITLE: Record<SectionId, string> = {
  errors: 'Ошибки расчёта',
  offers: 'Предложения ИИ',
  guessed: 'Не найдено в файлах',
  check: 'Проверить',
  prices: 'Цены металла',
  nesting: 'Раскрой',
  request: 'Заявка',
  auto: 'Изменено ИИ',
};

export type AttentionKind =
  | 'nogeom'
  | 'massBad'
  | 'aiProblem'
  | 'aiOffer'
  | 'guessed'
  | 'massWarn'
  | 'scale'
  | 'break'
  | 'variant'
  | 'aiCheck'
  | 'textHint'
  | 'priceEstimate'
  | 'priceFailed'
  | 'priceStale'
  | 'split'
  | 'cutPrice'
  | 'requestLine'
  | 'qtyUnverified'
  | 'aiUnchecked'
  | 'aiAuto';

export type AttentionAction =
  | { kind: 'open'; positionId: string; focus?: SheetFocus; label?: string } // «Открыть»
  | { kind: 'ack' } // «Верно» (подпись можно заменить у замечания: «Не нужна»)
  | { kind: 'accept'; suggestionIds: string[]; label: string } // «Принять 08пс х/к» / «Принять для 2»
  | { kind: 'reject'; suggestionIds: string[] } // «Отклонить»
  | { kind: 'revert'; suggestionIds: string[]; label: string } // «Вернуть 1 шт»
  | { kind: 'setDims'; positionId: string } // «Задать габарит»
  | { kind: 'drawing'; positionId: string } // «Чертёж»
  | { kind: 'addPart'; name: string; qty: number } // «+ Добавить деталь»
  | { kind: 'group'; groupKey: string; label: string } // «Своя цена ₽/кг» / «Другой лист…» → вкладка металла
  | { kind: 'refreshPrices' } // «Обновить цены»
  | { kind: 'runAi' } // «Запустить анализ ИИ»
  | { kind: 'filter'; filter: TableFilter; label: string }; // «Показать непроверенные»

export interface Evidence {
  quote: string;
  found: 'drawing' | 'request' | 'document' | null;
  where?: string;
}

export interface AttentionItem {
  id: string; // с отпечатком значения: «Верно» относится к конкретному значению
  severity: Severity;
  section: SectionId;
  kind: AttentionKind;
  positionId?: string;
  groupKey?: string;
  title: string; // у позиции начинается с её названия
  text?: string;
  evidence?: Evidence[];
  actions: AttentionAction[]; // в порядке показа; первое — основное; 'ack' всегда последнее
  ackLabel?: string; // по умолчанию «Верно»
  closed: boolean;
  closedBy?: 'state' | 'check' | 'decision';
}

/** Одинаковые предложения ИИ для ≥ 2 позиций — показываются одной строкой («Принять для 2») */
export interface OfferGroup {
  key: string;
  title: string;
  suggestionIds: string[];
  positionIds: string[];
}

export interface Attention {
  items: AttentionItem[]; // все: по разделам, затем по важности, затем по порядку позиций
  open: AttentionItem[]; // problem + check, не закрытые, в ПОРЯДКЕ РАЗБОРА: сначала problem, потом check
  byPosition: Map<string, AttentionItem[]>; // открытые замечания по позициям
  sections: { id: SectionId; title: string; items: AttentionItem[] }[]; // непустые, открытые + info
  offerGroups: OfferGroup[];
  counts: { problem: number; check: number; info: number; total: number; resolved: number }; // problem/check — открытые; total = problem + check (открытые + закрытые)
  done: boolean; // open.length === 0
}

export interface AttentionInput {
  order: Order; // базовые позиции, ai, checks, aiScope, requestLines, documents, request
  positions: OrderPosition[]; // с применёнными предложениями ИИ
  res: OrderResult;
  baseRes: OrderResult;
  book: PriceBook;
  settings: Settings;
  live: boolean;
  priceIssue: PriceIssue | null;
  aiContext: AiContext | null;
  outdated: boolean;
}

// ---------- подписи (как в components/common/aiFormat.ts) ----------

const FIELD_LABEL: Record<AiField, string> = {
  materialId: 'Материал',
  thickness: 'Толщина',
  qty: 'Количество',
  bends: 'Гибы',
  extras: 'Доп. работа',
  disabled: 'Расчёт',
};

const matShort = (id: string) => MATERIAL_BY_ID.get(id)?.short ?? id;
/** «08пс холоднокатаный» — название без пояснения в скобках */
const matName = (id: string) => (MATERIAL_BY_ID.get(id)?.label ?? id).replace(/\s*\([^)]*\)/g, '').trim();
const mm = (t: number) => `${n1(t)}${NBSP}мм`;
const pcs = (n: number) => `${n0(n)}${NBSP}шт`;
const bendsText = (n: number) => `${n0(n)}${NBSP}${plural(Math.round(n), 'гиб', 'гиба', 'гибов')}`;
/** Знак и число: «+18», «−7» (U+2212) */
const signed = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${n0(Math.abs(v))}`;
const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s);

function valueText(f: AiField, v: unknown): string {
  if (v == null) return '—';
  switch (f) {
    case 'materialId':
      return matShort(String(v));
    case 'thickness':
      return mm(Number(v));
    case 'qty':
      return pcs(Number(v));
    case 'bends':
      return bendsText(Number(v));
    case 'extras': {
      const e = v as { label?: string; perPiece?: number };
      return `${(e.label ?? '').trim()} ${rub(Number(e.perPiece) || 0)}`;
    }
    case 'disabled':
      return v ? 'исключена' : 'в расчёте';
  }
}

/** Значение предложения: «08пс х/к», «1,5 мм», «5 шт», «3 гиба», «+ Сварка 244 ₽» */
function offerValue(s: AiSuggestion): string {
  switch (s.kind) {
    case 'material':
      return matShort(s.materialId ?? '');
    case 'thickness':
      return mm(s.value ?? 0);
    case 'qty':
      return pcs(s.value ?? 0);
    case 'bends':
      return bendsText(s.value ?? 0);
    case 'extra':
      return `+ ${(s.label ?? '').trim()} ${rub(s.perPiece ?? 0)}`;
    case 'disable':
      return 'Исключить из расчёта';
  }
}

/** Подпись кнопки «Принять …» для предложения */
export function acceptLabel(s: AiSuggestion): string {
  if (s.kind === 'disable') return 'Исключить';
  if (s.kind === 'extra') return `Принять «${clip((s.label ?? '').trim(), 28)}»`;
  return `Принять ${offerValue(s)}`;
}

/** Текущее значение поля позиции (для «было → станет») */
function currentValue(p: OrderPosition, s: AiSuggestion): unknown {
  const f = FIELD_OF[s.kind];
  if (f === 'extras') return null;
  if (f === 'disabled') return !!p.disabled;
  return p[f];
}

/** «{name} — Количество: 1 шт → 5 шт?», «{name} — исключить из расчёта?» */
export function offerTitle(name: string, p: OrderPosition, s: AiSuggestion): string {
  if (s.kind === 'disable') return `${name} — исключить из расчёта?`;
  if (s.kind === 'extra') return `${name} — доп. работа: ${offerValue(s)}/шт?`;
  return `${name} — ${FIELD_LABEL[FIELD_OF[s.kind]]}: ${valueText(FIELD_OF[s.kind], currentValue(p, s))} → ${offerValue(s)}?`;
}

/** «{name} — Количество: 1 шт → 5 шт (ИИ)», «{name} — исключена из расчёта (ИИ)» */
export function changeTitle(name: string, c: AiChange): string {
  if (c.field === 'disabled') return `${name} — исключена из расчёта (ИИ)`;
  if (c.field === 'extras') return `${name} — доп. работа: ${valueText('extras', c.to)}/шт (ИИ)`;
  return `${name} — ${FIELD_LABEL[c.field]}: ${valueText(c.field, c.from)} → ${valueText(c.field, c.to)} (ИИ)`;
}

/** Подпись «вернуть как было» для применённого изменения */
export function revertLabel(c: AiChange): string {
  if (c.field === 'disabled') return 'Вернуть в расчёт';
  if (c.field === 'extras') return 'Убрать';
  return `Вернуть ${valueText(c.field, c.from)}`;
}

// ---------- первое предложение комментария ИИ ----------

const ABBR = /(?:^|[\s(«])(?:шт|мм|см|кг|г|м|т|п|д|др|пр|т\.е|т\.к|т\.н|им|отв|рис|табл|черт|стр|ст|прим|изм|ед|экз|сб|рез|разд|гл)$/i;
/** Единица после числа («1 шт.») и дальше — новое предложение с заглавной: точка всё же конец предложения */
const UNIT_END = /\d\s?(?:шт|мм|см|кг|г|м|т)$/i;

/** Первое предложение (не внутри «…», не на сокращении «шт.», не в числе «1.5») и остаток */
export function splitSentence(text: string): { head: string; rest: string } {
  const t = text.trim();
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === '«') depth++;
    else if (ch === '»') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (ch === '.' || ch === '!' || ch === '?')) {
      const next = t[i + 1];
      if (next !== undefined && !/\s/.test(next)) continue;
      if (ch === '.' && ABBR.test(t.slice(Math.max(0, i - 8), i))) {
        if (!UNIT_END.test(t.slice(Math.max(0, i - 8), i)) || !/^\s+[A-ZА-ЯЁ«]/.test(t.slice(i + 1))) continue;
      }
      const rest = t.slice(i + 1).trim();
      if (rest && !/^[A-ZА-ЯЁ«"(\d]/.test(rest)) continue;
      return { head: t.slice(0, ch === '.' ? i : i + 1).trim(), rest };
    }
  }
  return { head: t.replace(/\.$/, ''), rest: '' };
}

const TITLE_MAX = 110; // заголовок в списке — не больше двух строк

/** Последняя «; » вне «…» и (…) в пределах [min, max] — граница части предложения; −1 — нет */
function clauseBreak(s: string, min: number, max: number): number {
  let depth = 0;
  let best = -1;
  for (let i = 0; i < Math.min(s.length, max); i++) {
    const ch = s[i];
    if (ch === '«' || ch === '(') depth++;
    else if ((ch === '»' || ch === ')') && depth > 0) depth--;
    else if (depth === 0 && ch === ';' && s[i + 1] === ' ' && i >= min) best = i;
  }
  return best;
}

/** Место обрезки по пробелу не дальше max и не внутри «…» (отметка цитаты остаётся при ней) */
function wordCut(s: string, max: number): number {
  let depth = 0;
  let best = -1;
  for (let i = 0; i < s.length && i <= max; i++) {
    const ch = s[i];
    if (ch === '«') depth++;
    else if (ch === '»' && depth > 0) depth--;
    else if (ch === ' ' && depth === 0) best = i;
  }
  return best > 40 ? best : max;
}

const capFirst = (s: string) => s.replace(/^[а-яё]/, (ch) => ch.toUpperCase());
const withDot = (s: string) => (/[.!?…]$/.test(s) ? s : `${s}.`);

/** Заголовок замечания ИИ и пояснение без повторов: первое предложение — в заголовок, остальное — в текст.
 *  Длинное первое предложение делится по «;» (иначе — по слову с «…»), хвост переходит в пояснение */
export function aiTitle(name: string, comment: string, fallback: string): { title: string; text?: string } {
  const out = (title: string, ...text: string[]) => {
    const t = text.filter(Boolean).join(' ');
    return t ? { title: `${name} — ${title}`, text: t } : { title: `${name} — ${title}` };
  };
  const c = comment.trim();
  if (!c) return out(fallback);
  const { head, rest } = splitSentence(c);
  if (head.length <= TITLE_MAX) return out(head, rest);
  const at = clauseBreak(head, 20, TITLE_MAX);
  if (at > 0) return out(head.slice(0, at), withDot(capFirst(head.slice(at + 1).trim())), rest);
  if (head.length <= TITLE_MAX + 50) return out(head, rest); // короткий хвост не отрываем
  const cut = wordCut(head, TITLE_MAX);
  return out(`${head.slice(0, cut).replace(/[\s,;:—–-]+$/, '')}…`, `…${withDot(head.slice(cut).trim())}`, rest);
}

// ---------- подсказки по тексту чертежа (без анализа ИИ, §5.1.1) ----------

const HINTS: { key: string; re: RegExp }[] = [
  { key: 'paint', re: /покраск|окраск|порошков|эмал|грунт|RAL\s?\d{4}/iu },
  { key: 'zinc', re: /цинков/iu },
  { key: 'thread', re: /резьб|(?<![\p{L}\d])[МM]\d{1,2}(?:[xх×]\d+(?:[.,]\d+)?)?(?![\p{L}\d.,])(?!\s*:)/iu },
  { key: 'csink', re: /зенков|фаск/iu },
  { key: 'weld', re: /свар|шов\s*С\d|(?<![\p{L}\d])С\d{1,2}(?![\p{L}\d]).*шов/iu },
  { key: 'roll', re: /вальц|обечайк/iu },
  { key: 'press', re: /запресс|PEM|(?<!\p{L})гайк|(?<!\p{L})шпильк/iu },
  { key: 'clean', re: /зачист|заусен/iu },
  { key: 'tumble', re: /галтов/iu },
  { key: 'assy', re: /сборк/iu },
];
const HINT_SKIP = /общие допуски|размеры для справок|острые кромки притупить/iu;

/** Фрагмент строки вокруг совпадения: ±30 символов, по границам слов */
function around(line: string, at: number, len: number): string {
  let a = Math.max(0, at - 30);
  let b = Math.min(line.length, at + len + 30);
  if (a > 0) {
    const sp = line.lastIndexOf(' ', a);
    a = sp >= 0 && at - sp <= 45 ? sp + 1 : a;
  }
  if (b < line.length) {
    const sp = line.indexOf(' ', b);
    b = sp >= 0 && sp - (at + len) <= 45 ? sp : b;
  }
  const mid = line
    .slice(a, b)
    .replace(/^[\s.,;:–—-]+/, '')
    .trim();
  return `${a > 0 ? '…' : ''}${mid}${b < line.length ? '…' : ''}`;
}

/** Найденные ключевые слова: ключ → фрагмент строки. Строка, где уже нашлась операция раньше по списку
 *  (например, «сварные швы зачистить» — это сварка), другим ключам не засчитывается */
export function textHints(text: string): { key: string; fragment: string }[] {
  const out: { key: string; fragment: string }[] = [];
  const lines = text
    .split(/\n+/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l && !HINT_SKIP.test(l));
  const found: RegExp[] = [];
  for (const { key, re } of HINTS) {
    for (const line of lines) {
      const m = re.exec(line);
      if (!m || found.some((f) => f.test(line))) continue;
      out.push({ key, fragment: around(line, m.index, m[0].length) });
      found.push(re);
      break;
    }
  }
  return out;
}

// ---------- предупреждения разбора, которые уже показаны замечаниями ----------

const COVERED = [
  /^PDF — скан/,
  /^Масштаб вида не подтверждён/,
  /^Вид с обрывом/,
  /^На чертеже таблица исполнений/,
  /^Не помещается на лист/,
  /^В файле нет геометрии/,
  /^Не найдено ни одного замкнутого контура/,
  /^На чертеже не найден замкнутый контур/,
  /^В PDF нет векторной геометрии/,
];

/** Предупреждение разбора/расчёта уже показано замечанием (таблица не дублирует его значком «⚠») */
export function isCoveredWarning(w: string): boolean {
  return COVERED.some((re) => re.test(w));
}

// ---------- сборка ----------

const SECTION_ORDER = Object.keys(SECTION_TITLE) as SectionId[];
const SEV_RANK: Record<Severity, number> = { problem: 0, check: 1, info: 2 };

/** Без размеров: металл и резка не посчитаны */
export const noGeometry = (p: OrderPosition) => p.geom.netArea <= 0 || p.geom.cutLength <= 0;
const isScan = (p: OrderPosition) => p.pdf?.meta.scaleWhy === 'скан';
const scaleText = (s: number) => (s >= 1 ? `1:${n1(s)}` : `${n1(1 / s)}:1`);
const groupTitle = (g: GroupResult) => `${matName(g.material.id)} ${mm(g.t)}`;

interface Draft extends AttentionItem {
  order: number; // порядок позиции (заказ — в конце раздела)
}

/** Куда вести по замечанию позиции (поле карточки) */
export function focusOf(item: AttentionItem): SheetFocus | undefined {
  for (const a of item.actions) if (a.kind === 'open' && a.focus) return a.focus;
  if (item.kind === 'nogeom') return 'dims';
  if (item.kind === 'aiProblem' || item.kind === 'aiCheck' || item.kind === 'aiOffer' || item.kind === 'aiAuto') return 'ai';
  return undefined;
}

export function buildAttention(i: AttentionInput): Attention {
  const { order, res, book, settings } = i;
  const ai = order.ai;
  const checks = order.checks ?? {};
  const eff = new Map(i.positions.map((p) => [p.id, p]));
  const scope = order.aiScope?.length ? new Set(order.aiScope) : null; // нет списка — считаем, что ИИ видел всё
  let src: EvidenceSources | null = null;
  const evidence = (text: string, positionId?: string) => {
    src ??= evidenceSources(order, i.aiContext);
    const ev = findEvidence(text, src, positionId);
    return ev.length ? ev : undefined;
  };
  const drafts: Draft[] = [];
  const add = (d: Omit<Draft, 'closed' | 'closedBy'> & { ack?: boolean; decided?: boolean }) => {
    const { ack, decided, ...rest } = d;
    const checked = ack && !!checks[d.id];
    const closedBy = decided ? 'decision' : checked ? 'check' : undefined;
    drafts.push({ ...rest, closed: !!closedBy, ...(closedBy ? { closedBy } : {}) });
  };
  const ACK = { kind: 'ack' } as const;

  order.positions.forEach((base, index) => {
    if (base.disabled) return; // исключённые вручную — без замечаний
    const p = eff.get(base.id) ?? base;
    const name = base.name || base.fileName || `Позиция ${index + 1}`;
    const review = reviewFor(ai, base.id);
    const changes = ai ? changesFor(base, ai) : [];

    // исключена по предложению ИИ: только «Изменено ИИ» с «Вернуть в расчёт»
    if (p.disabled) {
      for (const c of changes) {
        if (c.field !== 'disabled') continue;
        add({
          id: `auto:${c.suggestion.id}`,
          severity: 'info',
          section: 'auto',
          kind: 'aiAuto',
          positionId: base.id,
          order: index,
          title: changeTitle(name, c),
          text: c.suggestion.reason || undefined,
          evidence: evidence(c.suggestion.reason, base.id),
          actions: [{ kind: 'revert', suggestionIds: [c.suggestion.id], label: revertLabel(c) }],
        });
      }
      return;
    }

    const nogeom = p.qty > 0 && noGeometry(p);
    const chk = nogeom ? null : pdfCheck(p);
    const meta = p.pdf?.meta;
    const r = res.positions.get(base.id);
    const pending = (s: AiSuggestion) => isApplicable(s) && decisionOf(ai, s.id) === 'pending';

    // ошибки расчёта
    if (nogeom) {
      const actions: AttentionAction[] = [{ kind: 'setDims', positionId: base.id }];
      if (p.pdf) actions.push({ kind: 'drawing', positionId: base.id });
      actions.push({ kind: 'open', positionId: base.id });
      add({
        id: `nogeom:${base.id}`,
        severity: 'problem',
        section: 'errors',
        kind: 'nogeom',
        positionId: base.id,
        order: index,
        title: isScan(p) ? `${name} — нет размеров (скан)` : `${name} — контур не найден`,
        text: 'Резка и металл не посчитаны — задайте габарит вручную.',
        actions,
      });
    }
    if (chk && chk.ratio != null && chk.drawing != null && (chk.status === 'bad' || chk.status === 'warn')) {
      const pct = signed(Math.round((chk.ratio - 1) * 100));
      const bad = chk.status === 'bad';
      add({
        id: `mass:${base.id}:${pct}`,
        severity: bad ? 'problem' : 'check',
        section: bad ? 'errors' : 'check',
        kind: bad ? 'massBad' : 'massWarn',
        positionId: base.id,
        order: index,
        title: bad
          ? `${name} — масса не сходится: ${kg(chk.calc)} по контуру, ${kg(chk.drawing)} по чертежу (${pct}${NBSP}%)`
          : `${name} — масса расходится на ${pct}${NBSP}%: ${kg(chk.calc)} / ${kg(chk.drawing)}`,
        text: bad ? 'Проверьте вид и масштаб на чертеже.' : undefined,
        actions: [{ kind: 'drawing', positionId: base.id }, ACK],
        ack: true,
      });
    }

    // анализ ИИ по позиции: проблема / проверить (предложения — внутри замечания). Подтверждения в комментарии
    // («Заявка 5 шт, в расчёте 5 шт») — не замечание, и в сохранённых анализах тоже: остались только они
    // и предложений нет — замечания нет
    const aiComment = review && review.status !== 'ok' ? stripConfirmations(review.comment) : '';
    const offers = review && review.status !== 'ok' ? review.suggestions.filter(isApplicable) : [];
    if (review && review.status !== 'ok' && (aiComment || offers.length)) {
      const open = offers.filter(pending);
      const actions: AttentionAction[] = [];
      for (const s of open) actions.push({ kind: 'accept', suggestionIds: [s.id], label: acceptLabel(s) }, { kind: 'reject', suggestionIds: [s.id] });
      actions.push({ kind: 'open', positionId: base.id, focus: 'ai' }, ACK);
      const problem = review.status === 'problem';
      const t = aiTitle(name, aiComment, problem ? 'ИИ нашёл проблему' : 'ИИ просит проверить');
      add({
        // id — по исходному комментарию: «Верно», отмеченное раньше, остаётся в силе
        id: `ai:${base.id}:${cyrb53(review.status + review.comment).toString(36)}`,
        severity: problem ? 'problem' : 'check',
        section: problem ? 'errors' : 'check',
        kind: problem ? 'aiProblem' : 'aiCheck',
        positionId: base.id,
        order: index,
        ...t,
        evidence: evidence(aiComment, base.id),
        actions,
        ack: true,
        decided: offers.length > 0 && open.length === 0,
      });
    }

    // предложения ИИ при статусе «в порядке» — отдельными строками
    if (review && review.status === 'ok') {
      for (const s of review.suggestions) {
        if (!isApplicable(s)) continue;
        const decided = decisionOf(ai, s.id) !== 'pending';
        add({
          id: `offer:${s.id}`,
          severity: 'check',
          section: 'offers',
          kind: 'aiOffer',
          positionId: base.id,
          order: index,
          title: offerTitle(name, p, s),
          text: s.reason || undefined,
          evidence: evidence(s.reason, base.id),
          actions: decided
            ? []
            : [
                { kind: 'accept', suggestionIds: [s.id], label: s.kind === 'disable' ? 'Исключить' : 'Принять' },
                { kind: 'reject', suggestionIds: [s.id] },
              ],
          decided,
        });
      }
    }

    // не найдено в файлах (по позиции с изменениями ИИ: поле, изменённое ИИ, уже не угадано)
    const GUESS: {
      field: 'material' | 'thickness' | 'qty';
      kind: AiSuggestion['kind'];
      focus: SheetFocus;
      word: string;
      value: () => string;
      raw: () => string;
    }[] = [
      { field: 'material', kind: 'material', focus: 'material', word: 'материал не найден', value: () => matShort(p.materialId), raw: () => p.materialId },
      { field: 'thickness', kind: 'thickness', focus: 'thickness', word: 'толщина не найдена', value: () => mm(p.thickness), raw: () => String(p.thickness) },
      { field: 'qty', kind: 'qty', focus: 'qty', word: 'количество не найдено', value: () => pcs(p.qty), raw: () => String(p.qty) },
    ];
    for (const g of GUESS) {
      const id = `guess:${base.id}:${g.field}:${g.raw()}`;
      if (!p.guessed[g.field] && !checks[id]) continue;
      const actions: AttentionAction[] = [];
      const offer = review?.suggestions.find((s) => s.kind === g.kind && pending(s));
      if (offer && p.guessed[g.field]) actions.push({ kind: 'accept', suggestionIds: [offer.id], label: acceptLabel(offer) });
      actions.push({ kind: 'open', positionId: base.id, focus: g.focus }, ACK);
      add({
        id,
        severity: 'check',
        section: 'guessed',
        kind: 'guessed',
        positionId: base.id,
        order: index,
        title: `${name} — ${g.word} в файлах: стоит ${g.value()}`,
        text: 'Проверьте по чертежу или заявке.',
        actions,
        ack: true,
      });
    }

    // чертёж: масштаб, обрыв, исполнение (контур из PDF)
    if (meta && !nogeom && p.pdf?.geometryFromPdf) {
      if (/нет подтверждений/.test(meta.scaleWhy)) {
        add({
          id: `scale:${base.id}:${meta.scale}`,
          severity: 'check',
          section: 'check',
          kind: 'scale',
          positionId: base.id,
          order: index,
          title: `${name} — масштаб вида не подтверждён`,
          text: `Масштаб ${scaleText(meta.scale)} взят без совпадения размеров или массы — проверьте габарит.`,
          actions: [{ kind: 'drawing', positionId: base.id }, ACK],
          ack: true,
        });
      }
      if (meta.base.brk && !meta.base.brk.target && !(meta.table && meta.row >= 0)) {
        const len = Math.round(Math.max(p.geom.width, p.geom.height));
        add({
          id: `break:${base.id}:${len}`,
          severity: 'check',
          section: 'check',
          kind: 'break',
          positionId: base.id,
          order: index,
          title: `${name} — вид с обрывом: настоящая длина не найдена`,
          text: `Сейчас длина ${n0(len)}${NBSP}мм — проверьте габарит по размерам на чертеже.`,
          actions: [{ kind: 'drawing', positionId: base.id }, ACK],
          ack: true,
        });
      }
    }
    if (meta?.table && meta.row < 0 && meta.table.rows.length) {
      // «как нарисовано» тоже бывает верным выбором — поэтому есть «Верно»
      add({
        id: `variant:${base.id}`,
        severity: 'check',
        section: 'check',
        kind: 'variant',
        positionId: base.id,
        order: index,
        title: `${name} — не выбрано исполнение (в таблице ${meta.table.rows.length})`,
        text: 'Сейчас считается как нарисовано. Выберите исполнение из таблицы на чертеже.',
        actions: [{ kind: 'open', positionId: base.id, focus: 'variant', label: 'Выбрать' }, ACK],
        ack: true,
      });
    }

    // без анализа ИИ: ключевые слова в тексте чертежа
    if (!ai && p.drawingText) {
      for (const h of textHints(p.drawingText)) {
        add({
          id: `hint:${base.id}:${h.key}`,
          severity: 'check',
          section: 'check',
          kind: 'textHint',
          positionId: base.id,
          order: index,
          title: `${name} — в тексте чертежа: «${h.fragment}» — проверьте доп. операции`,
          actions: [{ kind: 'open', positionId: base.id, focus: 'extras' }, ACK],
          ack: true,
        });
      }
    }

    // раскрой: не помещается на лист
    if (r?.split) {
      const g = res.groups.find((x) => x.key === r.groupKey);
      const sheet = g ? fmtSheet(g.chosen.offer.w, g.chosen.offer.l) : '';
      const quiet = !!ai && !i.outdated && (!scope || scope.has(base.id)) && (!review || review.status === 'ok');
      const n = r.split.pieces;
      add({
        id: `split:${base.id}:${n}:${sheet}`,
        severity: quiet ? 'info' : 'check',
        section: 'nesting',
        kind: 'split',
        positionId: base.id,
        groupKey: r.groupKey,
        order: index,
        title: `${name} — не помещается на лист ${sheet}: режем из ${n} ${plural(n, 'части', 'частей', 'частей')}`,
        text: `+${meters(r.split.extraCut)} реза на шт.`,
        actions: quiet
          ? [{ kind: 'group', groupKey: r.groupKey, label: 'Другой лист…' }]
          : [{ kind: 'group', groupKey: r.groupKey, label: 'Другой лист…' }, ACK],
        ack: !quiet,
      });
    }

    // резка: такой толщины/материала нет в прайсе — резка не посчитана
    if (r && r.rate.perM == null && r.cutM > 0) {
      const col = CUT_GROUPS.find((g) => g.key === r.rate.group)?.label.toLowerCase() ?? '';
      add({
        id: `cutprice:${base.id}:${r.rate.group}:${p.thickness}`,
        severity: 'problem',
        section: 'errors',
        kind: 'cutPrice',
        positionId: base.id,
        order: index,
        title: `${name} — нет цены резки в прайсе: ${col} ${n1(p.thickness)} мм`,
        text: 'Резка этой позиции не посчитана. Добавьте строку в «Расценки» → «Резка» или смените материал/толщину.',
        actions: [{ kind: 'open', positionId: base.id }],
        ack: false,
      });
    }

    // изменено ИИ (для сведения)
    for (const c of changes) {
      add({
        id: `auto:${c.suggestion.id}`,
        severity: 'info',
        section: 'auto',
        kind: 'aiAuto',
        positionId: base.id,
        order: index,
        title: changeTitle(name, c),
        text: c.suggestion.reason || undefined,
        evidence: evidence(c.suggestion.reason, base.id),
        actions: [{ kind: 'revert', suggestionIds: [c.suggestion.id], label: revertLabel(c) }],
      });
    }
  });

  // ---------- цены металла ----------
  const END = Number.MAX_SAFE_INTEGER;
  const hasBook = Object.keys(book.materials).length > 0;
  const fetched = res.groups.map((g) => pairFetchedAt(book, g.material.id, g.t)).filter((x): x is string => !!x);
  const oldest = fetched.length ? fetched.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b)) : book.updatedAt;
  if (hasBook) {
    for (const g of res.groups) {
      const o = g.chosen.offer;
      if (o.source !== 'estimate') continue;
      const ppk = Math.round(o.pricePerKg * 10) / 10;
      add({
        id: `estimate:${g.key}:${ppk}`,
        severity: 'check',
        section: 'prices',
        kind: 'priceEstimate',
        groupKey: g.key,
        order: END,
        title: `${groupTitle(g)} — нет на mc.ru, цена ${n1(ppk)}${NBSP}₽/кг — оценка`,
        text: o.note || undefined,
        actions: [{ kind: 'group', groupKey: g.key, label: 'Своя цена ₽/кг' }, ACK],
        ack: true,
      });
    }
  }
  if (i.priceIssue) {
    const actions: AttentionAction[] = i.live ? [{ kind: 'refreshPrices' }, ACK] : [ACK];
    add({
      id: `pricefail:${i.priceIssue.at}`,
      severity: 'check',
      section: 'prices',
      kind: 'priceFailed',
      order: END,
      title: `Цены mc.ru не обновлены: ${i.priceIssue.reason}`,
      text: oldest ? `Расчёт по ценам от ${dateDay(oldest)}.` : undefined,
      actions,
      ack: true,
    });
  } else if (i.live && hasBook) {
    // старые цены (после неудачного обновления — одно замечание выше, без повторов по группам)
    const maxAge = settings.priceMaxAgeHours ?? 24;
    for (const g of res.groups) {
      if (g.chosen.offer.source !== 'mc') continue;
      const at = pairFetchedAt(book, g.material.id, g.t);
      if (!at || (Date.now() - Date.parse(at)) / 3_600_000 <= maxAge) continue;
      add({
        id: `stale:${g.key}:${at}`,
        severity: 'check',
        section: 'prices',
        kind: 'priceStale',
        groupKey: g.key,
        order: END,
        title: `${groupTitle(g)} — цены от ${dateDay(at)} (старше ${n0(maxAge)}${NBSP}ч)`,
        actions: [{ kind: 'refreshPrices' }, ACK],
        ack: true,
      });
    }
  } else if (!i.live && hasBook && order.positions.length) {
    add({
      id: `snapshot:${oldest ?? ''}`,
      severity: 'info',
      section: 'prices',
      kind: 'priceStale',
      order: END,
      title: `Цены из снимка от ${dateDay(oldest)}`,
      text: 'Статическая версия: обновить цены mc.ru нельзя.',
      actions: [],
    });
  }

  // ---------- заявка ----------
  const have = new Set(order.positions.map((p) => desigKey(p.name)));
  const seenLines = new Set<string>();
  for (const l of order.requestLines ?? []) {
    const k = desigKey(l.designation);
    if (have.has(k) || seenLines.has(k)) continue;
    seenLines.add(k);
    add({
      id: `reqline:${k}:${l.qty}`,
      severity: 'check',
      section: 'request',
      kind: 'requestLine',
      order: END,
      title: `В заявке без чертежа: ${l.designation} — ${pcs(l.qty)}`,
      actions: [{ kind: 'addPart', name: l.designation, qty: l.qty }, ACK],
      ackLabel: 'Не нужна',
      ack: true,
    });
  }
  const enabled = order.positions.filter((p) => !p.disabled);
  if (!ai && enabled.length) {
    add({
      id: `qtyunverified:${enabled.length}`,
      severity: 'check',
      section: 'request',
      kind: 'qtyUnverified',
      order: END,
      title: 'Количество не сверено с заявкой — ИИ не запускался',
      text: 'Сверьте количество по письму клиента.',
      actions: [{ kind: 'runAi' }, ACK],
      ack: true,
    });
  }
  if (ai && scope) {
    const k = enabled.filter((p) => scope.has(p.id)).length;
    if (k < enabled.length) {
      add({
        id: `unchecked:${k}:${enabled.length}`,
        severity: 'info',
        section: 'request',
        kind: 'aiUnchecked',
        order: END,
        title: `ИИ проверил ${k} из ${enabled.length} ${plural(enabled.length, 'позиции', 'позиций', 'позиций')}`,
        text: 'Новые позиции и позиции сверх 150 ИИ не видел.',
        actions: [{ kind: 'filter', filter: 'unchecked', label: 'Показать непроверенные' }],
      });
    }
  }

  // ---------- порядок ----------
  const sec = (s: SectionId) => SECTION_ORDER.indexOf(s);
  const ordered = drafts
    .map((d, n) => ({ d, n }))
    .sort((a, b) => sec(a.d.section) - sec(b.d.section) || SEV_RANK[a.d.severity] - SEV_RANK[b.d.severity] || a.d.order - b.d.order || a.n - b.n)
    .map(({ d }) => {
      const { order: _o, ...item } = d;
      return item as AttentionItem;
    });
  const counted = ordered.filter((x) => x.severity !== 'info');
  const open = counted
    .filter((x) => !x.closed)
    .map((x, n) => ({ x, n }))
    .sort((a, b) => SEV_RANK[a.x.severity] - SEV_RANK[b.x.severity] || a.n - b.n)
    .map(({ x }) => x);
  const byPosition = new Map<string, AttentionItem[]>();
  for (const x of open) {
    if (!x.positionId) continue;
    const list = byPosition.get(x.positionId);
    if (list) list.push(x);
    else byPosition.set(x.positionId, [x]);
  }
  const sections = SECTION_ORDER.map((id) => ({
    id,
    title: SECTION_TITLE[id],
    items: ordered.filter((x) => x.section === id && (x.severity === 'info' || !x.closed)),
  })).filter((s) => s.items.length);
  return {
    items: ordered,
    open,
    byPosition,
    sections,
    offerGroups: offerGroups(order, eff),
    counts: {
      problem: open.filter((x) => x.severity === 'problem').length,
      check: open.filter((x) => x.severity === 'check').length,
      info: ordered.length - counted.length,
      total: counted.length,
      resolved: counted.length - open.length,
    },
    done: open.length === 0,
  };
}

/** Одинаковые ждущие решения предложения (вид, было, станет) для ≥ 2 позиций */
function offerGroups(order: Order, eff: Map<string, OrderPosition>): OfferGroup[] {
  const ai = order.ai;
  if (!ai) return [];
  const groups = new Map<string, OfferGroup & { s: AiSuggestion; from: unknown }>();
  for (const base of order.positions) {
    const p = eff.get(base.id);
    if (base.disabled || !p || p.disabled || aiDisabled(ai, base.id)) continue;
    const review: AiPositionReview | undefined = reviewFor(ai, base.id);
    if (!review) continue;
    const seen = new Set<string>();
    for (const s of review.suggestions) {
      if (!isApplicable(s) || decisionOf(ai, s.id) !== 'pending') continue;
      const from = currentValue(p, s);
      const to =
        s.kind === 'material'
          ? s.materialId
          : s.kind === 'extra'
            ? `${(s.label ?? '').trim().toLowerCase()}|${Math.round(s.perPiece ?? 0)}`
            : s.kind === 'disable'
              ? true
              : s.value;
      const key = `${s.kind}|${s.kind === 'extra' ? '' : String(from)}|${String(to)}`;
      if (seen.has(key)) continue; // одна позиция — одно предложение в группе
      seen.add(key);
      const g = groups.get(key);
      if (g) {
        g.suggestionIds.push(s.id);
        g.positionIds.push(base.id);
      } else groups.set(key, { key, title: '', suggestionIds: [s.id], positionIds: [base.id], s, from });
    }
  }
  const out: OfferGroup[] = [];
  for (const g of groups.values()) {
    const n = g.positionIds.length;
    if (n < 2) continue;
    const tail = ` — ${n}${NBSP}поз.`;
    const s = g.s;
    let title: string;
    if (s.kind === 'qty') title = `Количество ${n0(Number(g.from))} → ${pcs(s.value ?? 0)}`;
    else if (s.kind === 'thickness') title = `Толщина ${n1(Number(g.from))} → ${mm(s.value ?? 0)}`;
    else if (s.kind === 'bends') title = `Гибы ${n0(Number(g.from))} → ${bendsText(s.value ?? 0)}`;
    else if (s.kind === 'material') title = `Материал ${matShort(String(g.from))} → ${matShort(s.materialId ?? '')}`;
    else if (s.kind === 'extra') title = `+ ${(s.label ?? '').trim()} (≈${NBSP}${rub(Math.round(s.perPiece ?? 0))}/шт)`;
    else title = 'Исключить из расчёта';
    out.push({ key: g.key, title: title + tail, suggestionIds: g.suggestionIds, positionIds: g.positionIds });
  }
  return out;
}
