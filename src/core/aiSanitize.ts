// Ответ модели → AiAnalysis. extractJson достаёт JSON-объект из текста (обёртка ```json,
// текст вокруг, рассуждения <think>), sanitizeAnalysis сверяет его с данными заказа:
// только позиции и материалы заказа, числа в допустимых пределах, тексты без markdown
// и обрезаны, повторы убраны. Чистый модуль без зависимостей — и для сервера, и для браузера.

import type { AiAnalysis, AiContext, AiPosition, AiPositionReview, AiStatus, AiSuggestion, AiUsage } from './ai.ts';

/** Ограничения ответа: длины строк и размеры списков */
export const AI_OUTPUT_LIMITS = {
  summary: 1200,
  comment: 600,
  reason: 300,
  item: 400, // вопрос, риск, рекомендация
  operation: 160,
  label: 80, // название доп. операции
  items: 10, // вопросов, рисков, рекомендаций
  operations: 12, // на позицию
  suggestions: 8, // на позицию
} as const;

const L = AI_OUTPUT_LIMITS;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

// ---------- JSON из текста ----------

// поля корня ответа: по ним отличаем сам ответ от вложенного объекта или примера в тексте
const ROOT_KEYS = ['summary', 'positions', 'questions', 'risks', 'recommendations', 'confidence'];
const isRoot = (o: Obj) => ROOT_KEYS.some((k) => k in o);

/** Позиция парной «}» для «{» в start (кавычки и экранирование учтены); -1 — объект не закрыт */
function matchBrace(s: string, start: number): number {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return -1;
}

/** Лишние запятые перед } и ] — частая ошибка моделей */
function dropTrailingCommas(s: string): string {
  let out = '';
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      out += ch;
      if (ch === '\\') out += s[++i] ?? '';
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === ',') {
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      if (s[j] === '}' || s[j] === ']') continue;
    }
    out += ch;
  }
  return out;
}

function parseObject(s: string): Obj | null {
  for (const v of [s, dropTrailingCommas(s)]) {
    try {
      const x: unknown = JSON.parse(v);
      return isObj(x) ? x : null;
    } catch {
      /* пробуем без лишних запятых */
    }
  }
  return null;
}

/** JSON-объект из ответа модели; бросает ошибку, если объекта нет, он обрезан или не разбирается */
export function extractJson(text: string): unknown {
  let s = String(text ?? '')
    .replace(/^﻿/, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();
  if (!s) throw new Error('пустой ответ');
  const fenced = [...s.matchAll(/```[\w-]*[ \t]*\r?\n?([\s\S]*?)```/g)].map((m) => m[1].trim()).find((b) => b.includes('{'));
  s = fenced ?? s.replace(/^```[\w-]*\s*/, ''); // незакрытая обёртка — ответ обрезан
  const whole = parseObject(s);
  if (whole) return whole;
  // объект внутри текста: перебираем «{» слева направо
  let first: Obj | null = null; // первый разобранный объект без полей ответа — на крайний случай
  let blocked = -1; // до этой позиции — внутри неразобранного объекта: его части не подставляем
  let unclosed = false;
  for (let from = s.indexOf('{'), n = 0; from >= 0 && n < 100; n++) {
    const end = matchBrace(s, from);
    if (end < 0) {
      unclosed = true;
      blocked = s.length;
      from = s.indexOf('{', from + 1);
      continue;
    }
    const obj = parseObject(s.slice(from, end + 1));
    if (obj) {
      if (isRoot(obj)) return obj;
      if (!first && from > blocked) first = obj;
      from = s.indexOf('{', end + 1);
    } else {
      blocked = Math.max(blocked, end);
      from = s.indexOf('{', from + 1);
    }
  }
  if (first) return first;
  if (unclosed) throw new Error('JSON обрезан: нет закрывающей скобки');
  throw new Error(s.includes('{') ? 'ответ не разбирается как JSON' : 'в ответе нет JSON-объекта');
}

// ---------- тексты и числа ----------

function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  let t = s.slice(0, max - 1);
  if (/[\uD800-\uDBFF]$/.test(t)) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

/** Текст без markdown и лишних пробелов, не длиннее max */
function text(v: unknown, max: number): string {
  if (typeof v !== 'string') return typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
  const s = v
    .replace(/\r\n?/g, '\n')
    .replace(/\*\*|__|`/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cut(s, max);
}

/** Одна строка: пункт списка, операция, название — без маркера списка в начале */
function line(v: unknown, max: number): string {
  const s = text(v, max * 2)
    .replace(/\s+/g, ' ')
    .replace(/^(?:[-–—•*·]+|\d{1,2}[.)])\s+/, '');
  return cut(s, max);
}

/** Ключ для поиска повторов: регистр, ё, пробелы и знаки не важны */
const normKey = (s: string) =>
  s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, '');

function list(v: unknown, maxItems: number, maxLen: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // список строкой «1. …\n2. …» — по пункту на строку
  for (const x of typeof v === 'string' ? v.split(/\n+/) : arr(v)) {
    const s = line(x, maxLen);
    const k = normKey(s);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

/** Число; строки «1,5» и «7» тоже принимаем — модели иногда пишут числа строкой */
function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*-?\d+(?:[.,]\d+)?\s*$/.test(v) ? Number(v.trim().replace(',', '.')) : NaN;
  return Number.isFinite(n) ? n : null;
}

function int(v: unknown): number | null {
  const n = num(v);
  return n != null && Math.abs(n - Math.round(n)) < 1e-9 ? Math.round(n) : null;
}

const round = (v: number, digits: number) => Math.round(v * 10 ** digits) / 10 ** digits;

// ---------- предложения ----------

type Draft = Omit<AiSuggestion, 'id'>;

/** Число из текста модели: «1 555», «243,6» */
const parseNum = (s: string) => Number(s.replace(/[\s\u00a0\u202f]/g, '').replace(',', '.'));

// число отдельным словом («1 500» — одно число); «м2», «М8», «С2» — не числа
const WORD_NUM = /(?<![\p{L}\d.,])(?:\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?!\d)|\d+)(?:[.,]\d+)?/gu;
const wordNums = (s: string) => [...s.matchAll(WORD_NUM)].map((x) => parseNum(x[0]));

/**
 * Расчёт в reason вида «2 × 0,298 м² × 650 ₽/м² = 388 ₽»: множители и итог. Цепочка — перед «= N ₽»
 * (после предыдущего «=»): последнее число до первого «×» и по одному числу после каждого «×».
 * null — проверять нечего: нет «= N ₽» или «×», в звене два числа, есть +, −, /, скобки.
 */
function reasonChain(reason: string): { factors: number[]; stated: number } | null {
  const m = /=\s*(\d[\d \u00a0\u202f]*(?:[.,]\d+)?)\s*(?:₽|руб)/.exec(reason);
  if (!m) return null;
  const head = reason.slice(0, m.index);
  const parts = head.slice(head.lastIndexOf('=') + 1).split(/[×*]/);
  if (parts.length < 2) return null;
  const last = [...parts[0].matchAll(WORD_NUM)].at(-1);
  if (!last || last.index == null) return null;
  // «(3 − 1) × …», «5 − 2 × …» — первый множитель не одно число
  if (/[-−–+/(]\s*$/.test(parts[0].slice(0, last.index)) || /[)+−–/]/.test(parts[0].slice(last.index + last[0].length).replace(/₽\/\S+/g, ''))) return null;
  const factors = [parseNum(last[0])];
  for (const part of parts.slice(1)) {
    const clean = part.replace(/₽\/\S+/g, ''); // «₽/м²» — единица ставки
    if (/[+()/−–]|\s-\s/.test(clean)) return null;
    const n = wordNums(clean);
    if (n.length !== 1) return null;
    factors.push(n[0]);
  }
  return { factors, stated: parseNum(m[1]) };
}

/** Расчёт в reason сходится (произведение множителей = итог ± 2 %)? null — проверять нечего */
export function reasonArithmeticOk(reason: string): boolean | null {
  const c = reasonChain(reason);
  if (!c) return null;
  const product = c.factors.reduce((a, b) => a * b, 1);
  return Math.abs(product - c.stated) <= Math.max(1, 0.02 * Math.max(product, c.stated));
}

/** Предложение, которое приложение сможет применить; null — невалидное или совпадает с текущим значением */
function suggestion(raw: unknown, p: AiPosition, materials: Set<string>, rates: number[]): Draft | null {
  // позиция исключена из расчёта — менять в ней нечего (и исключать её второй раз тоже)
  if (!isObj(raw) || p.disabled) return null;
  const reason = text(raw.reason, L.reason);
  // значение «как сейчас» не нужно, кроме поля, которое не найдено в файлах (guessed): тогда это
  // подтверждение из штампа или заявки
  switch (String(raw.kind ?? '').trim().toLowerCase()) {
    case 'material': {
      const id = typeof raw.materialId === 'string' ? raw.materialId.trim() : '';
      return materials.has(id) && (id !== p.materialId || p.guessed.material) ? { kind: 'material', materialId: id, reason } : null;
    }
    case 'thickness': {
      const v = num(raw.value);
      if (v == null || v < 0.3 || v > 60) return null;
      const t = round(v, 2);
      return Math.abs(t - p.thickness) > 1e-9 || p.guessed.thickness ? { kind: 'thickness', value: t, reason } : null;
    }
    case 'qty': {
      const v = int(raw.value);
      return v != null && v >= 1 && v <= 100_000 && (v !== p.qty || p.guessed.qty) ? { kind: 'qty', value: v, reason } : null;
    }
    case 'bends': {
      const v = int(raw.value);
      return v != null && v >= 0 && v <= 50 && v !== p.bends ? { kind: 'bends', value: v, reason } : null;
    }
    case 'extra': {
      const label = line(raw.label, L.label);
      const v = num(raw.perPiece);
      if (!label || v == null || v < 0 || v > 1_000_000) return null;
      // такая работа у позиции уже есть — второй раз не добавляем
      if (p.extras.some((e) => normKey(e.label) === normKey(label))) return null;
      // в reason расчёт «… = 244 ₽», а в perPiece другое число — модель запуталась; доп. работы
      // применяются автоматически, поэтому такое предложение не берём (операция останется в operations)
      const stated = /=\s*(\d[\d \u00a0\u202f]*(?:[.,]\d+)?)\s*(?:₽|руб)/.exec(reason);
      if (stated) {
        const s = parseNum(stated[1]);
        if (Math.abs(s - v) > Math.max(1, 0.05 * Math.max(s, v))) return null;
      }
      // и сам расчёт должен сходиться («2 × 0,3 м² × 650 ₽/м² = 777 ₽» — ошибка умножения), а цена —
      // по ставке Расценок: среди множителей есть ставка (иначе цену модель придумала)
      if (reasonArithmeticOk(reason) === false) return null;
      const chain = reasonChain(reason);
      if (chain && rates.length && !chain.factors.some((f) => rates.some((r) => Math.abs(f - r) <= Math.max(0.01, 0.005 * r)))) return null;
      return { kind: 'extra', label, perPiece: round(v, 2), reason };
    }
    case 'disable':
      // исключить позицию: только обоснование (цитата или подсказка программы), прочие поля не нужны;
      // само не применяется — решает менеджер, поэтому без причины предложение бесполезно
      return reason ? { kind: 'disable', reason } : null;
  }
  return null;
}

// одно предложение на поле; доп. операций может быть несколько, но разных
const dedupKey = (s: Draft) => (s.kind === 'extra' ? `extra:${normKey(s.label ?? '')}` : s.kind);

// ---------- подтверждения в комментарии ----------

interface Clause {
  text: string;
  end: '' | '.' | ';' | '!' | '?'; // знак после части фразы ('' — конец текста без знака)
  gap: string; // пробелы после знака
  drop?: boolean;
}

/** Части комментария по «.», «;», «!», «?» вне «…» и (…); точка в числе («1.5»), обозначении («НГЭН.745421»)
 *  и перед строчной буквой (сокращение: «5 шт. на изделие») часть не завершает */
function clausesOf(s: string): Clause[] {
  const out: Clause[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '«' || ch === '(') depth++;
    else if ((ch === '»' || ch === ')') && depth > 0) depth--;
    else if (depth === 0 && (ch === ';' || ch === '.' || ch === '!' || ch === '?')) {
      const after = s.slice(i + 1);
      const gap = /^\s*/.exec(after)![0];
      if (!gap && after) continue;
      if (ch !== ';' && after.length > gap.length && /^\p{Ll}/u.test(after.slice(gap.length))) continue;
      out.push({ text: s.slice(start, i).trim(), end: ch, gap });
      start = i + 1 + gap.length;
      i = start - 1;
    }
  }
  if (s.slice(start).trim()) out.push({ text: s.slice(start).trim(), end: '', gap: '' });
  return out;
}

/** Части фразы через «, » вне «…» и (…) («8,6 кг» — не граница) */
function commaParts(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '«' || ch === '(') depth++;
    else if ((ch === '»' || ch === ')') && depth > 0) depth--;
    else if (depth === 0 && ch === ',' && /\s/.test(s[i + 1] ?? '')) {
      out.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(s.slice(start).trim());
  return out;
}

// число отдельно: не часть обозначения («НГЭН.745421.0001», «К-ПУ-3», «-01», «Ст3») и марки («08пс», «12Х18Н10Т»);
// «5шт», «2мм» — число с единицей
const NUM_RE = /(?<![\p{L}\p{N}.,\-–−])\d+(?:[.,]\d+)?(?!\p{N})/gu;
const UNIT_AFTER = /^(?:шт|мм|см|кг|м|г|т|руб|р(?!\p{L})|₽|%)/iu;

/** Разные числа части фразы */
function numbersIn(s: string): Set<number> {
  const out = new Set<number>();
  for (const m of s.matchAll(NUM_RE)) {
    const after = s.slice((m.index ?? 0) + m[0].length);
    if (/^\p{L}/u.test(after) && !UNIT_AFTER.test(after)) continue;
    out.add(Number(m[0].replace(',', '.')));
  }
  return out;
}

const QTY_RE = /(?<![\p{L}\p{N}.,\-–−])(\d+)\s*шт/giu;
const HAS_QTY = new RegExp(QTY_RE.source, 'iu');
const CALC_RE = /расч[её]т/iu;
// отрицание или противопоставление — фраза уже не простое подтверждение
const CONTRAST = /(?<![\p{L}\p{N}])(?:не|нет|ни|но|а|однако|хотя|зато|кроме)(?![\p{L}\p{N}])/iu;
// «… — верно», «… — совпадает с заявкой», «… — соответствует штампу»; хвост без запятой («— совпадает, но …» — не то)
const CONFIRM_TAIL =
  /\s[—–-]\s*(?:(?:всё|все|это)\s+)?(?:верно|правильно|совпада(?:ет|ют)|соответству(?:ет|ют)|подтвержда(?:ет|ется|ются)|подтвержден[оаы]?|в\s+порядке|как\s+в\s+[^,—–]+)(?:\s[^,—–]*)?$/iu;
// без тире: «Количество 5 шт совпадает с заявкой», «Материал соответствует штампу»
const CONFIRM_VERB =
  /\s(?:совпада(?:ет|ют)|соответству(?:ет|ют))\s+(?:со?\s+)?(?:заявк|документ|спецификац|письм|штамп|чертеж|чертёж|таблиц|расч[её]т|[\p{L}\p{N}_-]+\.(?:txt|pdf))[^,—–]*$/iu;
// часть фразы целиком — подтверждение: «Всё верно», «Остальное в порядке»
const CONFIRM_ONLY = /^(?:(?:всё|все|остальное|в\s+остальном)\s+)*(?:верно|правильно|в\s+порядке|подтвержден[оаы]?|совпада(?:ет|ют)|соответству(?:ет|ют))$/iu;
// пересказ подсказки программы «(не замечание, в ответ не включай) помещается в выбранный лист целиком»:
// деталь режется целиком — замечания нет («не помещается» — есть, его не трогаем)
const HINT_ECHO = /\(не\s+замечание|в\s+ответ\s+не\s+включай/iu;
const FITS_WHOLE = /(?<!\p{L})(?<!не\s)(?:помещается|влезает)\s+(?:в\s+)?(?:выбранный\s+|этот\s+|один\s+|весь\s+)?лист\s+целиком/iu;
const NEGATION = /(?<![\p{L}\p{N}])(?:не|нет|ни)(?![\p{L}\p{N}])/iu;

/**
 * Одно и то же количество дважды («Заявка 5 шт, в расчёте 5 шт», «в text.txt 5 шт, в расчёте 5 шт — верно»):
 * часть фразы без этого сравнения; '' — от неё ничего не осталось, null — сравнения нет (или в нём разные числа)
 */
function withoutEqualQty(text: string): string | null {
  const qty = [...text.matchAll(QTY_RE)].map((m) => Number(m[1]));
  if (qty.length < 2 || qty.some((q) => q !== qty[0]) || !CALC_RE.test(text)) return null;
  const parts = commaParts(text);
  const at = parts.map((p, n) => (HAS_QTY.test(p) ? n : -1)).filter((n) => n >= 0);
  const [i, j] = [at[0], at[at.length - 1]];
  if (at.length !== j - i + 1) return null; // между упоминаниями количества — что-то ещё: не трогаем
  const fragment = parts.slice(i, j + 1).join(', ');
  if (!CALC_RE.test(fragment) || numbersIn(fragment).size > 1) return null;
  const rest = [...parts.slice(0, i), ...parts.slice(j + 1)].join(', ');
  return i === 0 ? rest.replace(/^(?:и|а|но|однако|при\s+этом)\s+/iu, '') : rest;
}

const capFirst = (s: string) => s.replace(/^\p{Ll}/u, (ch) => ch.toUpperCase());
const END_RANK: Record<Clause['end'], number> = { '': 0, ';': 1, '.': 2, '!': 2, '?': 2 };

/**
 * Комментарий ИИ без подтверждений: части фразы, где количество из заявки или документа равно расчёту
 * («Заявка 5 шт, в расчёте 5 шт»), части, которые кончаются на «— верно / совпадает / соответствует …»,
 * и пересказ подсказки «помещается в лист целиком». Часть с двумя разными числами («В заявке 5 шт,
 * в расчёте 1 шт — …») не выбрасывается никогда. Оставшееся — с исправленными знаками и заглавной буквой;
 * ничего не выброшено — исходный текст как есть.
 */
export function stripConfirmations(comment: string): string {
  const list = clausesOf(String(comment ?? ''));
  let changed = false;
  for (const c of list) {
    const rest = withoutEqualQty(c.text);
    if (rest != null) {
      changed = true;
      c.text = rest.trim();
    }
    if (!c.text) {
      c.drop = true; // пустая часть («;;») сама по себе текст не меняет
      continue;
    }
    const single = numbersIn(c.text).size <= 1;
    const confirm = (CONFIRM_TAIL.test(c.text) || CONFIRM_VERB.test(c.text)) && single && !CONTRAST.test(c.text);
    const fits = HINT_ECHO.test(c.text) || (FITS_WHOLE.test(c.text) && single && !NEGATION.test(c.text));
    if (CONFIRM_ONLY.test(c.text) || confirm || fits) c.drop = changed = true;
  }
  if (!changed) return comment;
  let out = '';
  let sentence = true; // часть начинает предложение — с заглавной
  for (let k = 0; k < list.length; k++) {
    const c = list[k];
    if (c.drop) continue;
    // знак после части — сильнейший из её и выброшенных следом: «A; [B.] C» → «A. C»
    let end = c.end;
    let n = k + 1;
    for (; n < list.length && list[n].drop; n++) if (END_RANK[list[n].end] > END_RANK[end]) end = list[n].end;
    const last = !list.slice(n).some((x) => !x.drop);
    if (last && END_RANK[end] < 2) end = '.';
    out += `${sentence ? capFirst(c.text) : c.text}${end}${last ? '' : c.gap || ' '}`;
    sentence = END_RANK[end] === 2;
  }
  return out.trim();
}

// ---------- ответ целиком ----------

const STATUS: Record<string, AiStatus> = {
  ok: 'ok',
  good: 'ok',
  check: 'check',
  warn: 'check',
  warning: 'check',
  attention: 'check',
  problem: 'problem',
  error: 'problem',
  bad: 'problem',
};
const RANK: Record<AiStatus, number> = { ok: 0, check: 1, problem: 2 };

interface ReviewDraft {
  status: AiStatus;
  comments: string[];
  operations: unknown[];
  suggestions: unknown[];
}

/** Обозначение позиции — первое слово имени с цифрой (пометки имени файла « st3» отбрасываются) */
function designationOf(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? '';
  return first.length >= 4 && /\d/.test(first) ? first : name.trim();
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** id позиций в тексте → обозначения деталей: менеджеру «pmvb1yrm46» ничего не говорит; null — заменять нечего */
function idReplacer(positions: AiPosition[]): ((s: string) => string) | null {
  const byId = new Map<string, string>();
  for (const p of positions) {
    const d = designationOf(p.name);
    if (p.id.length >= 3 && d && p.id !== d) byId.set(p.id, d);
  }
  if (!byId.size) return null;
  const ids = [...byId.keys()].sort((a, b) => b.length - a.length).map(escapeRe).join('|');
  const re = new RegExp(`(?<![\\p{L}\\p{N}_-])(?:id\\s*[=:]?\\s*)?(${ids})(?![\\p{L}\\p{N}_-])`, 'gu');
  return (s) => {
    re.lastIndex = 0;
    if (!re.test(s)) return s;
    const out = s.replace(re, (all: string, id: string, at: number, str: string) => {
      const d = byId.get(id)!;
      const k = normKey(d);
      // рядом уже стоит обозначение: «pmvb… НГЭН…», «НГЭН… (pmvb…)» — id просто убираем
      if (normKey(str.slice(at + all.length, at + all.length + d.length + 4)).startsWith(k)) return '';
      if (normKey(str.slice(Math.max(0, at - d.length - 4), at)).endsWith(k)) return '';
      return d;
    });
    // следы убранного id: «()», «( позиция )», двойные пробелы, пробел перед знаком
    return out
      .replace(/\(\s*(?:позиция|поз\.)?\s*\)/g, '')
      .replace(/\(\s+/g, '(')
      .replace(/\s+\)/g, ')')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/ +([,.;:])/g, '$1')
      .trim();
  };
}

/** Тексты ответа без id позиций (поле id отзыва не трогаем) */
function scrubIds(raw: Obj, positions: AiPosition[]): Obj {
  const fix = idReplacer(positions);
  if (!fix) return raw;
  const deep = (v: unknown): unknown => (typeof v === 'string' ? fix(v) : Array.isArray(v) ? v.map(deep) : v);
  const out: Obj = { ...raw };
  for (const k of ['summary', 'questions', 'risks', 'recommendations']) if (k in out) out[k] = deep(out[k]);
  if (Array.isArray(raw.positions)) {
    out.positions = raw.positions.map((r) =>
      isObj(r)
        ? {
            ...r,
            comment: deep(r.comment),
            operations: deep(r.operations),
            suggestions: Array.isArray(r.suggestions) ? r.suggestions.map((x) => (isObj(x) ? { ...x, reason: deep(x.reason) } : x)) : r.suggestions,
          }
        : r,
    );
  }
  return out;
}

// вопрос «подтвердите количество» о деталях, у которых количество уже исправлено по строке заявки: клиент сам
// это написал, переспрашивать — шум (вопросы уходят в текст для клиента). Другая тема в вопросе — оставляем.
const CONFIRM_QTY = /подтверд/i;
const QUESTION_TOPICS = /свар|материал|толщин|гиб|покра|покрыт|чертеж|чертёж|исполнен|спецификац|документ|письм|срок|достав|состав|чем\s|или\s/i;

/** Обозначение стоит в тексте отдельно («…1201» не находится в «…1201-01») */
const mentions = (s: string, desig: string) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(desig)}(?![\\p{L}\\p{N}]|[-.]\\d)`, 'iu').test(s);

function reaskedQty(q: string, positions: AiPosition[], fixedByRequest: Set<string>): boolean {
  if (!CONFIRM_QTY.test(q) || !/количеств|\d\s*шт|сколько/i.test(q) || QUESTION_TOPICS.test(q)) return false;
  const named = positions.filter((p) => designationOf(p.name).length >= 4 && mentions(q, designationOf(p.name)));
  return named.length > 0 && named.every((p) => fixedByRequest.has(p.id));
}

// замечание только о количестве: «Количество 1 шт не найдено…», «5 шт — только по имени файла»; операции — только резка и гибка
const QTY_WORDS = /количеств|\d\s*шт/i;
const OTHER_TOPICS = /материал|толщин|гиб|масс|свар|покра|покрыт|штамп|исполнен|чертеж|чертёж|размер|отверст|резьб|раскро|формат|лист\s+\d|сост/i;
const BASIC_OP = /^(?:лазерная\s+)?резка$|^гибка(?:\s*[—–-]\s*\d+\s*гиб\S*)?$/i;
const qtyOnly = (comment: string, operations: string[]) => QTY_WORDS.test(comment) && !OTHER_TOPICS.test(comment) && operations.every((o) => BASIC_OP.test(o.trim()));

/** Токены — целые ≥ 0, стоимость — ₽ до 4 знаков (сумма двух запросов не тянет хвост 0,27000000000000002) */
function usageOf(u: AiUsage): AiUsage {
  const tokens = (v: number) => (Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
  return {
    promptTokens: tokens(u.promptTokens),
    completionTokens: tokens(u.completionTokens),
    costRub: typeof u.costRub === 'number' && Number.isFinite(u.costRub) && u.costRub >= 0 ? round(u.costRub, 4) : null,
    ...(typeof u.costUsd === 'number' && Number.isFinite(u.costUsd) && u.costUsd >= 0 ? { costUsd: round(u.costUsd, 6) } : {}),
  };
}

export interface SanitizeMeta {
  model: string; // модель, которая ответила
  durationMs: number;
  usage?: AiUsage; // токены и стоимость (все запросы анализа вместе)
  fallback?: boolean; // ответила не основная модель
}

/** Ответ модели → AiAnalysis по данным заказа; бросает ошибку, только если это не объект */
export function sanitizeAnalysis(input: unknown, ctx: AiContext, meta: SanitizeMeta): AiAnalysis {
  if (!isObj(input)) throw new Error('ответ модели — не объект JSON');
  const raw = scrubIds(input, ctx.positions);
  const materials = new Set(ctx.materials.map((m) => m.id));
  const noQtySource = !ctx.order?.request?.trim() && !ctx.documents?.length && !ctx.unmatchedRequestLines?.length;
  const rates = (ctx.rates?.extraOps ?? []).map((r) => r.price).filter((x) => Number.isFinite(x) && x > 0);
  const byId = new Map(ctx.positions.map((p) => [p.id, p]));
  // модель иногда ссылается на позицию по обозначению вместо id — принимаем, если оно однозначно
  const byName = new Map<string, AiPosition | null>();
  for (const p of ctx.positions) {
    const k = normKey(p.name);
    if (k) byName.set(k, byName.has(k) ? null : p);
  }
  const find = (v: unknown): AiPosition | undefined => {
    const s = typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
    return s ? (byId.get(s) ?? byName.get(normKey(s)) ?? undefined) : undefined;
  };

  // повторы одной позиции сливаем: худший статус, все комментарии и предложения
  const drafts = new Map<string, ReviewDraft>();
  for (const r of arr(raw.positions)) {
    if (!isObj(r)) continue;
    const pos = find(r.id);
    if (!pos) continue;
    const status = STATUS[String(r.status ?? '').trim().toLowerCase()] ?? 'check';
    let d = drafts.get(pos.id);
    if (!d) drafts.set(pos.id, (d = { status, comments: [], operations: [], suggestions: [] }));
    else if (RANK[status] > RANK[d.status]) d.status = status;
    const c = text(r.comment, L.comment);
    if (c && !d.comments.some((x) => normKey(x) === normKey(c))) d.comments.push(c);
    d.operations.push(...(typeof r.operations === 'string' ? [r.operations] : arr(r.operations)));
    d.suggestions.push(...arr(r.suggestions));
  }

  // предложения позиций: проверенные, по одному на поле (доп. операций — несколько разных)
  const checked: { p: AiPosition; d: ReviewDraft; kept: Draft[] }[] = [];
  for (const p of ctx.positions) {
    const d = drafts.get(p.id);
    if (!d) continue;
    const kept: Draft[] = [];
    const seen = new Set<string>();
    for (const s of d.suggestions) {
      const v = suggestion(s, p, materials, rates);
      if (!v || seen.has(dedupKey(v))) continue;
      seen.add(dedupKey(v));
      kept.push(v);
      if (kept.length >= L.suggestions) break;
    }
    checked.push({ p, d, kept });
  }
  // исключить все включённые позиции — пустой заказ, такой совет менеджеру не поможет: не предлагаем
  const enabled = ctx.positions.filter((p) => !p.disabled).length;
  const disabling = checked.filter((c) => c.kept.some((s) => s.kind === 'disable')).length;
  if (disabling && disabling >= enabled) for (const c of checked) c.kept = c.kept.filter((s) => s.kind !== 'disable');
  // количество у позиции, которую советуют исключить, применилось бы само (guessed) и посчитало её, пока менеджер
  // не решил, — у дубля дважды: такое количество не берём
  for (const c of checked) if (c.kept.some((s) => s.kind === 'disable')) c.kept = c.kept.filter((s) => s.kind !== 'qty');

  const positions: AiPositionReview[] = [];
  for (const { p, d, kept } of checked) {
    const suggestions: AiSuggestion[] = kept.map((v, i) => ({ id: `${p.id}#${i + 1}`, ...v }));
    // подтверждения («Заявка 5 шт, в расчёте 5 шт», «… — совпадает») — не замечание: убираем
    const comment = cut(d.comments.map(stripConfirmations).filter(Boolean).join(' '), L.comment);
    const operations = list(d.operations, L.operations, L.operation);
    // сказать нечего и предлагать нечего — позиция в порядке (модель ставит check ради одного подтверждения)
    const quiet = !comment && !suggestions.length;
    // ни слова, ни предложения, а из операций разве что резка и гибка — нечего показывать
    if (quiet && operations.every((o) => BASIC_OP.test(o.trim()))) continue;
    // заявки нет — сверять количество не с чем: замечание только о количестве повторяет общий вопрос клиенту
    if (noQtySource && d.status !== 'problem' && !suggestions.length && qtyOnly(comment, operations)) continue;
    // совет исключить позицию — не «всё в порядке»: позицию нужно проверить
    const status = quiet ? 'ok' : d.status === 'ok' && suggestions.some((s) => s.kind === 'disable') ? 'check' : d.status;
    positions.push({ id: p.id, status, comment, operations, suggestions });
  }

  // количество уже исправлено по словам клиента (заявка, спецификация, документ заказа — по имени файла):
  // «подтвердите N шт» не спрашиваем
  const docNames = (ctx.documents ?? []).map((x) => String(x.fileName ?? '').trim().toLowerCase()).filter((n) => n.length >= 3);
  const citesRequest = (reason: string) => /заявк|спецификац|документ|письм/i.test(reason) || docNames.some((n) => reason.toLowerCase().includes(n));
  const fixedByRequest = new Set(positions.filter((r) => r.suggestions.some((s) => s.kind === 'qty' && citesRequest(s.reason))).map((r) => r.id));
  const questions = list(raw.questions, L.items * 2, L.item)
    .filter((q) => !reaskedQty(q, ctx.positions, fixedByRequest))
    .slice(0, L.items);
  const confidence = String(raw.confidence ?? '').trim().toLowerCase();
  return {
    summary: text(raw.summary, L.summary),
    confidence: confidence === 'high' || confidence === 'low' ? confidence : 'medium',
    positions,
    questions,
    risks: list(raw.risks, L.items, L.item),
    recommendations: list(raw.recommendations, L.items, L.item),
    model: String(meta.model || 'unknown'),
    createdAt: new Date().toISOString(),
    durationMs: Math.max(0, Math.round(meta.durationMs)),
    ...(meta.usage ? { usage: usageOf(meta.usage) } : {}),
    ...(meta.fallback !== undefined ? { fallback: meta.fallback } : {}),
  };
}
