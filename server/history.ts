// История заказов на сервере: data/history.json (том docker, переживает пересборку), общая для всех,
// кто вошёл по паролю. Запись — целиком во временный файл и переименованием (сбой не оставит половину
// файла); раз в день копия в data/history-backups/ (хранятся 14 последних).
//
//   GET    /api/history              список (кратко), новые сверху
//   GET    /api/history/export       вся история одним JSON (резервная копия, перенос)
//   POST   /api/history/import       добавить заказы из такого JSON (по id; более новые не затираются)
//   GET    /api/history/invoiced     заказы со счётом цеха целиком — сверка расчёта со счетами
//   POST   /api/history/match        та же деталь и похожие в прошлых заказах
//   GET    /api/history/<id>         заказ целиком
//   PUT    /api/history/<id>         сохранить заказ (счёт цеха, если не передан, остаётся прежним)
//   PUT    /api/history/<id>/invoice счёт цеха к заказу; DELETE — убрать счёт
//   DELETE /api/history/<id>         удалить заказ (ответ — удалённый заказ, для «Вернуть»)

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AiContext } from '../src/core/ai.ts';
import {
  findMatches,
  HISTORY_LIMITS,
  remapInvoice,
  HISTORY_VERSION,
  PREVIEW_MAX_NUMBERS,
  summaryOf,
  type HistoryCalc,
  type HistoryInvoice,
  type HistoryMatch,
  type HistoryOrder,
  type HistoryPart,
  type HistoryPreview,
  type InvoiceLine,
  type MatchQuery,
} from '../src/core/history.ts';
import { getMaterial, MATERIAL_BY_ID } from '../src/core/materials.ts';
import { HttpError, parseJson, readRaw, send } from './http.ts';

const BACKUPS_KEEP = 14;
export const HISTORY_ID = /^[A-Za-z0-9_-]{6,64}$/;

let dir = process.env.HISTORY_DIR || fileURLToPath(new URL('../data/', import.meta.url));
let cache: HistoryOrder[] | null = null;

/** Для тестов: история в другой папке (и сброс кэша) */
export function setHistoryDir(d: string): void {
  dir = d;
  cache = null;
}

const file = () => join(dir, 'history.json');

function load(): HistoryOrder[] {
  if (cache) return cache;
  const f = file();
  if (!existsSync(f)) return (cache = []);
  try {
    const j = JSON.parse(readFileSync(f, 'utf8')) as { orders?: unknown };
    cache = Array.isArray(j.orders) ? (j.orders as HistoryOrder[]) : [];
  } catch (e) {
    // битый файл не затираем молча: работать без истории нельзя, иначе первая запись её уничтожит
    console.error('[history] не удалось прочитать', f, e);
    throw new HttpError(500, 'Файл истории повреждён — восстановите его из data/history-backups/');
  }
  return cache;
}

function backup(): void {
  const f = file();
  if (!existsSync(f)) return;
  const bdir = join(dir, 'history-backups');
  const today = new Date().toISOString().slice(0, 10);
  const target = join(bdir, `history-${today}.json`);
  if (existsSync(target)) return;
  mkdirSync(bdir, { recursive: true });
  copyFileSync(f, target);
  const old = readdirSync(bdir)
    .filter((n) => /^history-\d{4}-\d{2}-\d{2}\.json$/.test(n))
    .sort()
    .slice(0, -BACKUPS_KEEP);
  for (const n of old) unlinkSync(join(bdir, n));
}

function persist(orders: HistoryOrder[]): void {
  mkdirSync(dir, { recursive: true });
  backup(); // копия вчерашнего состояния — до первой записи за день
  const tmp = `${file()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: HISTORY_VERSION, orders }));
  renameSync(tmp, file());
  cache = orders;
}

export function historyOrders(): readonly HistoryOrder[] {
  return load();
}

// ---------- проверка данных ----------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const bad = (what: string): never => {
  throw new HttpError(400, `Заказ для истории не прошёл проверку: ${what}`);
};
const str = (v: unknown, max: number, what: string, opt = false): string => {
  if (v == null && opt) return '';
  if (typeof v !== 'string') bad(`${what} — строка`);
  return (v as string).slice(0, max);
};
const num = (v: unknown, what: string, min = 0, max = 1e12): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) bad(`${what} — число ${min}…${max}`);
  return v as number;
};
const iso = (v: unknown, fallback: string) => (typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : fallback);

function calcOf(v: unknown, at: string): HistoryCalc | null {
  if (v == null) return null;
  if (!isObj(v)) bad(`${at}.calc`);
  const c = v as Obj;
  return {
    material: num(c.material, `${at}.calc.material`),
    cut: num(c.cut, `${at}.calc.cut`),
    bend: num(c.bend, `${at}.calc.bend`),
    extras: num(c.extras, `${at}.calc.extras`, -1e9),
    total: num(c.total, `${at}.calc.total`, -1e9),
  };
}

/** Эскиз детали: только числа, не больше PREVIEW_MAX_NUMBERS; иначе эскиз не сохраняем (заказ — сохраняем) */
function previewOf(v: unknown): HistoryPreview | undefined {
  if (!isObj(v)) return undefined;
  const fin = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) < 1e7;
  let n = 0;
  const lists: number[][][] = [];
  for (const k of ['outer', 'holes', 'bends'] as const) {
    const a = v[k];
    if (!Array.isArray(a) || a.length > 1000) return undefined;
    for (const l of a) {
      if (!Array.isArray(l) || !l.every(fin)) return undefined;
      n += l.length;
    }
    lists.push(a as number[][]);
  }
  const b = v.bbox;
  if (!Array.isArray(b) || b.length !== 4 || !b.every(fin) || n > PREVIEW_MAX_NUMBERS) return undefined;
  return { outer: lists[0], holes: lists[1], bends: lists[2], bbox: b as HistoryPreview['bbox'] };
}

function partOf(v: unknown, i: number): HistoryPart {
  const at = `parts[${i}]`;
  if (!isObj(v)) bad(at);
  const p = v as Obj;
  const id = str(p.id, 100, `${at}.id`);
  if (!id) bad(`${at}.id`);
  const materialId = str(p.materialId, 40, `${at}.materialId`);
  if (!MATERIAL_BY_ID.has(materialId)) bad(`${at}.materialId — нет такого материала`);
  const g = p.geom;
  if (!isObj(g)) bad(`${at}.geom`);
  const geom = g as Obj;
  const extras = Array.isArray(p.extras) ? p.extras.slice(0, 50) : [];
  const bl = Array.isArray(p.bendLengths) ? p.bendLengths.slice(0, 200) : null;
  const part: HistoryPart = {
    id,
    name: str(p.name, 300, `${at}.name`),
    materialId,
    thickness: num(p.thickness, `${at}.thickness`, 0.05, 200),
    qty: num(p.qty, `${at}.qty`, 0, 1e7),
    geom: {
      width: num(geom.width, `${at}.geom.width`, 0, 1e6),
      height: num(geom.height, `${at}.geom.height`, 0, 1e6),
      netArea: num(geom.netArea, `${at}.geom.netArea`, 0, 1e13),
      bboxArea: num(geom.bboxArea, `${at}.geom.bboxArea`, 0, 1e13),
      cutLength: num(geom.cutLength, `${at}.geom.cutLength`, 0, 1e9),
      pierces: num(geom.pierces, `${at}.geom.pierces`, 0, 1e6),
      count: num(geom.count, `${at}.geom.count`, 0, 1e5),
    },
    bends: num(p.bends, `${at}.bends`, 0, 1000),
    bendLength: num(p.bendLength, `${at}.bendLength`, 0, 1e6),
    extras: extras.map((e, k) => {
      if (!isObj(e)) bad(`${at}.extras[${k}]`);
      const x = e as Obj;
      return { label: str(x.label, 200, `${at}.extras[${k}].label`), perPiece: num(x.perPiece, `${at}.extras[${k}].perPiece`, -1e9, 1e9) };
    }),
    massKg: num(p.massKg ?? 0, `${at}.massKg`, 0, 1e7),
    calc: calcOf(p.calc, at),
    price: p.price == null ? null : num(p.price, `${at}.price`, -1e12),
  };
  if (p.fileName != null) part.fileName = str(p.fileName, 300, `${at}.fileName`);
  if (p.note != null) part.note = str(p.note, 2000, `${at}.note`);
  if (p.disabled === true) part.disabled = true;
  if (bl && bl.every((x) => typeof x === 'number' && Number.isFinite(x) && x > 0 && x < 1e6)) part.bendLengths = bl as number[];
  const preview = previewOf(p.preview);
  if (preview) part.preview = preview;
  return part;
}

export function invoiceOf(v: unknown, partIds: Set<string>): HistoryInvoice | null {
  if (v == null) return null;
  if (!isObj(v)) return bad('invoice');
  const inv = v as Obj;
  if (!Array.isArray(inv.lines) || inv.lines.length > HISTORY_LIMITS.invoiceLines) bad(`invoice.lines — до ${HISTORY_LIMITS.invoiceLines} строк`);
  const lines: InvoiceLine[] = (inv.lines as unknown[]).map((l, i) => {
    const at = `invoice.lines[${i}]`;
    if (!isObj(l)) bad(at);
    const x = l as Obj;
    const ids = Array.isArray(x.partIds) ? [...new Set(x.partIds.filter((id): id is string => typeof id === 'string' && partIds.has(id)))] : [];
    return {
      n: num(x.n, `${at}.n`, 0, 1e6),
      text: str(x.text, 1000, `${at}.text`),
      qty: num(x.qty, `${at}.qty`, 0, 1e9),
      unit: str(x.unit, 20, `${at}.unit`, true),
      price: num(x.price, `${at}.price`, -1e12),
      sum: num(x.sum, `${at}.sum`, -1e12),
      partIds: ids,
    };
  });
  const date = typeof inv.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(inv.date) ? inv.date : null;
  return {
    supplier: str(inv.supplier, 300, 'invoice.supplier', true),
    number: str(inv.number, 60, 'invoice.number', true),
    date,
    total: num(inv.total, 'invoice.total', 0),
    fileName: str(inv.fileName, 300, 'invoice.fileName', true),
    addedAt: iso(inv.addedAt, new Date().toISOString()),
    lines,
  };
}

/** Заказ из тела запроса: форма и размеры; счёт — с id деталей этого заказа */
export function orderOf(v: unknown, id: string, prev: HistoryOrder | undefined, now = new Date().toISOString()): HistoryOrder {
  if (!isObj(v)) return bad('ожидался объект заказа');
  const o = v as Obj;
  if (!Array.isArray(o.parts) || !o.parts.length || o.parts.length > HISTORY_LIMITS.parts) bad(`parts — от 1 до ${HISTORY_LIMITS.parts} деталей`);
  const parts = (o.parts as unknown[]).map(partOf);
  const ids = new Set<string>();
  for (const p of parts) {
    if (ids.has(p.id)) bad(`parts: повторяется id ${p.id}`);
    ids.add(p.id);
  }
  const t = isObj(o.totals) ? (o.totals as Obj) : bad('totals');
  const sheetChoice: Record<string, string> = {};
  if (isObj(o.sheetChoice)) for (const [k, s] of Object.entries(o.sheetChoice).slice(0, 300)) if (typeof s === 'string' && k.length <= 60 && s.length <= 30) sheetChoice[k] = s;
  const priceOverride: Record<string, number> = {};
  if (isObj(o.priceOverride))
    for (const [k, n] of Object.entries(o.priceOverride).slice(0, 300)) if (typeof n === 'number' && Number.isFinite(n) && n > 0 && k.length <= 60) priceOverride[k] = n;
  // счёт: не передан — прежний (детали могли смениться: ссылки на удалённые детали отбрасываются)
  const invoice = 'invoice' in o ? invoiceOf(o.invoice, ids) : prev?.invoice ? invoiceOf(remapInvoice(prev.invoice, prev.parts, parts), ids) : null;
  const out: HistoryOrder = {
    id,
    title: str(o.title, 300, 'title', true).trim(),
    createdAt: prev?.createdAt ?? iso(o.createdAt, now),
    updatedAt: now,
    markupPct: num(o.markupPct ?? 0, 'markupPct', -100, 10_000),
    delivery: num(o.delivery ?? 0, 'delivery', 0),
    sheetChoice,
    priceOverride,
    totals: {
      cost: num(t.cost, 'totals.cost', -1e12),
      total: num(t.total, 'totals.total', -1e12),
      material: num(t.material ?? 0, 'totals.material', -1e12),
      cutting: num(t.cutting ?? 0, 'totals.cutting', -1e12),
      bending: num(t.bending ?? 0, 'totals.bending', -1e12),
      extras: num(t.extras ?? 0, 'totals.extras', -1e12),
      pieces: num(t.pieces ?? 0, 'totals.pieces', 0),
      kg: num(t.kg ?? 0, 'totals.kg', 0),
    },
    parts,
    invoice,
  };
  if (typeof o.request === 'string' && o.request.trim()) out.request = o.request.slice(0, 8000);
  return out;
}

function matchQueries(v: unknown): { parts: MatchQuery[]; exclude?: string } {
  if (!isObj(v) || !Array.isArray(v.parts)) return bad('parts');
  const b = v as Obj;
  const parts = (b.parts as unknown[]).slice(0, HISTORY_LIMITS.matchParts).flatMap((x): MatchQuery[] => {
    if (!isObj(x)) return [];
    const q = x as Obj;
    const ok = typeof q.id === 'string' && q.id.length <= 100 && typeof q.name === 'string' && typeof q.materialId === 'string';
    const nums = ['thickness', 'width', 'height', 'cutM', 'bends', 'qty'].every((k) => typeof q[k] === 'number' && Number.isFinite(q[k]));
    if (!ok || !nums) return [];
    const n = (k: string) => q[k] as number;
    return [
      {
        id: q.id as string,
        name: (q.name as string).slice(0, 300),
        materialId: q.materialId as string,
        thickness: n('thickness'),
        width: n('width'),
        height: n('height'),
        cutM: n('cutM'),
        bends: n('bends'),
        qty: n('qty'),
      },
    ];
  });
  return { parts, exclude: typeof b.exclude === 'string' ? b.exclude : undefined };
}

// ---------- HTTP ----------

// новые сверху; сохранённые в одну миллисекунду — позже добавленный выше
const summaries = () =>
  load()
    .map((o, i) => ({ s: summaryOf(o, (id) => getMaterial(id).short), i }))
    .sort((a, b) => b.s.updatedAt.localeCompare(a.s.updatedAt) || b.i - a.i)
    .map((x) => x.s);

const PATH = /^\/api\/history\/([^/]{1,100})(\/invoice)?$/;

export async function handleHistory(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const method = req.method ?? 'GET';
  const wrong = () => new HttpError(405, 'Метод не поддерживается');
  const body = async () => parseJson(await readRaw(req, HISTORY_LIMITS.bodyBytes));

  if (path === '/api/history') {
    if (method !== 'GET') throw wrong();
    return send(res, 200, { orders: summaries() });
  }
  if (path === '/api/history/export') {
    if (method !== 'GET') throw wrong();
    const name = `history-${new Date().toISOString().slice(0, 10)}.json`;
    return send(res, 200, { version: HISTORY_VERSION, exportedAt: new Date().toISOString(), orders: load() }, { 'Content-Disposition': `attachment; filename="${name}"` });
  }
  if (path === '/api/history/import') {
    if (method !== 'POST') throw wrong();
    const b = await body();
    const list = isObj(b) && Array.isArray(b.orders) ? b.orders : bad('orders — список заказов');
    const orders = load().slice();
    let added = 0;
    let updated = 0;
    let skipped = 0;
    const errors: string[] = [];
    for (const raw of list as unknown[]) {
      const id = isObj(raw) && typeof raw.id === 'string' && HISTORY_ID.test(raw.id) ? raw.id : null;
      if (!id) {
        skipped++;
        continue;
      }
      const i = orders.findIndex((o) => o.id === id);
      const prev = i >= 0 ? orders[i] : undefined;
      const updatedAt = iso((raw as Obj).updatedAt, new Date().toISOString());
      if (prev && prev.updatedAt >= updatedAt) {
        skipped++;
        continue;
      }
      try {
        const o = orderOf(raw, id, prev, updatedAt);
        if (prev) {
          orders[i] = o;
          updated++;
        } else {
          if (orders.length >= HISTORY_LIMITS.orders) throw new HttpError(409, 'История заполнена');
          orders.push(o);
          added++;
        }
      } catch (e) {
        skipped++;
        if (errors.length < 5) errors.push(`${id}: ${(e as Error).message}`);
      }
    }
    if (added || updated) persist(orders);
    return send(res, 200, { added, updated, skipped, errors });
  }
  if (path === '/api/history/invoiced') {
    if (method !== 'GET') throw wrong();
    return send(res, 200, { orders: load().filter((o) => o.invoice) });
  }
  if (path === '/api/history/match') {
    if (method !== 'POST') throw wrong();
    const q = matchQueries(await body());
    return send(res, 200, { matches: findMatches(q.parts, load() as HistoryOrder[], q.exclude), orders: load().length });
  }

  const m = PATH.exec(path);
  if (!m || !HISTORY_ID.test(m[1])) throw new HttpError(404, 'Нет такого метода');
  const id = m[1];
  const notFound = () => new HttpError(404, 'Заказа нет в истории — его удалили');
  // тело — до чтения истории: пока оно приходит, другой запрос может записать историю; дальше до записи — без await
  const raw = method === 'PUT' ? await body() : undefined;
  const orders = load();
  const i = orders.findIndex((o) => o.id === id);

  if (m[2]) {
    if (i < 0) throw notFound();
    const o = orders[i];
    let invoice: HistoryInvoice | null;
    if (method === 'PUT') invoice = invoiceOf(raw, new Set(o.parts.map((p) => p.id))) ?? bad('счёт');
    else if (method === 'DELETE') invoice = null;
    else throw wrong();
    const next = { ...o, invoice, updatedAt: new Date().toISOString() };
    persist(orders.map((x, k) => (k === i ? next : x)));
    return send(res, 200, next);
  }
  if (method === 'GET') {
    if (i < 0) throw notFound();
    return send(res, 200, orders[i]);
  }
  if (method === 'PUT') {
    const o = orderOf(raw, id, i >= 0 ? orders[i] : undefined);
    if (i < 0 && orders.length >= HISTORY_LIMITS.orders) throw new HttpError(409, `В истории уже ${orders.length} заказов — это предел; удалите старые`);
    persist(i >= 0 ? orders.map((x, k) => (k === i ? o : x)) : [...orders, o]);
    return send(res, i >= 0 ? 200 : 201, o);
  }
  if (method === 'DELETE') {
    if (i < 0) throw notFound();
    persist(orders.filter((_, k) => k !== i));
    return send(res, 200, orders[i]);
  }
  throw wrong();
}

// ---------- для ИИ-анализа ----------

const rub = (v: number) => `${Math.round(v).toLocaleString('ru-RU').replace(/ /g, ' ')} ₽`;
const ruDate = (s: string) => {
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString('ru-RU') : s;
};

function matchLine(m: HistoryMatch, now: number | null): string {
  const where = m.invoiceNumber ? `счёт № ${m.invoiceNumber}${m.supplier ? ` ${m.supplier}` : ''} от ${ruDate(m.date)}` : `заказ «${m.orderTitle || 'без названия'}» от ${ruDate(m.date)}`;
  const fact = m.fact != null ? `цех взял ${rub(m.fact)}/шт${m.factShared ? ' (строка счёта на группу деталей — доля по расчёту)' : ''}` : 'счёта цеха нет';
  const calc = m.calc != null ? `наш расчёт тогда ${rub(m.calc)}/шт` : '';
  const diff = now != null && m.fact != null && m.fact > 0 ? `; сейчас по расчёту ${rub(now)}/шт (${now >= m.fact ? '+' : '−'}${Math.round((Math.abs(now - m.fact) / m.fact) * 100)}% к счёту)` : '';
  const what =
    m.kind === 'same'
      ? `та же деталь, ${getMaterial(m.materialId).short} ${m.thickness} мм, ${m.qty} шт`
      : `похожая ${m.name}: ${getMaterial(m.materialId).short} ${m.thickness} мм, ${Math.round(m.width)}×${Math.round(m.height)} мм, гибов ${m.bends}, ${m.qty} шт`;
  return `${what} — ${where}: ${fact}${calc ? `, ${calc}` : ''}${diff}`;
}

/** Прошлые заказы и счета по деталям заказа — текстом для промпта; нет истории — пустая строка */
export function historyNote(ctx: AiContext, exclude?: string): string {
  let orders: readonly HistoryOrder[];
  try {
    orders = load();
  } catch {
    return '';
  }
  if (!orders.length) return '';
  const active = ctx.positions.filter((p) => !p.disabled);
  const queries: MatchQuery[] = active.map((p) => ({
    id: p.id,
    name: p.name,
    materialId: p.materialId,
    thickness: p.thickness,
    width: p.geometry.widthMm,
    height: p.geometry.heightMm,
    cutM: p.geometry.cutM,
    bends: p.bends,
    qty: p.qty,
  }));
  const found = findMatches(queries, orders as HistoryOrder[], exclude);
  const lines: string[] = [];
  for (const p of active) {
    const ms = found[p.id];
    if (!ms?.length) continue;
    const now = p.cost?.total ?? null;
    const same = ms.filter((m) => m.kind === 'same').slice(0, 2);
    const similar = same.some((m) => m.fact != null) ? [] : ms.filter((m) => m.kind === 'similar').slice(0, 2);
    for (const m of [...same, ...similar]) lines.push(`- ${p.name} (id ${p.id}): ${matchLine(m, now)}`);
  }
  return lines.length ? lines.join('\n') : 'Совпадений с прошлыми заказами нет.';
}
