// Модель цены: металл (по раскрою листов) + резка (метры реза по прайсу)
// + гибка (гибы × длина) + доп. работы. Все цены — с НДС.

import { getMaterial, kgPerM2, type CutGroup, type Material, type SheetPolicy } from './materials.ts';
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
  aiId?: string; // добавлена по предложению ИИ (AiSuggestion.id)
}

/** Справочная ставка доп. операции: по ней ИИ оценивает ₽/шт (покраска, резьба, сварка…) */
export interface ExtraRate {
  label: string;
  unit: string; // «м²», «отв.», «м шва», «кг», «шт»
  price: number; // ₽ за единицу с НДС
  note?: string;
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
  bendLengths?: number[]; // длины линий гиба, мм (из чертежа) — тогда каждый гиб считается по своей длине
  extras: Extra[];
  note?: string;
  disabled?: boolean;
}

/** Строка прайса на лазерную резку: ₽ за погонный метр реза по колонкам материала.
 *  t — толщина строки, мм; строка действует для толщин больше предыдущей строки и до t включительно
 *  («2 мм» — для 1,2 и 1,5 мм тоже). null — в прайсе такой резки нет. */
export interface CutRow {
  t: number;
  steel: number | null; // сталь чёрная
  stainless: number | null; // нержавейка
  aluminum: number | null; // алюминий
  copper: number | null; // медь, латунь
  pierce: number | null; // ₽ за врезку (каждый контур — отдельный вход луча), для всех материалов × коэффициент материала
}

export const CUT_GROUPS: readonly { key: CutGroup; label: string }[] = [
  { key: 'steel', label: 'Сталь чёрная' },
  { key: 'stainless', label: 'Нержавейка' },
  { key: 'aluminum', label: 'Алюминий' },
  { key: 'copper', label: 'Медь, латунь' },
];

export interface BendRow {
  t: number;
  perBend: number; // ₽ за гиб длиной до 1 м
}

export interface BendLenRow {
  upTo: number; // мм
  k: number;
}

/** Какой лист берём под толщину: до upTo мм включительно (null — все толще), ширина w; l = null — рулон
 *  (длина — сколько заняла раскладка), иначе лист w×l. Правила — по возрастанию толщины, последнее — «толще». */
export interface SheetRule {
  upTo: number | null;
  w: number;
  l: number | null;
}

/** До 3 мм включительно — рулон 1500, толще — лист 1500×3000 (3,5 мм — тоже лист) */
export const DEFAULT_SHEET_RULES: readonly SheetRule[] = [
  { upTo: 3, w: 1500, l: null },
  { upTo: null, w: 1500, l: 3000 },
];

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
  matK: Record<string, { cutK?: number; bendK?: number }>; // поправки к материалам: к прайсу резки и к гибке
  extraRates: ExtraRate[]; // ставки доп. операций для ИИ-анализа
  priceMaxAgeHours: number; // цены mc.ru старше — обновляются перед расчётом
  sheetRules: SheetRule[]; // «Листы металла»: какой лист (рулон) берём под толщину — авто-выбор листа группы
}

export const DEFAULT_SETTINGS: Settings = {
  // ₽ за погонный метр — прайс «Лазерная резка» (строки 0,2–0,5 и 0,6–1 мм, дальше по толщине), кроме 20 мм:
  // по счёту № 9444 «Лазерная резка СПб» цех взял ≈ 950 ₽/м (в прайсе 557). Врезка (₽ за каждое отверстие и
  // начало реза) в прайсе не указана — подобрана по тому же счёту: 1,5 мм ≈ 8 ₽, 2–6 мм ≈ 6–7 ₽, 10 мм ≈ 28 ₽.
  cutting: [
    { t: 0.5, steel: 33, stainless: 42, aluminum: 39, copper: 43, pierce: 6 },
    { t: 1, steel: 39, stainless: 49, aluminum: 46, copper: 69, pierce: 7 },
    { t: 1.5, steel: 55, stainless: 63, aluminum: 63, copper: 103, pierce: 8 },
    { t: 2, steel: 55, stainless: 63, aluminum: 63, copper: 103, pierce: 6 },
    { t: 3, steel: 63, stainless: 74, aluminum: 69, copper: 130, pierce: 6 },
    { t: 4, steel: 68, stainless: 88, aluminum: 83, copper: 167, pierce: 7 },
    { t: 5, steel: 71, stainless: 103, aluminum: 101, copper: null, pierce: 7 },
    { t: 6, steel: 83, stainless: 158, aluminum: 133, copper: null, pierce: 7 },
    { t: 8, steel: 114, stainless: 282, aluminum: 243, copper: null, pierce: 15 },
    { t: 10, steel: 167, stainless: 583, aluminum: null, copper: null, pierce: 28 },
    { t: 12, steel: 208, stainless: null, aluminum: null, copper: null, pierce: 34 },
    { t: 14, steel: 295, stainless: null, aluminum: null, copper: null, pierce: 42 },
    { t: 16, steel: 338, stainless: null, aluminum: null, copper: null, pierce: 50 },
    { t: 18, steel: 482, stainless: null, aluminum: null, copper: null, pierce: 65 },
    { t: 20, steel: 950, stainless: null, aluminum: null, copper: null, pierce: 80 },
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
  // ориентировочные цены подрядчиков СПб, 2026 — правьте в «Расценках»
  extraRates: [
    { label: 'Порошковая покраска', unit: 'м²', price: 650, note: 'площадь с двух сторон' },
    { label: 'Грунтовка / покраска эмалью', unit: 'м²', price: 350, note: 'площадь с двух сторон' },
    { label: 'Горячее цинкование', unit: 'кг', price: 75 },
    { label: 'Нарезка резьбы М3–М10', unit: 'отв.', price: 35 },
    { label: 'Зенковка / фаска отверстия', unit: 'отв.', price: 20 },
    { label: 'Запрессовка крепежа', unit: 'шт', price: 30, note: 'без стоимости крепежа' },
    { label: 'Сварка полуавтоматом', unit: 'м шва', price: 700 },
    { label: 'Сварка аргоном (нерж., алюминий)', unit: 'м шва', price: 1500 },
    { label: 'Зачистка кромок', unit: 'м', price: 40 },
    { label: 'Вальцовка', unit: 'шт', price: 400, note: 'простая обечайка; крупные — дороже' },
    { label: 'Галтовка (снятие заусенцев)', unit: 'кг', price: 60 },
  ],
  priceMaxAgeHours: 24,
  sheetRules: DEFAULT_SHEET_RULES.map((r) => ({ ...r })),
};

const okDim = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** Правила листов так, как их читает расчёт: по возрастанию толщины, последнее — «толще» (upTo = null).
 *  Нет правил или они битые (старый файл расценок, ручная правка) — правила по умолчанию. */
export function normalizeSheetRules(v: unknown): SheetRule[] {
  const def = () => DEFAULT_SHEET_RULES.map((r) => ({ ...r }));
  if (!Array.isArray(v) || !v.length || v.length > 100) return def();
  const rows: SheetRule[] = [];
  for (const r of v as unknown[]) {
    if (!r || typeof r !== 'object') return def();
    const x = r as Record<string, unknown>;
    if (!okDim(x.w) || (x.l != null && !okDim(x.l)) || (x.upTo != null && !okDim(x.upTo))) return def();
    rows.push({ upTo: x.upTo == null ? null : (x.upTo as number), w: x.w as number, l: x.l == null ? null : (x.l as number) });
  }
  const bounded = rows.filter((r) => r.upTo != null).sort((a, b) => a.upTo! - b.upTo!);
  const rest = rows.find((r) => r.upTo == null);
  if (rest) return [...bounded, rest];
  // «толще» нет — последнее правило действует и для всех толщин больше
  return [...bounded.slice(0, -1), { ...bounded[bounded.length - 1], upTo: null }];
}

/** Правило для толщины t: первое с t ≤ upTo, иначе последнее («толще») */
export function sheetRuleFor(s: Pick<Settings, 'sheetRules'>, t: number): SheetRule {
  const rules = normalizeSheetRules(s.sheetRules);
  return rules.find((r) => r.upTo == null || t <= r.upTo + 1e-9) ?? rules[rules.length - 1];
}

/** «3», «3,5» — толщина в тексте правила */
const n1s = (v: number) => String(Math.round(v * 100) / 100).replace('.', ',');

/** «рулон 1500» / «лист 1500×3000» */
export const ruleLabel = (r: SheetRule): string => (r.l == null ? `рулон ${r.w}` : `лист ${fmtSheet(Math.min(r.w, r.l), Math.max(r.w, r.l))}`);

/** «до 3 мм — рулон 1500», «толще 3 мм — лист 1500×3000» */
export function ruleText(s: Pick<Settings, 'sheetRules'>, r: SheetRule): string {
  if (r.upTo != null) return `до ${n1s(r.upTo)} мм — ${ruleLabel(r)}`;
  const rules = normalizeSheetRules(s.sheetRules);
  const prev = rules.length > 1 ? rules[rules.length - 2].upTo : null;
  return `${prev != null ? `толще ${n1s(prev)} мм` : 'все толщины'} — ${ruleLabel(r)}`;
}

// ---------- цены металла ----------

export interface PriceItem {
  t: number;
  w: number; // ширина листа, мм
  l: number; // длина листа, мм
  pricePerKg: number; // ₽/кг с НДС (розница)
  name: string;
  mark: string;
  fetchedAt?: string; // когда взято с mc.ru (ISO); в старых снимках нет
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
  coil?: boolean; // рулон шириной w (l = 0): металл — по длине размотки
  rule?: boolean; // формат из правила «Листы металла» для этой толщины
}

function median(xs: number[]): number {
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export const groupKey = (materialId: string, t: number) => `${materialId}|${t}`;
/** «1500×3000»; рулон (l = 0) — «рулон 1500». Это же ключ выбора листа в sheetChoice */
export const fmtSheet = (w: number, l: number) => (l > 0 ? `${w}×${l}` : `рулон ${w}`);

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
  // формат по правилу «Листы металла»: есть среди предложений — помечаем; нет — ₽/кг этой толщины (лучше той же ширины)
  const rule = sheetRuleFor(s, t);
  const ruleKey = rule.l == null ? fmtSheet(rule.w, 0) : fmtSheet(Math.min(rule.w, rule.l), Math.max(rule.w, rule.l));
  const have = offers.findIndex((o) => fmtSheet(o.w, o.l) === ruleKey);
  if (have >= 0) offers[have] = { ...offers[have], rule: true };
  else {
    const same = exact.filter((i) => Math.min(i.w, i.l) === rule.w);
    const base = same.length ? same : exact;
    const fmts = [...new Set(base.map((i) => fmtSheet(Math.min(i.w, i.l), Math.max(i.w, i.l))))].join(', ');
    const ref = base.length
      ? { pricePerKg: median(base.map((i) => i.pricePerKg)), source: 'mc' as const }
      : { pricePerKg: offers[0]?.pricePerKg ?? mat.fallbackPricePerKg, source: 'estimate' as const };
    const why = base.length ? `₽/кг как у ${rule.l == null ? 'листа ' : ''}${fmts} на mc.ru` : (offers[0]?.note ?? 'цена по умолчанию');
    const note = rule.l == null ? `рулон ${rule.w} — ${why}` : `нет ${ruleKey} на mc.ru — ${why}`;
    offers.push(
      rule.l == null
        ? { w: rule.w, l: 0, coil: true, rule: true, note, ...ref }
        : { w: Math.min(rule.w, rule.l), l: Math.max(rule.w, rule.l), rule: true, note, ...ref },
    );
  }
  if (manual && manual > 0)
    offers = offers.map((o) => ({ ...o, pricePerKg: manual, source: 'manual' as const, note: o.coil ? `рулон ${o.w} — цена задана вручную` : 'цена задана вручную' }));
  // рулон — первым, листы — по площади
  return offers.sort((a, b) => Number(!!b.coil) - Number(!!a.coil) || a.w * a.l - b.w * b.l);
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

/** Цена резки по прайсу: строка — первая с толщиной не меньше t; null — в прайсе нет */
export function cutRate(s: Settings, t: number, group: CutGroup): { perM: number | null; pierce: number; rowT: number | null } {
  const row = s.cutting
    .slice()
    .sort((a, b) => a.t - b.t)
    .find((r) => r.t >= t - 1e-9);
  const v = row?.[group];
  const pc = row?.pierce;
  return { perM: typeof v === 'number' && v > 0 ? v : null, pierce: typeof pc === 'number' && pc > 0 ? pc : 0, rowT: row?.t ?? null };
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
  sheetKg: number; // рулон — масса 1 м рулона
  sheetPrice: number; // рулон — цена 1 м рулона
  nest: NestResult; // рулон — раскладка на полосе, sheetsFractional — метры размотки
  sheetsCharged: number; // рулон — метры в расчёте
  coilM?: number; // рулон: длина размотки по раскладке (с полями), м
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
  rule: SheetRule; // правило «Листы металла» для этой толщины
  autoWhy: string; // почему автомат выбрал этот лист: «по правилу: до 3 мм — рулон 1500» …
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
  rate: { perM: number | null; pierce: number; cutK: number; rowT: number | null; group: CutGroup; perBend: number; lenK: number };
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

const COIL_STRIP = 200_000; // мм: полоса рулона для раскладки — длиннее любого заказа

/** Рулон: раскладка на одной полосе шириной w; металл — вся ширина × длина размотки (кусок рулона покупается целиком) */
function evalCoil(offer: SheetOffer, mat: Material, t: number, policy: SheetPolicy, items: Position[], s: Settings): SheetOption {
  const meterKg = (offer.w / 1000) * kgPerM2(mat, t);
  const meterPrice = meterKg * offer.pricePerKg;
  const UW = COIL_STRIP - 2 * s.margin;
  const UH = offer.w - 2 * s.margin;
  const splits: Record<string, SplitInfo> = {};
  const nestItems = items.map((p) => {
    const sp = splitFor(p.geom.width, p.geom.height, UW, UH); // только если деталь шире рулона в обе стороны
    if (sp) splits[p.id] = sp;
    const perUnit = Math.max(1, p.geom.count);
    return sp
      ? { key: p.id, w: sp.pieceW, h: sp.pieceH, qty: p.qty * sp.pieces * perUnit }
      : { key: p.id, w: p.geom.width, h: p.geom.height, qty: p.qty * perUnit };
  });
  const n = nest(nestItems, { sheetW: COIL_STRIP, sheetH: offer.w, gap: s.gap, margin: s.margin });
  const lengthMm = n.sheets.reduce((a, sh) => a + sh.usedLength, 0) / n.scale;
  const coilM = lengthMm / 1000;
  const partsArea = n.utilization * n.sheetsFractional * n.sheetW * n.sheetH; // площадь габаритов деталей
  const nestC: NestResult = { ...n, sheetsFractional: coilM, utilization: lengthMm > 0 ? partsArea / (lengthMm * offer.w) : 0 };
  const bboxKg = items.reduce((a, p) => a + (p.geom.bboxArea / 1e6) * p.qty, 0) * kgPerM2(mat, t);
  const capCost = bboxKg * (1 + s.maxWastePct / 100) * offer.pricePerKg;
  let sheetsCharged: number;
  let materialCost: number;
  let capped = false;
  if (policy === 'bbox') {
    const kg = bboxKg * (1 + s.bboxWastePct / 100);
    materialCost = kg * offer.pricePerKg;
    sheetsCharged = kg / meterKg;
  } else {
    // «по раскрою» и «целыми листами» — одинаково: отрезанный кусок рулона покупается целиком; потолки отхода — свои
    sheetsCharged = coilM;
    materialCost = coilM * meterPrice;
    const cap = policy === 'whole' ? bboxKg * (1 + (s.maxWasteWholePct ?? 100) / 100) * offer.pricePerKg : capCost;
    if (materialCost > cap) {
      materialCost = cap;
      sheetsCharged = cap / meterPrice;
      capped = true;
    }
  }
  return { offer, sheetKg: meterKg, sheetPrice: meterPrice, nest: nestC, sheetsCharged, materialCost, capped, capCost, splits, coilM };
}

function evalOption(offer: SheetOffer, mat: Material, t: number, policy: SheetPolicy, items: Position[], s: Settings): SheetOption {
  if (offer.coil) return evalCoil(offer, mat, t, policy, items, s);
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
    const best = options.slice().sort((a, b) => {
      const d = pieces(a) - pieces(b);
      if (d) return d;
      const c = a.materialCost - b.materialCost;
      if (Math.abs(c) > 1) return c;
      return a.nest.sheets.length - b.nest.sheets.length;
    })[0];
    // авто — лист по правилу «Листы металла»; деталь в него целиком не влезает, а в другой лист влезает — тот лист
    const rule = sheetRuleFor(s, t);
    const ruleOpt = options.find((o) => o.offer.rule);
    let auto = best;
    let autoWhy = 'самый дешёвый из листов, куда детали влезают целиком';
    if (ruleOpt && pieces(best) >= pieces(ruleOpt)) {
      auto = ruleOpt;
      autoWhy = `по правилу: ${ruleText(s, rule)}`;
    } else if (ruleOpt) autoWhy = `по правилу ${ruleText(s, rule)}, но деталь туда целиком не влезает — взят ${fmtSheet(best.offer.w, best.offer.l)}`;
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
      rule,
      autoWhy,
    };
    groups.push(g);

    const cr = cutRate(s, t, mat.cutGroup);
    const cutK = s.matK?.[mat.id]?.cutK ?? mat.cutK; // 09Г2С режется медленнее — дороже прайса чёрной стали
    const perBend = bendRate(s, t) * (s.matK?.[mat.id]?.bendK ?? mat.bendK);
    for (const p of items) {
      const warnings: string[] = [];
      const split = chosen.splits[p.id] ?? null;
      if (split) {
        const where = chosen.offer.coil ? `в ширину рулона ${chosen.offer.w}` : `на лист ${fmtSheet(chosen.offer.w, chosen.offer.l)}`;
        warnings.push(`Не помещается ${where} — считаем из ${split.pieces} частей (+${Math.round(split.extraCut)} мм реза)`);
      }
      const share = (p.geom.bboxArea * p.qty) / totalBbox;
      const material = (chosen.materialCost * share) / p.qty;
      const cutM = (p.geom.cutLength + (split?.extraCut ?? 0)) / 1000;
      const pierces = p.geom.pierces + (split ? split.pieces - 1 : 0);
      // резка — метры × ₽/м по прайсу и врезки × ₽/врезку, всё × коэффициент материала
      const cut = cr.perM != null ? cutM * cr.perM * cutK : 0;
      const pierce = cr.perM != null ? pierces * cr.pierce * cutK : 0;
      if (cr.perM == null && cutM > 0) {
        const col = CUT_GROUPS.find((g) => g.key === mat.cutGroup)?.label.toLowerCase();
        warnings.push(`В прайсе резки нет цены: ${col} ${t} мм — резка не посчитана, задайте цену в «Расценках»`);
      }
      // каждый гиб — по своей длине, если длины линий известны и их столько же, сколько гибов; иначе все по bendLength
      const lens = p.bendLengths?.length === p.bends && p.bends > 0 ? p.bendLengths : null;
      const lenK = lens ? lens.reduce((a, l) => a + bendLenFactor(s, l), 0) / lens.length : bendLenFactor(s, p.bendLength);
      let bend = p.bends > 0 ? p.bends * perBend * lenK : 0;
      if (p.bends > 0 && s.bendSetup > 0) bend += s.bendSetup / p.qty;
      if (p.bends > 0 && Math.max(p.bendLength, ...(lens ?? [])) > 3200) warnings.push('Гиб длиннее 3,2 м — уточните возможности листогиба');
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
        rate: { perM: cr.perM, pierce: cr.pierce, cutK, rowT: cr.rowT, group: mat.cutGroup, perBend, lenK },
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
