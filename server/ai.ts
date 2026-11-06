// ИИ-анализ заказа на сервере. Модель отвечает дольше 60 с, которые nginx ждёт ответа,
// поэтому анализ — фоновая задача: браузер создаёт её (POST /api/ai/jobs), догружает
// изображения чертежей (PUT …/images/<n>) и опрашивает (GET …/<id>); отмена — DELETE.
// Сайт публичный: не больше 2 запросов к модели одновременно, очередь до 6 задач,
// 20 задач в час с одного адреса, проверка размеров; изображения — только в памяти.

import { readFileSync } from 'node:fs';
import {
  AI_CONTEXT_VERSION,
  AI_LIMITS,
  type AiAnalysis,
  type AiContext,
  type AiJobCreated,
  type AiJobState,
  type AiPosition,
  type AiServerStatus,
} from '../src/core/ai.ts';
import { extractJson, sanitizeAnalysis } from '../src/core/aiSanitize.ts';
import { complete, isFallbackModel, LlmError, llmConfig, llmConfigured, visionEnabled, type LlmMessage, type LlmPart, type LlmUsage } from './llm.ts';

export const AI_SERVER_LIMITS = {
  concurrency: 2, // запросов к модели одновременно
  queue: 6, // задач ждут изображений или своей очереди; больше — 429
  perIpHour: 20, // новых задач с одного адреса за час
  keepMs: 30 * 60_000, // готовая задача хранится для опроса
  waitImagesMs: 2 * 60_000, // столько ждём изображения чертежей
  abandonMs: 3 * 60_000, // задачу в очереди никто не опрашивает — снимаем
  jobImagesBytes: AI_LIMITS.images * AI_LIMITS.imageBytes, // изображений на задачу
  memoryImagesBytes: 48_000_000, // изображений всех задач в памяти (контейнер — 256 МБ)
};

const HOUR = 3_600_000;
const PROMPT = new URL('./prompts/analyze.md', import.meta.url);

/** Ошибка HTTP API с текстом для пользователя */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/** Ошибка анализа, текст которой можно показать пользователю как есть */
class AiError extends Error {}

export interface JobImage {
  data: Buffer;
  mime: string;
}

type JobStatus = AiJobState['status'];

interface Job {
  id: string;
  ip: string;
  status: JobStatus;
  ctx: AiContext | null; // освобождается, когда задача завершена
  positions: number;
  expected: Set<number>; // номера изображений, которые ждём
  images: Map<number, JobImage>;
  imagesBytes: number;
  imagesSent: number;
  ignoreImages: boolean; // модель без зрения: изображения принимаем и выбрасываем
  createdAt: number;
  seenAt: number; // последний запрос браузера по задаче
  startedAt: number;
  finishedAt: number;
  model: string | null;
  analysis: AiAnalysis | null;
  usage: LlmUsage | null;
  repaired: boolean;
  error: string;
  ctrl: AbortController;
}

const jobs = new Map<string, Job>();
const queue: Job[] = [];
const perIp = new Map<string, number[]>();
let running = 0;
let imagesInMemory = 0;

// ---------- проверка AiContext ----------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isList = (v: unknown, max: number): v is unknown[] => Array.isArray(v) && v.length <= max;

function bad(what: string): never {
  throw new HttpError(400, `Данные заказа для ИИ не прошли проверку: ${what}`);
}

function longestString(v: unknown, depth = 0): number {
  if (typeof v === 'string') return v.length;
  if (typeof v !== 'object' || v === null) return 0;
  if (depth > 12) return Infinity; // такой вложенности в AiContext нет
  let max = 0;
  for (const x of Array.isArray(v) ? v : Object.values(v)) max = Math.max(max, longestString(x, depth + 1));
  return max;
}

/** Тело POST /api/ai/jobs → AiContext: версия, форма, размеры по AI_LIMITS; иначе HttpError 400 */
export function validateContext(body: unknown): AiContext {
  if (!isObj(body) || !isObj(body.context)) bad('нет поля context');
  const c = body.context;
  if (c.version !== AI_CONTEXT_VERSION) {
    throw new HttpError(400, `Версия данных для ИИ (${String(c.version)}) не совпадает с сервером (${AI_CONTEXT_VERSION}) — обновите страницу (Ctrl+F5)`);
  }
  const o = c.order;
  if (!isObj(o) || !isStr(o.title, 500)) bad('order.title — строка до 500 символов');
  if (!isStr(o.request, AI_LIMITS.requestChars)) bad(`order.request — текст заявки до ${AI_LIMITS.requestChars} символов`);
  if (!isNum(o.markupPct) || !isNum(o.vatPct)) bad('order.markupPct, order.vatPct — числа');

  if (!isList(c.materials, 100) || !c.materials.length) bad('materials — от 1 до 100 материалов');
  c.materials.forEach((m, i) => {
    if (!isObj(m) || !isStr(m.id, 40) || !m.id || !isStr(m.label, 200)) bad(`materials[${i}]: id и label`);
  });

  if (!isList(c.positions, AI_LIMITS.positions) || !c.positions.length) bad(`positions — от 1 до ${AI_LIMITS.positions} позиций`);
  const ids = new Set<string>();
  let textChars = o.request.length;
  c.positions.forEach((p, i) => {
    const at = `positions[${i}]`;
    if (!isObj(p)) bad(at);
    if (!isStr(p.id, 100) || !p.id || ids.has(p.id)) bad(`${at}.id — уникальная строка до 100 символов`);
    ids.add(p.id);
    if (!isStr(p.name, 300) || !isStr(p.materialId, 40)) bad(`${at}: name, materialId`);
    if (!isNum(p.thickness) || !isNum(p.qty) || !isNum(p.bends)) bad(`${at}: thickness, qty, bends — числа`);
    if (!isObj(p.guessed) || !isObj(p.geometry)) bad(`${at}: guessed, geometry`);
    if (!isList(p.extras, 50) || !p.extras.every((e) => isObj(e) && isStr(e.label, 200) && isNum(e.perPiece))) bad(`${at}.extras`);
    if (!isList(p.warnings, 50) || !p.warnings.every((w) => isStr(w, 1000))) bad(`${at}.warnings`);
    if (p.drawingText != null && !isStr(p.drawingText, AI_LIMITS.drawingTextChars)) bad(`${at}.drawingText длиннее ${AI_LIMITS.drawingTextChars} символов`);
    if (p.note != null && !isStr(p.note, 2000)) bad(`${at}.note`);
    if (typeof p.drawingText === 'string') textChars += p.drawingText.length;
  });

  if (!isList(c.documents, AI_LIMITS.documents)) bad(`documents — до ${AI_LIMITS.documents} документов`);
  c.documents.forEach((d, i) => {
    if (!isObj(d) || !isStr(d.fileName, 300) || !isStr(d.text, AI_LIMITS.documentChars)) bad(`documents[${i}]: fileName и text до ${AI_LIMITS.documentChars} символов`);
    textChars += d.text.length;
  });
  if (textChars > AI_LIMITS.totalTextChars) bad(`тексты заказа вместе длиннее ${AI_LIMITS.totalTextChars} символов`);

  if (!isList(c.images, AI_LIMITS.images)) bad(`images — до ${AI_LIMITS.images} изображений`);
  const indexes = new Set<number>();
  c.images.forEach((im, i) => {
    if (!isObj(im) || typeof im.index !== 'number' || !Number.isInteger(im.index) || im.index < 0 || im.index >= AI_LIMITS.images || indexes.has(im.index)) {
      bad(`images[${i}].index — уникальное целое 0…${AI_LIMITS.images - 1}`);
    }
    indexes.add(im.index);
    if (!isStr(im.positionId, 100) || !ids.has(im.positionId)) bad(`images[${i}].positionId — id позиции заказа`);
    if (!isStr(im.caption, 300)) bad(`images[${i}].caption`);
  });

  if (!isList(c.groups, 300) || !c.groups.every((g) => isObj(g) && isList(g.offers, 30))) bad('groups');
  const r = c.rates;
  if (!isObj(r) || !isList(r.cutting, 100) || !isList(r.bending, 100) || !isList(r.bendLenK, 100) || !isList(r.extraOps, 100)) bad('rates');
  if (!r.extraOps.every((x) => isObj(x) && isStr(x.label, 200) && isStr(x.unit, 40) && isNum(x.price))) bad('rates.extraOps');
  if (!isList(c.unmatchedRequestLines, 300) || !c.unmatchedRequestLines.every((s) => isStr(s, 500))) bad('unmatchedRequestLines');
  if (!isObj(c.totals)) bad('totals');
  if (longestString(c) > 10_000) bad('слишком длинная строка или вложенность');
  return c as unknown as AiContext;
}

/** Тип изображения по первым байтам: JPEG (основной), PNG, WebP; null — не изображение */
export function imageMime(b: Buffer): string | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// ---------- промпт ----------

interface Prompt {
  system: string;
  user: string; // данные заказа текстом (для исправления JSON — без изображений)
  parts: LlmPart[] | null; // то же + изображения чертежей
  images: number;
}

/** Шаблон server/prompts/analyze.md: до разделителя «user» — системное сообщение, после — пользовательское */
function promptTemplate(): { system: string; user: string } {
  const raw = readFileSync(PROMPT, 'utf8');
  const i = raw.search(/^<!--\s*user\s*-->[ \t]*$/m);
  if (i < 0) throw new Error('в server/prompts/analyze.md нет разделителя <!-- user -->');
  const strip = (s: string) =>
    s
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  return { system: strip(raw.slice(0, i)), user: strip(raw.slice(i).replace(/^<!--\s*user\s*-->/, '')) };
}

/** {{name}} → значение; функцией, чтобы «$» в данных не стал шаблоном замены */
const fill = (tpl: string, vars: Record<string, string>) => tpl.replace(/\{\{(\w+)\}\}/g, (m, k: string) => vars[k] ?? m);

// дробные числа — до 3 знаков: копейки и микроны модели не нужны, а токены стоят денег
const round3 = (_k: string, v: unknown) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1000) / 1000 : v);

// латиница, похожая на кириллицу: в обозначениях их путают
const LOOKALIKE: Record<string, string> = { A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х', Y: 'У' };
const normDesig = (s: string) =>
  s
    .toUpperCase()
    .replace(/Ё/g, 'Е')
    .replace(/[ABCEHKMOPTXY]/g, (ch) => LOOKALIKE[ch])
    .replace(/\s+/g, ' ');

/** Обозначение позиции — первое слово имени с цифрой; пометки из имени файла (« st3», « s3mm») отбрасываем */
function designationOf(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? '';
  return first.length >= 4 && /\d/.test(first) ? first : name.trim();
}

/** Где обозначение стоит отдельно («…0002» не находится в «…0002-01», «0001» — в «00012»): текст строки после него; null — нет */
function afterDesig(key: string, line: string): string | null {
  const n = normDesig(line);
  for (let i = n.indexOf(key); i >= 0; i = n.indexOf(key, i + 1)) {
    const rest = n.slice(i + key.length);
    if (!/[0-9A-ZА-Я]/.test(n[i - 1] ?? ' ') && !/^(?:[0-9A-ZА-Я]|[-.]\d)/.test(rest)) return rest;
  }
  return null;
}

/**
 * Строка заявки клиента (order.request) или документа заказа. Документ — не обязательно заявка: спецификация,
 * письмо, счёт, прайс цеха (projects/4 text.txt), поэтому подсказки называют источник, а не «заявку»
 */
interface ReqLine {
  doc: string | null; // имя файла документа; null — заявка клиента
  text: string; // строка без пометки источника
  line: string; // «заявка: …» / «<файл>: …» — по ней ищется обозначение
}

/** Строки с обозначением и количество «N шт» после него (если есть) */
function linesWith(desig: string, lines: ReqLine[]): { src: ReqLine; qty: number | null }[] {
  const key = normDesig(desig);
  if (key.length < 4) return [];
  const out: { src: ReqLine; qty: number | null }[] = [];
  for (const l of lines) {
    const rest = afterDesig(key, l.line);
    if (rest == null) continue;
    const q = /(\d{1,6})\s*(?:ШТ|КОМПЛ|К-Т)/.exec(rest);
    out.push({ src: l, qty: q ? Number(q[1]) : null });
  }
  return out;
}

/** Строки заявки и документов с пометкой источника */
function requestLines(ctx: AiContext): ReqLine[] {
  const rows = (doc: string | null, text: string): ReqLine[] => text.split('\n').map((s) => ({ doc, text: s.trim(), line: `${doc ?? 'заявка'}: ${s}` }));
  return [...rows(null, ctx.order.request), ...ctx.documents.flatMap((d) => rows(d.fileName, d.text))].filter((l) => l.line.replace(/^[^:]*:\s*/, '').trim());
}

/** Откуда строка: «в заявке клиента», «в документе «text.txt»» */
const whereIs = (l: ReqLine) => (l.doc == null ? 'в заявке клиента' : `в документе «${clip(l.doc, 60)}»`);

/** Кто называет обозначения: «заявка клиента называет», «документ «text.txt» называет», «… и … называют» */
function whoNames(ls: ReqLine[]): string {
  const docs = [...new Set(ls.flatMap((l) => (l.doc == null ? [] : [l.doc])))].slice(0, 2);
  const who = [...(ls.some((l) => l.doc == null) ? ['заявка клиента'] : []), ...docs.map((d) => `документ «${clip(d, 60)}»`)];
  return `${who.join(' и ')} ${who.length > 1 ? 'называют' : 'называет'}`;
}

// обозначения позиции нет ни в одной строке заявки и документов
const NOT_IN_REQUEST = 'нет ни в заявке, ни в документах';

const normKey = (s: string) =>
  s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, '');
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
/** Исполнение «-01», «-0700» → базовое обозначение; основа должна остаться обозначением (≥ 6 знаков, с цифрой) */
function baseDesig(d: string): string {
  const m = /^(.+)-\d{1,4}$/.exec(d);
  return m && m[1].length >= 6 && /\d/.test(m[1]) ? m[1] : d;
}
// числа в подсказках — как пишет сметчик: запятая, без лишних знаков
const num = (v: number, digits = 3) => String(Math.round(v * 10 ** digits) / 10 ** digits).replace('.', ',');
const rub = (v: number) => String(Math.round(v));

/** Материал из строки штампа в тексте чертежа: «материал: Лист 3 ТУ 1-801-20-02 / АМГ2 ГОСТ 21631-76» */
const stampMaterial = (text: string | undefined) => /материал:\s*([^;\n]+)/i.exec(text ?? '')?.[1]?.trim();

/** Материал приложения, как его понял разбор штампа («… → 08пс х/к») */
function stampMaterialId(ctx: AiContext, materialText: string | undefined): { id: string; read: string } | null {
  const read = /→\s*([^;\n]+)$/.exec(materialText ?? '')?.[1]?.trim();
  const m = read ? ctx.materials.find((x) => normKey(x.short) === normKey(read) || normKey(x.label) === normKey(read)) : undefined;
  return m && read ? { id: m.id, read } : null;
}

// рифлёный лист по штампу: ТУ на рифлёный алюминий («квинтет»), ромб, чечевица, К-ПУ
const RIFFLED = /ТУ\s*1-801-20|ТУ\s*1-3-(?:87|71)-|ТУ\s*1-804-432|квинтет|рифл|ромб|чечевиц|К-ПУ/i;

/** Штамп говорит о рифлёном листе, а в расчёте гладкий: какой материал предложить */
function riffledHint(ctx: AiContext, p: AiPosition, stamp: string | undefined, where: string): string | null {
  if (!stamp || !RIFFLED.test(stamp)) return null;
  const target = p.materialId === 'amg2' ? 'amg2r' : ['st3', '08ps', '09g2s'].includes(p.materialId) ? 'rifl' : null;
  const m = target ? ctx.materials.find((x) => x.id === target) : undefined;
  if (!m) return null;
  const kind = /ТУ\s*1-801-20|ТУ\s*1-3-87|квинтет/i.test(stamp) ? 'лист с рифлением «квинтет»' : 'рифлёный лист';
  return `${where} «${clip(stamp, 90)}» — ${kind}: материал ${m.id} (${m.label}), а в расчёте ${p.materialId}`;
}

interface VariantRow {
  owner: AiPosition; // позиция, в тексте чертежа которой таблица исполнений
  line: string; // строка таблицы
  massKg: number | null;
}

/** Строка таблицы исполнений («-0700 | 700 | 8,6») для обозначения — в тексте чертежа позиции того же чертежа */
function tableRow(ctx: AiContext, desig: string, self: AiPosition | null): VariantRow | null {
  const base = baseDesig(desig);
  const keys = new Set([normDesig(desig), ...(base !== desig ? [normDesig(desig.slice(base.length))] : [])]);
  for (const q of ctx.positions) {
    if (q === self || !q.drawingText || baseDesig(designationOf(q.name)) !== base) continue;
    let header: string[] | null = null;
    for (const raw of q.drawingText.split('\n')) {
      const t = /^Таблица:\s*(.*)$/.exec(raw);
      if (t) {
        header = t[1].split('|').map((s) => s.trim());
        continue;
      }
      if (!header || !raw.includes('|')) continue;
      const cells = raw.split('|').map((s) => s.trim());
      if (!keys.has(normDesig(cells[0]))) continue;
      const mi = header.findIndex((c) => /масс/i.test(c));
      const mass = mi >= 0 ? Number((cells[mi] ?? '').replace(',', '.')) : NaN;
      return { owner: q, line: raw.trim(), massKg: Number.isFinite(mass) && mass > 0 ? mass : null };
    }
  }
  return null;
}

/** Масса по таблице против массы по контуру — как сверка массы PDF: с рифлением, без рифления, как для стали */
function massVerdict(ctx: AiContext, p: AiPosition, drawingKg: number): string | null {
  const m = ctx.materials.find((x) => x.id === p.materialId);
  const near = (kg: number) => kg > 0 && Math.abs(kg / drawingKg - 1) <= 0.06;
  // по контуру (с рифлением) или без рифления — сходится
  if (near(p.massKg) || (m && near((p.geometry.areaM2 * m.density * p.thickness) / 1000))) return null;
  const steel = p.geometry.areaM2 * 7.85 * p.thickness;
  if (m && Math.abs(m.density - 7850) > 300 && near(steel)) {
    return `масса в таблице ${num(drawingKg, 2)} кг посчитана как для стали (${num(p.geometry.areaM2, 4)} м² × ${num(p.thickness)} мм × 7,85 = ${num(steel, 2)} кг), по контуру из ${m.short} — ${num(p.massKg, 2)} кг: это не ошибка расчёта`;
  }
  return `масса в таблице ${num(drawingKg, 2)} кг, по контуру ${num(p.massKg, 2)} кг — не сходится: проверь исполнение, толщину и материал`;
}

/** Ставка доп. операции по названию */
const rateOf = (ctx: AiContext, re: RegExp) => ctx.rates.extraOps.find((r) => re.test(r.label) && r.price > 0);

/** Сварка стыка составной детали: шов — меньшая сторона габарита на каждый стык */
function weldCalc(ctx: AiContext, p: AiPosition): string | null {
  if (!p.splitParts || p.splitParts < 2) return null;
  const m = ctx.materials.find((x) => x.id === p.materialId);
  const argon = !!m && (m.density < 4000 || /^aisi/.test(m.id));
  const r = rateOf(ctx, argon ? /аргон/i : /полуавтомат/i) ?? rateOf(ctx, /сварк/i);
  if (!r || !/м/.test(r.unit)) return null;
  const seamM = (Math.min(p.geometry.widthMm, p.geometry.heightMm) / 1000) * (p.splitParts - 1);
  return `стык ${rub(Math.min(p.geometry.widthMm, p.geometry.heightMm))} мм, шов ${num(seamM)} м × ${r.price} ₽/м = ${rub(seamM * r.price)} ₽ на 1 шт («${r.label}»)`;
}

const DISABLE_OFFER = 'дай предложение исключить позицию из расчёта (kind disable; reason — эта проверка или цитата строки заявки или документа)';

/**
 * Лист PDF без своего файла, который клиент, скорее всего, не заказывал (приложение само не исключает — решает
 * менеджер): базовое исполнение чертежа с таблицей, когда у других исполнений есть файлы или их называют заявка
 * или документы; исполнение («-01» со второго листа), когда заявка или документ называет другие исполнения этого
 * чертежа, а его — нет. Без заявки и документов зеркальную «-01» не трогаем: левые и правые детали часто заказывают
 * парой. null — признаков нет.
 */
function notOrderedHint(ctx: AiContext, p: AiPosition, lines: ReqLine[]): string | null {
  const desig = designationOf(p.name);
  if (p.source !== 'pdf' || linesWith(desig, lines).length) return null;
  const base = baseDesig(desig);
  const siblings = ctx.positions.filter((q) => q !== p && !q.disabled && designationOf(q.name) !== desig && baseDesig(designationOf(q.name)) === base);
  if (!siblings.length) return null;
  const short = (q: AiPosition) => {
    const d = designationOf(q.name);
    return d !== base && d.startsWith(base) ? d.slice(base.length) : d;
  };
  const named = siblings.flatMap((q) => linesWith(designationOf(q.name), lines).slice(0, 1).map((f) => ({ q, src: f.src })));
  const withFile = siblings.filter((q) => q.source === 'dxf');
  if (base === desig) {
    if (!withFile.length && !named.length) return null;
    const own = tableRow(ctx, desig, null);
    const what = withFile.length ? `файлы исполнений этого чертежа (${withFile.map(short).join(', ')})` : `исполнения этого чертежа (${siblings.map(short).join(', ')})`;
    return (
      `в заказе ${what}${named.length ? `, ${whoNames(named.map((x) => x.src))} ${named.map((x) => short(x.q)).join(', ')}` : ''}, а эта позиция — базовое исполнение` +
      `${own ? ` по таблице («${clip(own.line, 60)}»)` : ''} без своего файла, ${lines.length ? `его ${NOT_IN_REQUEST}` : 'заявки и документов нет'}: вероятно, не заказано — ${DISABLE_OFFER} и вопрос клиенту, нужно ли оно`
    );
  }
  if (!named.length) return null;
  const list = named.map((x) => `${designationOf(x.q.name)} («${clip(x.src.text, 100)}»)`).join(', ');
  return `${whoNames(named.map((x) => x.src))} ${list}, а это исполнение — нет, и своего файла у него нет (лист PDF того же чертежа): вероятно, не заказано — ${DISABLE_OFFER} и вопрос клиенту, нужно ли оно`;
}

/**
 * Дубли — один чертёж загружен дважды под разными именами файлов: то же обозначение и та же геометрия (габарит ±1 мм,
 * площадь и рез ±1 %, те же врезки), материал и толщина те же или у одной из пары не найдены в файлах (имя файла
 * без пометок). Лишняя → та, что остаётся: исключить предлагаем менее полную (без штампа, со значениями по
 * умолчанию), при равенстве — вторую.
 */
function duplicates(ctx: AiContext): Map<AiPosition, AiPosition> {
  const out = new Map<AiPosition, AiPosition>();
  const list = ctx.positions.filter((p) => !p.disabled && p.source !== 'manual' && /\d/.test(designationOf(p.name)));
  const near = (x: number, y: number) => Math.abs(x - y) <= Math.max(0.001, 0.01 * Math.max(x, y));
  const size = (p: AiPosition) => [p.geometry.widthMm, p.geometry.heightMm].sort((a, b) => a - b);
  const sameShape = (p: AiPosition, q: AiPosition) => {
    const [a, b] = size(p);
    const [c, d] = size(q);
    return Math.abs(a - c) <= 1 && Math.abs(b - d) <= 1 && near(p.geometry.areaM2, q.geometry.areaM2) && near(p.geometry.cutM, q.geometry.cutM) && p.geometry.pierces === q.geometry.pierces;
  };
  const sameMetal = (p: AiPosition, q: AiPosition) =>
    (p.materialId === q.materialId || p.guessed.material || q.guessed.material) && (Math.abs(p.thickness - q.thickness) < 1e-6 || p.guessed.thickness || q.guessed.thickness);
  const info = (p: AiPosition) => (p.titleBlock ? 2 : 0) + (p.drawingText ? 1 : 0) + Number(!p.guessed.material) + Number(!p.guessed.thickness) + Number(!p.guessed.qty);
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const [q, p] = [list[i], list[j]];
      if (out.has(q) || out.has(p) || normDesig(designationOf(q.name)) !== normDesig(designationOf(p.name))) continue;
      if (!sameShape(p, q) || !sameMetal(p, q)) continue;
      if (info(q) < info(p)) out.set(q, p);
      else out.set(p, q);
    }
  }
  return out;
}

/**
 * Простые проверки по данным — подсказки модели (маленькие модели их пропускают): количество
 * из заявки, штамп понят как другой материал, рифлёный лист по штампу, признаки гибки при
 * bends = 0, исполнения из таблицы чертежа (масса, материал, гибы), незаказанное исполнение
 * и дубль (предложение disable), деталь не влезает в лист / влезает целиком.
 */
export function positionHints(ctx: AiContext): string {
  const out: string[] = [];
  const lines = requestLines(ctx);
  const dups = duplicates(ctx);
  for (const p of ctx.positions) {
    if (p.disabled) continue; // исключённые позиции не правим
    const h: string[] = [];
    const desig = designationOf(p.name);
    const text = p.drawingText ?? '';
    // количество из заявки — главная проверка: строка с обозначением и «N шт» после него;
    // у копии-дубля строка заявки относится к позиции, которая остаётся, — количество не подсказываем
    const keep = dups.get(p);
    const inRequest = linesWith(desig, lines);
    const found = keep ? [] : inRequest.filter((f) => f.qty != null);
    const qtys = [...new Set(found.map((f) => f.qty))];
    // источник — как есть: «в заявке клиента» или «в документе «text.txt»» (документ бывает и прайсом цеха)
    const said = found.length ? `${whereIs(found[0].src)} ${qtys[0]} шт («${clip(found[0].src.text, 120)}»)` : '';
    if (qtys.length === 1 && qtys[0] !== p.qty) {
      h.push(`${said}, а в расчёте qty = ${p.qty}${p.guessed.qty ? ' (в файлах количества нет)' : ''}`);
    } else if (qtys.length === 1 && p.guessed.qty) {
      const by = found[0].src.doc == null ? 'по заявке' : `по документу «${clip(found[0].src.doc, 60)}»`;
      h.push(`${said} — как в расчёте, но в файлах количества не было: предложи qty ${qtys[0]} (подтверждение ${by})`);
    }
    const notOrdered = notOrderedHint(ctx, p, lines);
    if (lines.length && !inRequest.length && !notOrdered) h.push(`обозначения ${NOT_IN_REQUEST} — спроси клиента, нужна ли деталь и сколько`);
    if (keep) {
      const files = p.fileName && keep.fileName ? `, файлы «${clip(keep.fileName, 60)}» и «${clip(p.fileName, 60)}»` : '';
      const metal = p.materialId === keep.materialId && Math.abs(p.thickness - keep.thickness) < 1e-6 ? ', материал и толщина' : '';
      h.push(
        `повторяет ${keep.id} ${designationOf(keep.name)}: то же обозначение и та же геометрия${metal}${files}, в расчёте ${keep.qty} и ${p.qty} шт — ` +
          `вероятно, один чертёж загружен дважды: дай предложение исключить эту позицию (kind disable; reason — эта проверка), количество для неё не предлагай — ${keep.id} остаётся в расчёте`,
      );
    }
    const tb = p.titleBlock;
    const stamp = stampMaterialId(ctx, tb?.materialText);
    if (stamp && stamp.id !== p.materialId) h.push(`штамп понят как «${stamp.read}» (${stamp.id}), а в расчёте ${p.materialId}`);
    if (tb?.thickness && Math.abs(tb.thickness - p.thickness) > 1e-6) h.push(`толщина в штампе ${tb.thickness} мм, в расчёте ${p.thickness} мм`);
    const ownRiffled = riffledHint(ctx, p, stampMaterial(text), 'в штампе');
    if (ownRiffled) h.push(ownRiffled);
    // исполнение без своего штампа (DXF «…-0700»): материал, толщина и масса — из таблицы общего чертежа
    const row = tb ? null : tableRow(ctx, desig, p);
    if (row) {
      const sub: string[] = [];
      if (row.massKg) {
        const mv = massVerdict(ctx, p, row.massKg);
        if (mv) sub.push(mv);
      }
      const ownerStamp = stampMaterialId(ctx, row.owner.titleBlock?.materialText);
      if (ownerStamp && ownerStamp.id !== p.materialId) sub.push(`по штампу общего чертежа материал «${ownerStamp.read}» (${ownerStamp.id}), а в расчёте ${p.materialId}`);
      const t = row.owner.titleBlock?.thickness;
      if (t && Math.abs(t - p.thickness) > 1e-6) sub.push(`толщина по штампу общего чертежа ${t} мм, в расчёте ${p.thickness} мм`);
      const r = riffledHint(ctx, p, stampMaterial(row.owner.drawingText), 'в штампе общего чертежа');
      if (r) sub.push(r);
      if (sub.length) h.push(`исполнение из таблицы чертежа ${row.owner.id} ${designationOf(row.owner.name)} («${clip(row.line, 80)}»): ${sub.join(', ')}`);
    }
    if (p.bends === 0) {
      const sign = /[^.;\n]*(?:гиб|разв[её]ртк|отогн)[^.;\n]*/i.exec(text)?.[0]?.trim();
      const twin = ctx.positions.find((q) => q !== p && q.detectedBends > 0 && baseDesig(designationOf(q.name)) === baseDesig(desig));
      if (sign) h.push(`признак гибки в тексте чертежа «${clip(sign, 80)}», а bends = 0${twin ? `; у ${twin.id} ${designationOf(twin.name)} (тот же чертёж) найдено гибов: ${twin.detectedBends}` : ''}`);
      else if (twin) h.push(`гибов в расчёте нет (bends = 0), а у ${twin.id} ${designationOf(twin.name)} (тот же чертёж, другое исполнение) найдено гибов: ${twin.detectedBends}`);
    }
    // базовое исполнение или лист «-01» без своего файла, которых нет в заявке, — скорее всего, не заказаны
    if (notOrdered) h.push(notOrdered);
    const composite = /[^.;\n]*(?:составн|из\s+(?:двух|тр[её]х|четыр[её]х|\d+(?:-х)?)\s+част)[^.;\n]*/i.exec(text)?.[0]?.trim();
    if (p.splitParts) {
      const weld = composite ? weldCalc(ctx, p) : null;
      h.push(
        `не помещается в лист, режется из ${p.splitParts} частей; ${composite ? `чертёж допускает составную: «${clip(composite, 100)}»` : 'разрешения на составную в тексте нет'}` +
          (weld ? `; сварка стыка, если её делаем мы: ${weld} — для вопроса клиенту, не extra` : ''),
      );
    } else if (composite) h.push('(не замечание, в ответ не включай) помещается в выбранный лист целиком — сварку стыков не предлагай');
    if (p.massCheck && (p.massCheck.status === 'warn' || p.massCheck.status === 'bad')) h.push(`масса не сходится с чертежом: ${p.massKg} кг по контуру, ${p.massCheck.drawingKg ?? '?'} кг на чертеже`);
    if (h.length) out.push(`- ${p.id} ${desig}: ${h.join('; ')}`);
  }
  return out.length ? out.join('\n') : 'нет';
}

// обозначение в строке заявки: буквы и цифры (не меньше трёх) через точки и дефисы; даты и ГОСТы — нет
const DESIG_TOKEN = /(?<![\p{L}\p{N}.-])[\p{L}\p{N}]+(?:[.-][\p{L}\p{N}]+)+/gu;
const looksLikeDesig = (t: string, before: string) =>
  t.length >= 6 && /\p{L}/u.test(t) && (t.match(/\d/g)?.length ?? 0) >= 3 && !/^\d{1,2}\.\d{1,2}\.\d{2,4}$/.test(t) && !/(?:ГОСТ|ОСТ|ТУ|DIN|ISO|RAL)\s*$/i.test(before);

/** Строки заявки и документов с обозначением и «N шт», для которого в заказе нет позиции (чертёж не приложен) */
function unmatchedLines(ctx: AiContext, lines: ReqLine[]): ReqLine[] {
  const have = new Set(ctx.positions.map((p) => normDesig(designationOf(p.name))));
  const out = new Map<string, ReqLine>();
  for (const l of lines) {
    if (!/\d\s*(?:шт|компл|к-т)/i.test(l.line)) continue;
    const text = l.line.replace(/^[^:]*:\s*/, '');
    for (const m of text.matchAll(DESIG_TOKEN)) {
      if (!looksLikeDesig(m[0], text.slice(0, m.index))) continue;
      if (!have.has(normDesig(m[0]))) {
        if (!out.has(l.line.trim())) out.set(l.line.trim(), l);
        break;
      }
    }
  }
  return [...out.values()];
}

/** Строка с источником для таблицы: «в заявке клиента: «…»», «в документе «text.txt»: «…»» */
const cite = (l: ReqLine, max: number) => `${whereIs(l)}: «${clip(l.text, max)}»`;

/** Подсказка модели: в каких строках заявки и документов программа нашла обозначение каждой позиции */
export function requestMatches(ctx: AiContext): string {
  const lines = requestLines(ctx);
  if (!lines.length) return 'Заявки и документов нет — сверять количество не с чем.';
  const rows = ctx.positions.map((p) => {
    const found = linesWith(designationOf(p.name), lines);
    const where = found.length ? found.slice(0, 3).map((f) => cite(f.src, 200)).join('; ') + (found.length > 3 ? ` и ещё ${found.length - 3}` : '') : 'не найдено';
    return `- ${p.id} ${designationOf(p.name)}${p.disabled ? ' (исключена из расчёта)' : ''}: ${where}`;
  });
  const extra = unmatchedLines(ctx, lines);
  if (extra.length) {
    rows.push(`Строки заявки и документов с обозначением, для которого нет позиции (чертёж не приложен — вопрос клиенту): ${extra.slice(0, 10).map((l) => cite(l, 160)).join('; ')}`);
  }
  return rows.join('\n');
}

// доп. операции в заявке и тексте чертежа: покрытие считается по площади двух сторон, цинкование и галтовка — по массе
const NO_COATING = /без\s+(?:покраск|окраск|покрыти)|не\s+(?:красить|окрашивать)|покрыти\w*\s+не\s+требу/i;
const POWDER = /порошк/i;
const ENAMEL = /эмал|грунт|ПФ-?115|ГФ-?021|лакокрас/i;
const PAINT = /покраск|окраск|покрасить|окрасить|RAL\s?\d{4}/i;
const ZINC = /цинкован(?!н)|оцинковать|цинковать|покрыти\w*\s+Ц\d/i;
const TUMBLE = /галтов/i;
const HOLE_OPS: [RegExp, RegExp, string][] = [
  [/резьб|(?<![\p{L}\d])М\d{1,2}(?:[×xх]\d+(?:[.,]\d+)?)?(?![\d,.])/u, /резьб/i, 'резьба'],
  [/зенков/i, /зенков/i, 'зенковка'],
  [/запрессов|впрессов|PEM|самоклинящ/i, /запрессов/i, 'запрессовка'],
];

/**
 * Готовые расчёты доп. операций по ставкам: модель сама плохо перемножает и пишет perPiece раньше
 * расчёта, поэтому число даём программой. Покрытие из заявки — для всех позиций (модель решает, к
 * каким оно относится), из текста чертежа — для этой позиции.
 */
export function operationHints(ctx: AiContext): string {
  const general = [ctx.order.request, ...ctx.documents.map((d) => d.text)].join('\n');
  const out: string[] = [];
  for (const p of ctx.positions) {
    if (p.disabled) continue;
    const text = `${general}\n${p.drawingText ?? ''}`;
    const calcs: string[] = [];
    const area = p.geometry.areaM2;
    if (!NO_COATING.test(text) && area > 0) {
      const coat = (re: RegExp, name: string) => {
        const r = rateOf(ctx, re);
        if (r && /м²|м2/.test(r.unit)) calcs.push(`${name}: 2 стороны × ${num(area, 4)} м² × ${r.price} ₽/м² = ${rub(2 * area * r.price)} ₽ («${r.label}»)`);
      };
      if (POWDER.test(text)) coat(/порошк/i, 'порошковая покраска');
      if (ENAMEL.test(text)) coat(/эмал|грунт/i, 'покраска эмалью / грунт');
      if (PAINT.test(text) && !POWDER.test(text) && !ENAMEL.test(text)) {
        coat(/порошк/i, 'покраска (вид не указан) порошковая');
        coat(/эмал|грунт/i, 'или эмалью');
      }
    }
    const byMass = (re: RegExp, rateRe: RegExp, name: string) => {
      const r = re.test(text) ? rateOf(ctx, rateRe) : undefined;
      if (r && /кг/.test(r.unit) && p.massKg > 0) calcs.push(`${name}: ${num(p.massKg, 2)} кг × ${r.price} ₽/кг = ${rub(p.massKg * r.price)} ₽ («${r.label}»)`);
    };
    byMass(ZINC, /цинк/i, 'цинкование');
    byMass(TUMBLE, /галтов/i, 'галтовка');
    const holes = Math.max(0, p.geometry.pierces - p.geometry.contours);
    for (const [re, rateRe, name] of HOLE_OPS) {
      const r = re.test(p.drawingText ?? '') ? rateOf(ctx, rateRe) : undefined;
      if (r) calcs.push(`${name}: ${r.price} ₽ за ${r.unit}; отверстий в детали ${holes} — сколько из них под ${name === 'запрессовка' ? 'крепёж' : name}, бери с чертежа`);
    }
    if (calcs.length) out.push(`- ${p.id} ${designationOf(p.name)}: ${calcs.join('; ')}`);
  }
  return out.length ? out.join('\n') : 'нет';
}

const DAY = 86_400_000;
const ruDate = (d: Date) => d.toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', year: 'numeric' });

/** Возраст цен mc.ru словами: модели плохо считают даты, а «дата не записана» у группы — не риск, если цены свежие */
export function pricesNote(ctx: AiContext, now = new Date()): string {
  const age = (iso: string | null) => {
    const t = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(t) ? Math.max(0, Math.floor((now.getTime() - t) / DAY)) : null;
  };
  const days = age(ctx.order.pricesUpdatedAt);
  const head =
    days == null
      ? 'Дата цен mc.ru неизвестна — цены металла могли устареть (это риск).'
      : `Цены mc.ru обновлены ${ruDate(new Date(ctx.order.pricesUpdatedAt!))} (${days === 0 ? 'сегодня' : `${days} дн. назад`})${days <= 3 ? ' — свежие, это не риск' : days <= 7 ? '' : ' — могли измениться, это риск'}.`;
  const old = ctx.groups.filter((g) => (age(g.pricesFetchedAt) ?? -1) > 7).map((g) => `${g.materialLabel} ${g.thickness} мм`);
  return old.length ? `${head} Старше недели цены групп: ${old.join(', ')}.` : head;
}

/** Состав заказа одной строкой: модели ошибаются, пересчитывая позиции сами */
export function orderNote(ctx: AiContext): string {
  const active = ctx.positions.filter((p) => !p.disabled).length;
  const metal = ctx.groups.map((g) => `${g.materialLabel} ${num(g.thickness)} мм`).join(', ');
  return `В заказе ${ctx.positions.length} поз.${active !== ctx.positions.length ? ` (в расчёте ${active})` : ''}, ${ctx.totals.pieces} шт по текущему расчёту${metal ? `; металл: ${metal}` : ''}.`;
}

export function buildPrompt(ctx: AiContext, images: Map<number, JobImage> = new Map()): Prompt {
  const t = promptTemplate();
  const today = ruDate(new Date());
  const system = fill(t.system, {
    today,
    materials_json: JSON.stringify(ctx.materials),
    extra_ops_json: JSON.stringify(ctx.rates.extraOps),
  });
  // справочники уже в системном сообщении; изображения — подписями перед каждой картинкой.
  // У группы — какие детали в ней (модель путает группы); пустая дата цены группы не передаётся
  // (её заменяет общая дата цен в prices_note)
  const data = {
    order: ctx.order,
    rates: { cutting: ctx.rates.cutting, bending: ctx.rates.bending, bendLenK: ctx.rates.bendLenK, bendSetup: ctx.rates.bendSetup },
    groups: ctx.groups.map(({ pricesFetchedAt, offers, ...g }) => ({
      ...g,
      // splitParts у листа — сколько деталей не влезает; у позиции splitParts — на сколько частей она режется: разные имена
      offers: offers.map(({ splitParts, ...o }) => ({ ...o, partsNotFit: splitParts })),
      parts: ctx.positions.filter((p) => !p.disabled && p.materialId === g.materialId && Math.abs(p.thickness - g.thickness) < 1e-6).map((p) => designationOf(p.name)),
      ...(pricesFetchedAt ? { pricesFetchedAt } : {}),
    })),
    positions: ctx.positions,
    documents: ctx.documents,
    unmatchedRequestLines: ctx.unmatchedRequestLines,
    totals: ctx.totals,
  };
  const attached = ctx.images.filter((r) => images.has(r.index)).sort((a, b) => a.index - b.index);
  const user = fill(t.user, {
    context_json: JSON.stringify(data, round3),
    request_matches: requestMatches(ctx),
    hints: positionHints(ctx),
    ops_hints: operationHints(ctx),
    order_note: orderNote(ctx),
    prices_note: pricesNote(ctx),
    images_note: attached.length
      ? `К сообщению приложены изображения чертежей (${attached.length}), перед каждым — подпись с номером и id позиции. Сверяй по ним гибы, отверстия, резьбу, покрытия и примечания; числа с изображения, которых нет в данных, используй только если они читаются однозначно.`
      : 'Изображений чертежей нет — опирайся на тексты и числа из данных.',
  });
  const parts: LlmPart[] | null = attached.length
    ? [
        { type: 'text', text: user },
        ...attached.flatMap((r): LlmPart[] => {
          const img = images.get(r.index)!;
          return [
            { type: 'text', text: `Изображение ${r.index}: ${r.caption} (позиция id=${r.positionId})` },
            { type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.data.toString('base64')}` } },
          ];
        }),
      ]
    : null;
  return { system, user, parts, images: attached.length };
}

// ---------- запрос к модели и разбор ответа ----------

export interface AnalyzeResult {
  analysis: AiAnalysis;
  usage: LlmUsage;
  repaired: boolean; // JSON пришлось исправлять вторым запросом
}

function parseAnswer(content: string): unknown {
  const raw = extractJson(content);
  if (!isObj(raw) || !('summary' in raw || 'positions' in raw)) throw new Error('в JSON нет полей summary и positions');
  return raw;
}

const addUsage = (a: LlmUsage, b: LlmUsage): LlmUsage => ({
  promptTokens: a.promptTokens + b.promptTokens,
  completionTokens: a.completionTokens + b.completionTokens,
  costRub: a.costRub != null && b.costRub != null ? a.costRub + b.costRub : (a.costRub ?? b.costRub),
  ...(a.costUsd != null || b.costUsd != null ? { costUsd: (a.costUsd ?? 0) + (b.costUsd ?? 0) } : {}),
});

/** Заглушка LLM_MOCK (разработка): количество +1 у первой позиции, совет исключить последнюю (если позиций
 *  в расчёте больше одной); broken — первый ответ обрезан */
function mockReply(ctx: AiContext, attempt: number): string {
  const active = ctx.positions.filter((x) => !x.disabled);
  const p = active[0] ?? ctx.positions[0];
  const last = active.length > 1 ? active[active.length - 1] : null;
  const nil = { materialId: null, value: null, label: null, perPiece: null };
  const json = JSON.stringify({
    summary: `Заглушка LLM_MOCK: ${ctx.positions.length} поз., ${ctx.totals.pieces} шт. Настоящий анализ — без LLM_MOCK.`,
    confidence: 'low',
    positions: [
      {
        id: p.id,
        status: 'check',
        comment: 'Тестовое замечание заглушки.',
        operations: ['лазерная резка'],
        suggestions: [{ kind: 'qty', reason: 'проверка применения предложений', ...nil, value: p.qty + 1 }],
      },
      ...(last
        ? [{ id: last.id, status: 'check', comment: '', operations: [], suggestions: [{ kind: 'disable', reason: 'заглушка: проверка предложения «Исключить из расчёта»', ...nil }] }]
        : []),
    ],
    questions: ['Тестовый вопрос клиенту?'],
    risks: [],
    recommendations: [],
  });
  return process.env.LLM_MOCK === 'broken' && attempt === 0 ? `\`\`\`json\n${json.slice(0, Math.floor(json.length / 2))}` : json;
}

async function analyzePrompt(ctx: AiContext, prompt: Prompt, signal: AbortSignal | undefined, t0: number): Promise<AnalyzeResult> {
  const system: LlmMessage = { role: 'system', content: prompt.system };
  const first = await complete({ messages: [system, { role: 'user', content: prompt.parts ?? prompt.user }], signal, mock: () => mockReply(ctx, 0) });
  let usage = first.usage;
  let answer = first;
  let raw: unknown;
  let repaired = false;
  try {
    raw = parseAnswer(first.content);
  } catch (e) {
    // одна попытка исправить: тот же разговор без изображений + испорченный ответ + просьба вернуть JSON
    const cutOff = first.finishReason === 'length';
    const why = cutOff ? 'ответ обрезан — не хватило лимита длины' : (e as Error).message;
    console.error(`[ai] ответ модели не разобран (${why}) — прошу исправить`);
    repaired = true;
    const fix = await complete({
      messages: [
        system,
        { role: 'user', content: prompt.user },
        { role: 'assistant', content: first.content.slice(0, 60_000) },
        {
          role: 'user',
          content: `Твой ответ выше — не корректный JSON (${why}). Верни только корректный JSON по схеме: один объект с полями summary, confidence, positions, questions, risks, recommendations, без текста до и после и без \`\`\`.${cutOff ? ' Ответ не поместился — сократи: комментарии до 200 символов, только позиции с замечаниями.' : ''}`,
        },
      ],
      signal,
      mock: () => mockReply(ctx, 1),
    });
    usage = addUsage(usage, fix.usage);
    answer = fix;
    try {
      raw = parseAnswer(fix.content);
    } catch {
      throw new AiError(
        fix.finishReason === 'length'
          ? 'Ответ ИИ не поместился в лимит длины даже после повтора — уменьшите заказ или увеличьте LLM_MAX_TOKENS'
          : 'ИИ вернул некорректный ответ (не JSON по схеме) даже после повторной попытки — повторите анализ',
      );
    }
  }
  // в анализе — сколько он стоил и не ответила ли резервная модель (интерфейс показывает стоимость и пометку)
  const analysis = sanitizeAnalysis(raw, ctx, { model: answer.model, durationMs: Date.now() - t0, usage, fallback: isFallbackModel(answer.model) });
  return { analysis, usage: analysis.usage ?? usage, repaired };
}

/** Анализ без очереди — для скриптов (scripts/ai-smoke.ts); сайт работает через задачи */
export async function analyzeContext(ctx: AiContext, images: Map<number, JobImage> = new Map(), signal?: AbortSignal): Promise<AnalyzeResult> {
  return analyzePrompt(ctx, buildPrompt(ctx, images), signal, Date.now());
}

// ---------- задачи ----------

function releaseImages(job: Job) {
  imagesInMemory -= job.imagesBytes;
  job.imagesBytes = 0;
  job.images.clear();
}

function logJob(job: Job) {
  const ms = job.finishedAt - (job.startedAt || job.createdAt);
  const head = `[ai] ${job.id.slice(0, 8)} ${job.status === 'done' ? 'готово' : 'ошибка'} за ${ms} мс · позиций ${job.positions} · изображений ${job.imagesSent}`;
  if (job.status !== 'done' || !job.analysis || !job.usage) {
    console.log(`${head} · ${job.error}`);
    return;
  }
  const u = job.usage;
  const cost = u.costRub != null ? ` ≈ ${u.costRub.toFixed(2)} ₽` : u.costUsd != null ? ` ≈ $${u.costUsd.toFixed(4)}` : '';
  const model = `${job.model}${job.analysis.fallback ? ' (резервная модель)' : ''}`;
  console.log(`${head} · ${model} · токены ${u.promptTokens}+${u.completionTokens}${cost} · с замечаниями ${job.analysis.positions.length}${job.repaired ? ' · JSON исправлен повтором' : ''}`);
}

function finish(job: Job, status: 'done' | 'error', error = '') {
  if (job.status === 'done' || job.status === 'error') return;
  const i = queue.indexOf(job);
  if (i >= 0) queue.splice(i, 1);
  releaseImages(job);
  job.status = status;
  job.error = error;
  job.finishedAt = Date.now();
  job.ctx = null; // до 900 КБ — не держим 30 минут
  logJob(job);
}

function userError(e: unknown): string {
  if (e instanceof LlmError || e instanceof AiError) return e.message;
  console.error('[ai] внутренняя ошибка:', e);
  return `Внутренняя ошибка ИИ-анализа: ${e instanceof Error ? e.message : String(e)}`;
}

async function run(job: Job): Promise<void> {
  running++;
  job.status = 'running';
  job.startedAt = Date.now();
  const cfg = llmConfig();
  job.model = cfg.mock ? 'mock' : cfg.model;
  // весь анализ (повторы, резервные модели, исправление JSON): по тайм-ауту на каждую модель цепочки и ещё один
  const deadlineMs = cfg.timeoutMs * (2 + (cfg.gateway ? 0 : cfg.fallbacks.length)) + 15_000;
  const deadline = AbortSignal.timeout(deadlineMs);
  const signal = AbortSignal.any([job.ctrl.signal, deadline]);
  try {
    const ctx = job.ctx!;
    const prompt = buildPrompt(ctx, job.images);
    job.imagesSent = prompt.images;
    releaseImages(job); // дальше изображения живут только в запросе (base64)
    const r = await analyzePrompt(ctx, prompt, signal, job.startedAt);
    job.analysis = r.analysis;
    job.usage = r.usage;
    job.repaired = r.repaired;
    job.model = r.analysis.model;
    finish(job, 'done');
  } catch (e) {
    const msg = job.ctrl.signal.aborted ? 'Анализ отменён' : deadline.aborted ? `ИИ не ответил за ${Math.round(deadlineMs / 1000)} с — повторите позже` : userError(e);
    finish(job, 'error', msg);
  } finally {
    running--;
    pump();
  }
}

function pump() {
  while (running < AI_SERVER_LIMITS.concurrency && queue.length) void run(queue.shift()!);
}

function enqueue(job: Job) {
  job.status = 'queued';
  queue.push(job);
  pump();
}

/** Чистка: готовые задачи старше 30 мин, недождавшиеся изображений, брошенные в очереди, старые счётчики адресов */
function sweep() {
  const now = Date.now();
  for (const job of jobs.values()) {
    if (job.status === 'done' || job.status === 'error') {
      if (now - job.finishedAt > AI_SERVER_LIMITS.keepMs) jobs.delete(job.id);
    } else if (job.status === 'waiting' && now - job.createdAt > AI_SERVER_LIMITS.waitImagesMs) {
      finish(job, 'error', 'Не все изображения чертежей дошли до сервера — повторите анализ');
    } else if ((job.status === 'waiting' || job.status === 'queued') && now - job.seenAt > AI_SERVER_LIMITS.abandonMs) {
      finish(job, 'error', 'Анализ отменён: страница перестала запрашивать результат');
    }
  }
  for (const [ip, times] of perIp) {
    const fresh = times.filter((t) => now - t < HOUR);
    if (fresh.length) perIp.set(ip, fresh);
    else perIp.delete(ip);
  }
}

setInterval(sweep, 30_000).unref();

const notFound = () => new HttpError(404, 'Задача ИИ не найдена — устарела или сервер перезапускался; запустите анализ заново');

/** POST /api/ai/jobs: проверка, лимиты, постановка в очередь (или ожидание изображений) */
export async function createJob(body: unknown, ip: string): Promise<AiJobCreated> {
  const cfg = llmConfig();
  if (!llmConfigured(cfg)) throw new HttpError(503, 'ИИ-анализ не настроен на сервере');
  const ctx = validateContext(body);
  const vision = ctx.images.length > 0 && (await visionEnabled(cfg));
  sweep();
  const now = Date.now();
  const times = (perIp.get(ip) ?? []).filter((t) => now - t < HOUR);
  if (times.length >= AI_SERVER_LIMITS.perIpHour) throw new HttpError(429, `С вашего адреса уже ${times.length} анализов за час — это предел. Повторите позже`);
  const pending = [...jobs.values()].filter((j) => j.status === 'waiting' || j.status === 'queued').length;
  if (pending >= AI_SERVER_LIMITS.queue) throw new HttpError(429, 'Сервер ИИ занят другими расчётами — повторите через минуту');
  times.push(now);
  perIp.set(ip, times);
  const ignoreImages = !vision && ctx.images.length > 0;
  if (ignoreImages) {
    // модель не принимает изображения — анализ по тексту, изображения не ждём
    ctx.images = [];
    for (const p of ctx.positions) delete p.imageIndex;
  }
  const job: Job = {
    id: crypto.randomUUID(),
    ip,
    status: 'waiting',
    ctx,
    positions: ctx.positions.length,
    expected: new Set(ctx.images.map((r) => r.index)),
    images: new Map(),
    imagesBytes: 0,
    imagesSent: 0,
    ignoreImages,
    createdAt: now,
    seenAt: now,
    startedAt: 0,
    finishedAt: 0,
    model: null,
    analysis: null,
    usage: null,
    repaired: false,
    error: '',
    ctrl: new AbortController(),
  };
  jobs.set(job.id, job);
  if (!job.expected.size) enqueue(job);
  return { jobId: job.id, imagesExpected: job.expected.size };
}

/** PUT /api/ai/jobs/<id>/images/<index>: изображение чертежа; все пришли — задача в очередь */
export function putImage(id: string, index: number, data: Buffer): void {
  const job = jobs.get(id);
  if (!job) throw notFound();
  job.seenAt = Date.now();
  if (job.ignoreImages) return; // модель без зрения — изображение не нужно
  if (job.status !== 'waiting') throw new HttpError(409, 'Задача уже не принимает изображения');
  if (!job.expected.has(index)) throw new HttpError(400, `Изображение №${index} не заявлено в задаче`);
  if (data.length > AI_LIMITS.imageBytes) throw new HttpError(413, `Изображение больше ${Math.round(AI_LIMITS.imageBytes / 1000)} КБ`);
  const mime = imageMime(data);
  if (!mime) throw new HttpError(415, 'Ожидается изображение JPEG');
  const prev = job.images.get(index)?.data.length ?? 0;
  const delta = data.length - prev;
  if (job.imagesBytes + delta > AI_SERVER_LIMITS.jobImagesBytes) throw new HttpError(413, 'Изображения задачи вместе слишком большие');
  if (imagesInMemory + delta > AI_SERVER_LIMITS.memoryImagesBytes) {
    finish(job, 'error', 'Сервер ИИ перегружен — повторите анализ через минуту');
    throw new HttpError(503, 'Сервер ИИ перегружен — повторите анализ через минуту');
  }
  job.images.set(index, { data, mime });
  job.imagesBytes += delta;
  imagesInMemory += delta;
  if (job.images.size === job.expected.size) enqueue(job);
}

/** GET /api/ai/jobs/<id>; у готовой задачи расход токенов (usage) — и в анализе, и рядом (как раньше) */
export function getJob(id: string): AiJobState {
  const job = jobs.get(id);
  if (!job) throw notFound();
  job.seenAt = Date.now();
  switch (job.status) {
    case 'waiting':
      return { status: 'waiting', imagesReceived: job.images.size, imagesExpected: job.expected.size };
    case 'queued':
      return { status: 'queued', position: queue.indexOf(job) + 1 };
    case 'running':
      return { status: 'running', elapsedMs: Date.now() - job.startedAt, model: job.model };
    case 'done':
      return { status: 'done', analysis: job.analysis!, ...(job.usage ? { usage: job.usage } : {}) };
    default:
      return { status: 'error', error: job.error };
  }
}

/** DELETE /api/ai/jobs/<id>: отмена — ждущая задача снимается, идущий запрос к модели прерывается */
export function cancelJob(id: string): void {
  const job = jobs.get(id);
  if (!job) throw notFound();
  if (job.status === 'running') job.ctrl.abort();
  else if (job.status === 'waiting' || job.status === 'queued') finish(job, 'error', 'Анализ отменён');
}

/** GET /api/ai/status */
export async function aiStatus(): Promise<AiServerStatus> {
  const c = llmConfig();
  if (!llmConfigured(c)) return { configured: false, model: null, vision: false };
  return { configured: true, model: c.mock ? 'mock' : c.model, vision: await visionEnabled(c) };
}

/** Строка для лога при старте сервера (без ключа) */
export function aiStartupLine(): string {
  const c = llmConfig();
  if (c.mock) return `ИИ-анализ: заглушка LLM_MOCK=${c.mock} — только для разработки!`;
  if (!llmConfigured(c)) return 'ИИ-анализ не настроен: нет LLM_BASE_URL / LLM_MODEL / LLM_API_KEY';
  let host = c.baseUrl;
  try {
    host = new URL(c.baseUrl).host;
  } catch {
    /* оставляем как есть */
  }
  return `ИИ-анализ: ${c.model}${c.fallbacks.length ? ` (+${c.fallbacks.length} резервных)` : ''} через ${host}; изображения: ${c.vision}, JSON: ${c.json}`;
}

/** Для тестов: забыть все задачи и счётчики адресов */
export function resetAiJobsForTests() {
  for (const job of jobs.values()) if (job.status === 'running') job.ctrl.abort();
  jobs.clear();
  queue.length = 0;
  perIp.clear();
  imagesInMemory = 0;
}
