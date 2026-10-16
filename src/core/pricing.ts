// Модель цены: металл (по раскрою листов) + резка (метры и врезки)
// + гибка (гибы × длина) + доп. работы. Все цены — с НДС.

import { getMaterial, kgPerM2, type Material, type SheetPolicy } from './materials.ts';
import { nest, type NestResult } from './nesting.ts';

// ---------- входные данные ----------

export interface PartGeometry {
  width: number; // габарит, мм
  height: number;
  netArea: number; // мм²
  bboxArea: number; // мм²
  cutLength: number; // мм
  pierces: number;
  count: number; // контуров-деталей в файле (обычно 1)
}

export interface Extra {
  label: string;
  perPiece: number; // ₽/шт
}

export interface Position {
  id: string;
  name: string;
  fileName?: string;
  materialId: string;
  thickness: number;
  qty: number;
  geom: PartGeometry;
  bends: number;
  bendLength: number; // мм, длина одного гиба
  extras: Extra[];
  note?: string;
  disabled?: boolean;
}

export interface CutRow {
  t: number;
  perM: number; // ₽ за погонный метр
  pierce: number; // ₽ за врезку
}

export interface BendRow {
  t: number;
  perBend: number; // ₽ за гиб длиной до 1 м
}

export interface BendLenRow {
  upTo: number; // мм
  k: number;
}

export interface Settings {
  cutting: CutRow[];
  bending: BendRow[];
  bendLenK: BendLenRow[];
  bendSetup: number; // наладка гибки на позицию, ₽
  gap: number; // перемычка между деталями, мм
  margin: number; // поле листа, мм
  bboxWastePct: number; // отход при расчёте «по габариту», %
  maxWastePct: number; // потолок отхода при расчёте по раскрою, % к габаритной массе
  maxWasteWholePct: number; // то же при списании целыми листами (мелкие партии не платят за весь лист)
  markupPct: number; // наценка, %
  vatPct: number; // НДС (цены уже с НДС)
  delivery: number; // доставка на заказ, ₽
  policy: Record<string, SheetPolicy>; // переопределение списания по материалу
  priceOverride: Record<string, number>; // `${mat}|${t}` → ₽/кг
  sheetChoice: Record<string, string>; // `${mat}|${t}` → 'W×L'
  matK: Record<string, { cutK?: number; bendK?: number }>; // поправки к материалам
}

export const DEFAULT_SETTINGS: Settings = {
  cutting: [
    { t: 0.5, perM: 35, pierce: 6 },
    { t: 1, perM: 40, pierce: 8 },
    { t: 1.5, perM: 45, pierce: 9 },
    { t: 2, perM: 50, pierce: 10 },
    { t: 2.5, perM: 55, pierce: 11 },
    { t: 3, perM: 60, pierce: 12 },
    { t: 4, perM: 70, pierce: 13 },
    { t: 5, perM: 80, pierce: 14 },
    { t: 6, perM: 90, pierce: 15 },
    { t: 8, perM: 130, pierce: 20 },
    { t: 10, perM: 190, pierce: 26 },
    { t: 12, perM: 250, pierce: 32 },
    { t: 14, perM: 320, pierce: 40 },
    { t: 16, perM: 420, pierce: 48 },
    { t: 20, perM: 950, pierce: 80 },
    { t: 25, perM: 1300, pierce: 100 },
    { t: 30, perM: 1700, pierce: 120 },
  ],
  bending: [
    { t: 0.5, perBend: 50 },
    { t: 1, perBend: 55 },
    { t: 1.5, perBend: 60 },
    { t: 2, perBend: 70 },
    { t: 3, perBend: 85 },
    { t: 4, perBend: 110 },
    { t: 5, perBend: 130 },
    { t: 6, perBend: 160 },
    { t: 8, perBend: 230 },
    { t: 10, perBend: 320 },
    { t: 12, perBend: 420 },
  ],
  bendLenK: [
    { upTo: 300, k: 0.8 },
    { upTo: 1000, k: 1 },
    { upTo: 2000, k: 1.4 },
    { upTo: 3000, k: 1.8 },
    { upTo: 99999, k: 2.5 },
  ],
  bendSetup: 0,
  gap: 8,
  margin: 10,
  bboxWastePct: 15,
  maxWastePct: 40,
  maxWasteWholePct: 100,
  markupPct: 0,
  vatPct: 22,
  delivery: 0,
  policy: {},
  priceOverride: {},
  sheetChoice: {},
  matK: {},
};

// ---------- цены металла ----------

export interface PriceItem {
  t: number;
  w: number; // ширина листа, мм
  l: number; // длина листа, мм
  pricePerKg: number; // ₽/кг с НДС (розница)
  name: string;
  mark: string;
}

export interface PriceBook {
  updatedAt: string | null;
  region: string;
  materials: Record<string, PriceItem[]>;
}

export interface SheetOffer {
  w: number;
  l: number;
  pricePerKg: number;
  source: 'mc' | 'estimate' | 'manual';
  note: string;
}

function median(xs: number[]): number {
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export const groupKey = (materialId: string, t: number) => `${materialId}|${t}`;
export const fmtSheet = (w: number, l: number) => `${w}×${l}`;

export function sheetOffers(book: PriceBook, mat: Material, t: number, s: Settings): SheetOffer[] {
  const items = (book.materials[mat.id] ?? []).filter((i) => i.w >= 500 && i.l >= 1000);
  const exact = items.filter((i) => Math.abs(i.t - t) < 1e-6);
  const manual = s.priceOverride[groupKey(mat.id, t)];
  let offers: SheetOffer[];
  if (exact.length) {
    const byFmt = new Map<string, PriceItem[]>();
    for (const i of exact) {
      const k = fmtSheet(Math.min(i.w, i.l), Math.max(i.w, i.l));
      byFmt.set(k, [...(byFmt.get(k) ?? []), i]);
    }
    offers = [...byFmt.values()].map((arr) => ({
      w: Math.min(arr[0].w, arr[0].l),
      l: Math.max(arr[0].w, arr[0].l),
      pricePerKg: median(arr.map((a) => a.pricePerKg)),
      source: 'mc' as const,
      note: arr.length > 1 ? `mc.ru, медиана ${arr.length} предложений` : `mc.ru: ${arr[0].name}`,
    }));
  } else {
    // нет такой толщины в наличии — берём ближайшую толщину того же материала
    let price = mat.fallbackPricePerKg;
    let note = 'нет на mc.ru — цена по умолчанию';
    if (items.length) {
      const nearest = items.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
      price = median(items.filter((i) => i.t === nearest.t).map((i) => i.pricePerKg));
      note = `нет ${t} мм на mc.ru — цена как у ${nearest.t} мм`;
    }
    offers = mat.defaultSheets.map(([w, l]) => ({ w, l, pricePerKg: price, source: 'estimate' as const, note }));
  }
  if (manual && manual > 0) offers = offers.map((o) => ({ ...o, pricePerKg: manual, source: 'manual' as const, note: 'цена задана вручную' }));
  return offers.sort((a, b) => a.w * a.l - b.w * b.l);
}

// ---------- интерполяция расценок ----------

function interp<T extends { t: number }>(rows: T[], t: number, f: (r: T) => number): number {
  const r = rows.slice().sort((a, b) => a.t - b.t);
  if (!r.length) return 0;
  if (t <= r[0].t) return f(r[0]);
  for (let i = 1; i < r.length; i++) {
    if (t <= r[i].t) {
      const a = r[i - 1];
      const b = r[i];
      return f(a) + ((f(b) - f(a)) * (t - a.t)) / (b.t - a.t);
    }
  }
  // за пределами таблицы — продлеваем последний отрезок
  const a = r[r.length - 2] ?? r[0];
  const b = r[r.length - 1];
  if (a === b) return f(b);
  return f(b) + ((f(b) - f(a)) * (t - b.t)) / (b.t - a.t);
}

export function cutRate(s: Settings, t: number) {
  return { perM: interp(s.cutting, t, (r) => r.perM), pierce: interp(s.cutting, t, (r) => r.pierce) };
}

export function bendRate(s: Settings, t: number) {
  return interp(s.bending, t, (r) => r.perBend);
}

export function bendLenFactor(s: Settings, len: number) {
  const rows = s.bendLenK.slice().sort((a, b) => a.upTo - b.upTo);
  for (const r of rows) if (len <= r.upTo) return r.k;
  return rows[rows.length - 1]?.k ?? 1;
}

// ---------- расчёт ----------

export interface SplitInfo {
  pieces: number; // на сколько частей режем (не влезает в лист)
  extraCut: number; // доп. рез на штуку, мм
  pieceW: number;
  pieceH: number;
}

export interface SheetOption {
  offer: SheetOffer;
  sheetKg: number;
  sheetPrice: number;
  nest: NestResult;
  sheetsCharged: number;
  materialCost: number;
  capped: boolean; // стоимость ограничена потолком отхода
  capCost: number;
  splits: Record<string, SplitInfo>;
}

export interface GroupResult {
  key: string;
  material: Material;
  t: number;
  policy: SheetPolicy;
  positionIds: string[];
  options: SheetOption[];
  chosen: SheetOption;
  auto: SheetOption; // что выбрал бы автомат
  autoChosen: boolean;
  materialCost: number;
  partsKg: number; // масса деталей (нетто)
  bboxKg: number;
}

export interface PosResult {
  id: string;
  groupKey: string;
  material: Material;
  qty: number;
  netKg: number; // масса детали
  bboxKg: number; // масса габаритной заготовки
  cutM: number; // рез на штуку, м (с учётом разбиения)
  pierces: number;
  split: SplitInfo | null;
  rate: { perM: number; pierce: number; perBend: number; lenK: number; cutK: number };
  share: number; // доля в металле группы
  piece: { material: number; cut: number; pierce: number; bend: number; extras: number; total: number };
  sum: { material: number; cut: number; pierce: number; bend: number; extras: number; total: number };
  price: { piece: number; sum: number }; // с наценкой; piece/sum.total — себестоимость
  warnings: string[];
}

export interface OrderResult {
  groups: GroupResult[];
  positions: Map<string, PosResult>;
  markupPct: number;
  totals: { material: number; cutting: number; bending: number; extras: number; delivery: number; cost: number; markup: number; total: number; vat: number; kg: number; cutM: number; bends: number; pieces: number };
}

function splitFor(w: number, h: number, UW: number, UH: number): SplitInfo | null {
  if ((w <= UW && h <= UH) || (h <= UW && w <= UH)) return null;
  const long = Math.max(w, h);
  const short = Math.min(w, h);
  const nx = Math.ceil(long / UW);
  const ny = short <= UH ? 1 : Math.ceil(short / UH);
  const pieceW = long / nx;
  const pieceH = short / ny;
  // каждая линия разделения даёт две новые кромки
  const extraCut = (nx - 1) * short * 2 + (ny - 1) * long * 2;
  return { pieces: nx * ny, extraCut, pieceW, pieceH };
}

function evalOption(offer: SheetOffer, mat: Material, t: number, policy: SheetPolicy, items: Position[], s: Settings): SheetOption {
  const sheetKg = ((offer.w * offer.l) / 1e6) * kgPerM2(mat, t);
  const sheetPrice = sheetKg * offer.pricePerKg;
  const UW = offer.l - 2 * s.margin;
  const UH = offer.w - 2 * s.margin;
  const splits: Record<string, SplitInfo> = {};
  const nestItems = items.map((p) => {
    const sp = splitFor(p.geom.width, p.geom.height, UW, UH);
    if (sp) splits[p.id] = sp;
    const perUnit = Math.max(1, p.geom.count);
    return sp
      ? { key: p.id, w: sp.pieceW, h: sp.pieceH, qty: p.qty * sp.pieces * perUnit }
      : { key: p.id, w: p.geom.width, h: p.geom.height, qty: p.qty * perUnit };
  });
  const n = nest(nestItems, { sheetW: offer.l, sheetH: offer.w, gap: s.gap, margin: s.margin });
  let sheetsCharged: number;
  let materialCost: number;
  let capped = false;
  const bboxKg = items.reduce((a, p) => a + (p.geom.bboxArea / 1e6) * p.qty, 0) * kgPerM2(mat, t);
  const capCost = bboxKg * (1 + s.maxWastePct / 100) * offer.pricePerKg;
  if (policy === 'bbox') {
    const kg = bboxKg * (1 + s.bboxWastePct / 100);
    materialCost = kg * offer.pricePerKg;
    sheetsCharged = kg / sheetKg;
  } else if (policy === 'whole') {
    // каждый начатый лист целиком, но не больше габаритной массы × (1 + потолок)
    sheetsCharged = Math.ceil(n.sheetsFractional - 1e-9);
    materialCost = sheetsCharged * sheetPrice;
    const capWhole = bboxKg * (1 + (s.maxWasteWholePct ?? 100) / 100) * offer.pricePerKg;
    if (materialCost > capWhole) {
      materialCost = capWhole;
      sheetsCharged = capWhole / sheetPrice;
      capped = true;
    }
  } else {
    // по раскрою: последний лист по занятой части; отход не больше потолка —
    // неудобные детали цех раскладывает вместе с чужими заказами
    sheetsCharged = n.sheetsFractional;
    materialCost = sheetsCharged * sheetPrice;
    if (materialCost > capCost) {
      materialCost = capCost;
      sheetsCharged = capCost / sheetPrice;
      capped = true;
    }
  }
  return { offer, sheetKg, sheetPrice, nest: n, sheetsCharged, materialCost, capped, capCost, splits };
}

export function computeOrder(positions: Position[], book: PriceBook, s: Settings): OrderResult {
  const active = positions.filter((p) => !p.disabled && p.qty > 0);
  const byGroup = new Map<string, Position[]>();
  for (const p of active) {
    const k = groupKey(p.materialId, p.thickness);
    byGroup.set(k, [...(byGroup.get(k) ?? []), p]);
  }

  const groups: GroupResult[] = [];
  const results = new Map<string, PosResult>();
  const T = { material: 0, cutting: 0, bending: 0, extras: 0, delivery: s.delivery, cost: 0, markup: 0, total: 0, vat: 0, kg: 0, cutM: 0, bends: 0, pieces: 0 };
  const markupK = 1 + s.markupPct / 100;

  for (const [key, items] of byGroup) {
    const mat = getMaterial(items[0].materialId);
    const t = items[0].thickness;
    const policy = s.policy[mat.id] ?? mat.policy;
    const offers = sheetOffers(book, mat, t, s);
    const options = offers.map((o) => evalOption(o, mat, t, policy, items, s));
    // авто: сначала листы, куда детали влезают целиком (разбиение = лишняя сварка),
    // среди них — самый дешёвый; при равенстве — меньше листов
    const pieces = (o: SheetOption) => Object.values(o.splits).reduce((a, sp) => a + sp.pieces, 0);
    const auto = options.slice().sort((a, b) => {
      const d = pieces(a) - pieces(b);
      if (d) return d;
      const c = a.materialCost - b.materialCost;
      if (Math.abs(c) > 1) return c;
      return a.nest.sheets.length - b.nest.sheets.length;
    })[0];
    const want = s.sheetChoice[key];
    const picked = want ? options.find((o) => fmtSheet(o.offer.w, o.offer.l) === want) : undefined;
    const chosen = picked ?? auto;
    const autoChosen = !picked;
    const kgm2 = kgPerM2(mat, t);
    const totalBbox = items.reduce((a, p) => a + p.geom.bboxArea * p.qty, 0) || 1;
    const g: GroupResult = {
      key,
      material: mat,
      t,
      policy,
      positionIds: items.map((p) => p.id),
      options,
      chosen,
      auto,
      autoChosen,
      materialCost: chosen.materialCost,
      partsKg: items.reduce((a, p) => a + (p.geom.netArea / 1e6) * kgm2 * p.qty, 0),
      bboxKg: items.reduce((a, p) => a + (p.geom.bboxArea / 1e6) * kgm2 * p.qty, 0),
    };
    groups.push(g);

    const cr = cutRate(s, t);
    const cutK = s.matK?.[mat.id]?.cutK ?? mat.cutK;
    const perBend = bendRate(s, t) * (s.matK?.[mat.id]?.bendK ?? mat.bendK);
    for (const p of items) {
      const warnings: string[] = [];
      const split = chosen.splits[p.id] ?? null;
      if (split) warnings.push(`Не помещается на лист ${fmtSheet(chosen.offer.w, chosen.offer.l)} — считаем из ${split.pieces} частей (+${Math.round(split.extraCut)} мм реза)`);
      const share = (p.geom.bboxArea * p.qty) / totalBbox;
      const material = (chosen.materialCost * share) / p.qty;
      const cutM = (p.geom.cutLength + (split?.extraCut ?? 0)) / 1000;
      const pierces = p.geom.pierces + (split ? split.pieces - 1 : 0);
      const cut = cutM * cr.perM * cutK;
      const pierce = pierces * cr.pierce * cutK;
      const lenK = bendLenFactor(s, p.bendLength);
      let bend = p.bends > 0 ? p.bends * perBend * lenK : 0;
      if (p.bends > 0 && s.bendSetup > 0) bend += s.bendSetup / p.qty;
      if (p.bends > 0 && p.bendLength > 3200) warnings.push('Гиб длиннее 3,2 м — уточните возможности листогиба');
      const extras = p.extras.reduce((a, e) => a + (Number(e.perPiece) || 0), 0);
      const total = material + cut + pierce + bend + extras;
      const piece = { material, cut, pierce, bend, extras, total };
      const sum = {
        material: material * p.qty,
        cut: cut * p.qty,
        pierce: pierce * p.qty,
        bend: bend * p.qty,
        extras: extras * p.qty,
        total: total * p.qty,
      };
      results.set(p.id, {
        id: p.id,
        groupKey: key,
        material: mat,
        qty: p.qty,
        netKg: (p.geom.netArea / 1e6) * kgm2,
        bboxKg: (p.geom.bboxArea / 1e6) * kgm2,
        cutM,
        pierces,
        split,
        rate: { perM: cr.perM * cutK, pierce: cr.pierce * cutK, perBend, lenK, cutK },
        share,
        piece,
        sum,
        price: { piece: total * markupK, sum: sum.total * markupK },
        warnings,
      });
      T.material += sum.material;
      T.cutting += sum.cut + sum.pierce;
      T.bending += sum.bend;
      T.extras += sum.extras;
      T.kg += (p.geom.netArea / 1e6) * kgm2 * p.qty;
      T.cutM += cutM * p.qty;
      T.bends += p.bends * p.qty;
      T.pieces += p.qty;
    }
  }

  T.cost = T.material + T.cutting + T.bending + T.extras + T.delivery;
  T.markup = (T.cost * s.markupPct) / 100;
  T.total = T.cost + T.markup;
  T.vat = (T.total * s.vatPct) / (100 + s.vatPct);
  groups.sort((a, b) => a.material.label.localeCompare(b.material.label) || a.t - b.t);
  return { groups, positions: results, markupPct: s.markupPct, totals: T };
}
