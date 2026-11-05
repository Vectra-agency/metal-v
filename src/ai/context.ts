// Сборка AiContext — всё, что ИИ-анализ получает о заказе: позиции (геометрия, материал, что угадано,
// текст чертежа, сверка массы, детерминированная цена), группы металла со всеми листами mc.ru,
// расценки, документы и заявка. Позиции — базовые (без предложений ИИ). Тексты обрезаются
// под общий бюджет, итоговый JSON — не больше AI_LIMITS.contextBytes.

import {
  AI_CONTEXT_VERSION,
  AI_LIMITS,
  type AiContext,
  type AiDocument,
  type AiGroup,
  type AiImageRef,
  type AiPosition,
  type AiPositionCost,
} from '../core/ai.ts';
import { clipText } from '../core/drawingText.ts';
import { getMaterial, kgPerM2, MATERIALS } from '../core/materials.ts';
import { computeOrder, fmtSheet, type OrderResult, type PriceBook, type Settings } from '../core/pricing.ts';
import { mcUrl } from '../mcUrl.ts';
import { orderSettings, type Order, type OrderPosition } from '../order.ts';
import { desigKey, pdfCheck } from '../pdfImport.ts';
import { pairFetchedAt } from '../prices.ts';

export interface BuildContextOptions {
  images?: AiImageRef[]; // изображения чертежей, которые будут отправлены (их индексы)
  now?: Date;
}

const r0 = (v: number) => Math.round(v);
const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const r4 = (v: number) => Math.round(v * 10000) / 10000;

const sourceOf = (p: OrderPosition): AiPosition['source'] => p.source ?? (p.pdf ? 'pdf' : 'dxf');

/** Пробелы и пустые строки: текст для модели без лишнего */
const tidy = (s: string) =>
  s
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** Бюджет символов: каждому тексту не больше его длины, остаток делится поровну (water-filling) */
export function shareBudget(lengths: number[], budget: number): number[] {
  const out = lengths.map(() => 0);
  let left = Math.max(0, budget);
  let open = lengths.map((_, i) => i).filter((i) => lengths[i] > 0);
  while (open.length && left > 0) {
    const share = Math.floor(left / open.length);
    if (share <= 0) break;
    const next: number[] = [];
    for (const i of open) {
      const give = Math.min(share, lengths[i] - out[i]);
      out[i] += give;
      left -= give;
      if (out[i] < lengths[i]) next.push(i);
    }
    open = next;
  }
  return out;
}

function costOf(res: OrderResult, id: string): AiPositionCost | undefined {
  const x = res.positions.get(id);
  if (!x) return undefined;
  return {
    material: r2(x.piece.material),
    cut: r2(x.piece.cut + x.piece.pierce),
    bend: r2(x.piece.bend),
    extras: r2(x.piece.extras),
    total: r2(x.piece.total),
    sum: r2(x.sum.total),
    priceWithMarkup: r2(x.price.piece),
    sumWithMarkup: r2(x.price.sum),
  };
}

function groupsOf(res: OrderResult, book: PriceBook): AiGroup[] {
  return res.groups.map((g) => ({
    key: g.key,
    materialId: g.material.id,
    materialLabel: g.material.label,
    thickness: g.t,
    policy: g.policy,
    chosenSheet: fmtSheet(g.chosen.offer.w, g.chosen.offer.l),
    autoChosen: g.autoChosen,
    capped: g.chosen.capped,
    materialCost: r0(g.materialCost),
    partsKg: r2(g.partsKg),
    bboxKg: r2(g.bboxKg),
    offers: g.options.map((o) => ({
      sheet: fmtSheet(o.offer.w, o.offer.l),
      pricePerKg: r2(o.offer.pricePerKg),
      source: o.offer.source,
      note: o.offer.note,
      materialCost: r0(o.materialCost),
      sheets: r2(o.sheetsCharged),
      utilization: r3(o.nest.utilization),
      splitParts: Object.keys(o.splits).length,
    })),
    mcUrl: mcUrl(g.material.mc.category, g.t),
    pricesFetchedAt: pairFetchedAt(book, g.material.id, g.t),
  }));
}

/** Строка не длиннее max (лимиты проверки на сервере) */
const cap = (v: string, max: number) => (v.length > max ? v.slice(0, max - 1) + '…' : v);

function positionOf(p: OrderPosition, res: OrderResult, imageIndex: number | undefined): AiPosition {
  const x = res.positions.get(p.id);
  const mat = getMaterial(p.materialId);
  const warnings = [...new Set([...(p.warnings ?? []), ...(x?.warnings ?? [])])].slice(0, 30).map((w) => cap(w, 600));
  const out: AiPosition = {
    id: p.id,
    name: cap(p.name, 300),
    fileName: p.fileName ? cap(p.fileName, 300) : undefined,
    source: sourceOf(p),
    disabled: !!p.disabled,
    materialId: p.materialId,
    thickness: p.thickness,
    qty: p.qty,
    guessed: { material: !!p.guessed?.material, thickness: !!p.guessed?.thickness, qty: !!p.guessed?.qty },
    geometry: {
      widthMm: Math.round(p.geom.width * 10) / 10,
      heightMm: Math.round(p.geom.height * 10) / 10,
      areaM2: r4(p.geom.netArea / 1e6),
      bboxAreaM2: r4(p.geom.bboxArea / 1e6),
      cutM: r3(p.geom.cutLength / 1000),
      pierces: p.geom.pierces,
      contours: p.geom.count,
    },
    bends: p.bends,
    detectedBends: p.detectedBends ?? 0,
    bendLengthMm: r0(p.bendLength),
    extras: p.extras
      .filter((e) => !e.aiId)
      .slice(0, 50)
      .map((e) => ({ label: cap(String(e.label ?? ''), 200), perPiece: r2(Number(e.perPiece) || 0) })),
    massKg: r3(x?.netKg ?? (p.geom.netArea / 1e6) * kgPerM2(mat, p.thickness)),
    warnings,
  };
  const chk = pdfCheck(p);
  if (chk) out.massCheck = { drawingKg: chk.drawing == null ? null : r3(chk.drawing), status: chk.status };
  const T = p.pdf?.meta.title;
  if (T) {
    const meta = p.pdf!.meta;
    const row = meta.table && meta.row >= 0 ? meta.table.rows[meta.row] : null;
    const tb: NonNullable<AiPosition['titleBlock']> = {};
    if (T.designation) tb.designation = T.designation;
    if (T.materialText) tb.materialText = T.materialText;
    if (T.thickness) tb.thickness = T.thickness;
    const massKg = row?.values.mass ?? T.mass;
    if (massKg) tb.massKg = massKg;
    if (T.sheetScale) tb.scale = `1:${String(T.sheetScale).replace('.', ',')}`;
    if (Object.keys(tb).length) out.titleBlock = tb;
  }
  if (p.drawingText) out.drawingText = p.drawingText;
  if (imageIndex != null) out.imageIndex = imageIndex;
  if (p.note) out.note = cap(p.note, 2000);
  if (x?.split) out.splitParts = x.split.pieces;
  const cost = costOf(res, p.id);
  if (cost) out.cost = cost;
  return out;
}

/** Строки заявок из PDF, для которых в заказе нет позиции */
function unmatchedLines(order: Order): string[] {
  const have = new Set(order.positions.map((p) => desigKey(p.name)));
  return (order.requestLines ?? [])
    .filter((l) => !have.has(desigKey(l.designation)))
    .slice(0, 300)
    .map((l) => cap(`${l.designation} — ${l.qty} шт`, 500));
}

/** Применяет бюджет символов к текстам контекста (по месту) */
function trimTexts(ctx: AiContext, budget: number, perDrawing: number, perDoc: number) {
  ctx.order.request = clipText(ctx.order.request, Math.min(AI_LIMITS.requestChars, budget));
  const rest = Math.max(0, budget - ctx.order.request.length);
  const texts: { get: () => string; set: (s: string) => void; cap: number }[] = [
    ...ctx.documents.map((d) => ({ get: () => d.text, set: (s: string) => (d.text = s), cap: perDoc })),
    ...ctx.positions
      .filter((p) => p.drawingText)
      .map((p) => ({ get: () => p.drawingText!, set: (s: string) => (p.drawingText = s), cap: perDrawing })),
  ];
  const lens = texts.map((t) => Math.min(t.get().length, t.cap));
  const give = shareBudget(lens, rest);
  texts.forEach((t, i) => {
    const s = give[i] >= 40 ? clipText(t.get(), give[i]) : '';
    t.set(s);
  });
  for (const p of ctx.positions) if (!p.drawingText) delete p.drawingText;
  ctx.documents = ctx.documents.filter((d) => d.text);
}

const jsonBytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

/**
 * AiContext для POST /api/ai/jobs.
 * res — computeOrder по БАЗОВЫМ позициям заказа (order.positions, не effectivePositions); null — посчитать здесь.
 * settings — общие расценки; наценка, доставка, выбор листа и ручные цены берутся из заказа.
 */
export function buildAiContext(order: Order, res: OrderResult | null, book: PriceBook, settings: Settings, opts: BuildContextOptions = {}): AiContext {
  const s = orderSettings(order, settings);
  const r = res ?? computeOrder(order.positions, book, s);
  const all = order.positions;
  const positions = all.slice(0, AI_LIMITS.positions);
  // изображение — только для позиции, которая есть в контексте (сервер это проверяет)
  const included = new Set(positions.map((p) => p.id));
  const images = (opts.images ?? [])
    .filter((i) => included.has(i.positionId) && Number.isInteger(i.index) && i.index >= 0 && i.index < AI_LIMITS.images)
    .slice(0, AI_LIMITS.images)
    .map((i) => ({ index: i.index, positionId: i.positionId, caption: cap(i.caption, 300) }));

  // изображение страницы — всем позициям с этой страницы этого файла
  const byPage = new Map<string, number>();
  const pageKey = (p: OrderPosition) => (p.pdf ? `${p.pdf.fileKey}#${p.pdf.meta.page}` : '');
  for (const img of images) {
    const p = all.find((x) => x.id === img.positionId);
    if (p && pageKey(p) && !byPage.has(pageKey(p))) byPage.set(pageKey(p), img.index);
  }
  const imageFor = (p: OrderPosition) => images.find((i) => i.positionId === p.id)?.index ?? (pageKey(p) ? byPage.get(pageKey(p)) : undefined);

  const aiPositions = positions.map((p) => positionOf(p, r, imageFor(p)));
  // один текст на несколько позиций (исполнения одного чертежа) — передаём один раз
  const firstWith = new Map<string, string>();
  for (const p of aiPositions) {
    if (!p.drawingText) continue;
    const prev = firstWith.get(p.drawingText);
    if (prev) p.drawingText = `Текст чертежа тот же, что у позиции «${prev}»`;
    else firstWith.set(p.drawingText, p.name);
  }
  if (all.length > positions.length) {
    const last = aiPositions[aiPositions.length - 1];
    last.warnings.push(`В заказе ${all.length} позиций: в анализ переданы первые ${positions.length}, остальные ${all.length - positions.length} не показаны (итоги — по всем)`);
  }

  const documents: AiDocument[] = (order.documents ?? [])
    .slice(0, AI_LIMITS.documents)
    .map((d) => ({ fileName: cap(d.fileName, 300), text: tidy(d.text) }))
    .filter((d) => d.text);
  const T = r.totals;
  const ctx: AiContext = {
    version: AI_CONTEXT_VERSION,
    createdAt: (opts.now ?? new Date()).toISOString(),
    order: {
      title: cap((order.title ?? '').trim(), 500),
      request: tidy(order.request ?? ''),
      markupPct: order.markupPct,
      delivery: order.delivery,
      vatPct: settings.vatPct,
      region: book.region,
      pricesUpdatedAt: book.updatedAt,
    },
    materials: MATERIALS.map((m) => ({
      id: m.id,
      label: m.label,
      short: m.short,
      density: m.density,
      policy: s.policy[m.id] ?? m.policy,
      thicknesses: m.thicknesses,
      cutGroup: m.cutGroup,
    })),
    rates: {
      cutting: s.cutting.map((x) => ({ t: x.t, steel: x.steel, stainless: x.stainless, aluminum: x.aluminum, copper: x.copper })),
      bending: s.bending.map((x) => ({ t: x.t, perBend: x.perBend })),
      bendLenK: s.bendLenK.map((x) => ({ upTo: x.upTo, k: x.k })),
      bendSetup: s.bendSetup,
      extraOps: (s.extraRates ?? [])
        .slice(0, 100)
        .map((x) => ({ label: cap(String(x.label ?? ''), 200), unit: cap(String(x.unit ?? ''), 40), price: Number(x.price) || 0, ...(x.note ? { note: cap(x.note, 500) } : {}) })),
    },
    groups: groupsOf(r, book),
    positions: aiPositions,
    documents,
    images,
    unmatchedRequestLines: unmatchedLines(order),
    totals: {
      material: r0(T.material),
      cutting: r0(T.cutting),
      bending: r0(T.bending),
      extras: r0(T.extras),
      delivery: r0(T.delivery),
      cost: r0(T.cost),
      markup: r0(T.markup),
      total: r0(T.total),
      vat: r0(T.vat),
      kg: r2(T.kg),
      cutM: r2(T.cutM),
      bends: T.bends,
      pieces: T.pieces,
    },
  };

  // тексты: каждый в своём лимите, все вместе — в общем бюджете; JSON — в лимите тела запроса
  let budget: number = AI_LIMITS.totalTextChars;
  let perDrawing: number = AI_LIMITS.drawingTextChars;
  let perDoc: number = AI_LIMITS.documentChars;
  const source = structuredClone({ request: ctx.order.request, documents: ctx.documents, texts: ctx.positions.map((p) => p.drawingText) });
  for (let k = 0; k < 8; k++) {
    ctx.order.request = source.request;
    ctx.documents = structuredClone(source.documents);
    ctx.positions.forEach((p, i) => {
      if (source.texts[i]) p.drawingText = source.texts[i];
    });
    trimTexts(ctx, budget, perDrawing, perDoc);
    if (jsonBytes(ctx) <= AI_LIMITS.contextBytes) return ctx;
    budget = Math.floor(budget / 2);
    perDrawing = Math.floor(perDrawing / 2);
    perDoc = Math.floor(perDoc / 2);
  }
  // крайний случай: без текстов и предупреждений
  ctx.order.request = clipText(ctx.order.request, 2000);
  ctx.documents = [];
  for (const p of ctx.positions) {
    delete p.drawingText;
    p.warnings = p.warnings.slice(0, 3).map((w) => clipText(w, 200));
  }
  return ctx;
}

// ---------- хэш: изменились ли данные, которые видел ИИ ----------

/** Стабильная строка JSON: ключи по алфавиту, undefined пропускаются */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : stableStringify(x))).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`;
}

/** cyrb53 — быстрый 53-битный хэш строки */
export function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Проекция контекста для хэша: без времени создания, наценки, доставки, сумм с наценкой и служебных полей,
 *  а также без названия заказа, отметок «угадано» и примечаний позиций — «Верно» по угаданному значению,
 *  переименование заказа и примечание для КП не делают анализ устаревшим */
export function hashProjection(ctx: AiContext): unknown {
  const { createdAt: _c, images: _i, order, positions, groups, totals, ...rest } = ctx;
  const { markupPct: _m, delivery: _d, pricesUpdatedAt: _p, title: _t, ...ord } = order;
  const { markup: _tm, total: _tt, vat: _tv, delivery: _td, cost: _tc, ...tot } = totals;
  return {
    ...rest,
    order: ord,
    totals: tot,
    groups: groups.map(({ pricesFetchedAt: _f, ...g }) => g),
    positions: positions.map(({ imageIndex: _ix, guessed: _g, note: _n, cost, ...p }) => {
      if (!cost) return p;
      const { priceWithMarkup: _a, sumWithMarkup: _b, ...c } = cost;
      return { ...p, cost: c };
    }),
  };
}

/** Хэш AiContext (строка): совпал — анализ ИИ актуален для текущих данных */
export function contextHash(ctx: AiContext): string {
  return cyrb53(stableStringify(hashProjection(ctx))).toString(36);
}

/** Хэш текущего заказа для сверки с AiState.contextHash (тот же контекст, что ушёл бы в анализ) */
export function orderContextHash(order: Order, res: OrderResult | null, book: PriceBook, settings: Settings): string {
  return contextHash(buildAiContext(order, res, book, settings));
}
