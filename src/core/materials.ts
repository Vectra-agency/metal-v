// Справочник материалов: плотность, как искать цену на mc.ru,
// поправки к резке/гибке и правило списания листа.

export type SheetPolicy = 'length' | 'whole' | 'bbox';

export interface Material {
  id: string;
  label: string;
  short: string; // для таблиц
  density: number; // кг/м³
  extraKgM2: number; // добавка массы (рифление), кг/м²
  cutK: number; // множитель к расценке резки чёрной стали
  bendK: number; // множитель к расценке гибки
  policy: SheetPolicy; // как списывается лист
  fallbackPricePerKg: number; // если mc.ru недоступен, ₽/кг с НДС
  thicknesses: number[]; // типовые толщины (для выбора и для выгрузки цен)
  defaultSheets: [number, number][]; // типовые форматы, если цен нет
  mc: {
    category: string; // раздел mc.ru
    mark?: string; // RegExp по марке
    name?: string; // RegExp по наименованию
    exclude?: string; // RegExp исключений
  };
  aliases: RegExp; // распознавание в имени файла
}

const STEEL_SHEETS: [number, number][] = [
  [1250, 2500],
  [1500, 3000],
  [1500, 6000],
];
const THIN_SHEETS: [number, number][] = [
  [1000, 2000],
  [1250, 2500],
];
const STAINLESS_SHEETS: [number, number][] = [
  [1000, 2000],
  [1250, 2500],
  [1500, 3000],
];
const ALU_SHEETS: [number, number][] = [
  [1200, 3000],
  [1500, 3000],
];

export const MATERIALS: Material[] = [
  {
    id: 'st3',
    label: 'Ст3 горячекатаный',
    short: 'Ст3',
    density: 7850,
    extraKgM2: 0,
    cutK: 1,
    bendK: 1,
    policy: 'length',
    fallbackPricePerKg: 64,
    thicknesses: [1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 14, 16, 20, 25],
    defaultSheets: STEEL_SHEETS,
    mc: { category: 'stal_listovaya_g_k_st3', exclude: '2 сорт' },
    aliases: /(?:^|[\s_\-.])(st3\w*|ст\.?3\w*|s235\w*|ст1-3\w*)(?=$|[\s_\-.])/i,
  },
  {
    id: '08ps',
    label: '08пс холоднокатаный',
    short: '08пс х/к',
    density: 7850,
    extraKgM2: 0,
    cutK: 1,
    bendK: 1,
    policy: 'length',
    fallbackPricePerKg: 66,
    thicknesses: [0.5, 0.7, 0.8, 1, 1.2, 1.5, 2, 2.5, 3],
    defaultSheets: [
      [1250, 2500],
      [1000, 2000],
    ],
    mc: { category: 'stal_listovaya_h_k_st', mark: 'Ст08|08пс|08кп|08Ю', exclude: '2 сорт' },
    aliases: /(?:^|[\s_\-.])(08ps|08пс|08kp|08кп|08ю|08yu|dc01|hk|х\/?к)(?=$|[\s_\-.])/i,
  },
  {
    id: '09g2s',
    label: '09Г2С',
    short: '09Г2С',
    density: 7850,
    extraKgM2: 0,
    cutK: 1.15,
    bendK: 1.15,
    policy: 'length',
    fallbackPricePerKg: 70,
    thicknesses: [2, 3, 4, 5, 6, 8, 10, 12, 14, 16, 20, 25, 30],
    defaultSheets: STEEL_SHEETS,
    mc: { category: 'list_g_k_nizkolegirovannyj', mark: '09Г2С' },
    aliases: /(?:^|[\s_\-.])(09g2s|09г2с|s355\w*)(?=$|[\s_\-.])/i,
  },
  {
    id: 'rifl',
    label: 'Рифлёный Ст3 (ромб/чечевица)',
    short: 'Рифл. Ст3',
    density: 7850,
    extraKgM2: 1.8,
    cutK: 1.05,
    bendK: 1.2,
    policy: 'length',
    fallbackPricePerKg: 66,
    thicknesses: [2, 2.5, 3, 4, 5, 6, 8, 10],
    defaultSheets: [
      [1250, 2500],
      [1500, 3000],
      [1500, 6000],
    ],
    mc: { category: 'list_riflenyj' },
    aliases: /(rifl\w*|рифл\w*|romb\w*|ромб\w*|chechev\w*|чечев\w*|к-пу)/i,
  },
  {
    id: 'ocink',
    label: 'Оцинкованная сталь',
    short: 'Оцинк.',
    density: 7850,
    extraKgM2: 0,
    cutK: 1.1,
    bendK: 1,
    policy: 'length',
    fallbackPricePerKg: 85,
    thicknesses: [0.5, 0.7, 0.8, 1, 1.2, 1.5, 2, 2.5, 3],
    defaultSheets: THIN_SHEETS,
    mc: { category: 'stal_listovaya_ocinkovannaya' },
    aliases: /(ocink\w*|оцинк\w*|zink\w*|dx51\w*|(?:^|[\s_\-.])zn(?=$|[\s_\-.]))/i,
  },
  {
    id: 'aisi304',
    label: 'Нерж. AISI 304 (08Х18Н10)',
    short: 'AISI 304',
    density: 7900,
    extraKgM2: 0,
    cutK: 1.8,
    bendK: 1.5,
    policy: 'whole', // цех обычно докупает такой металл целыми листами
    fallbackPricePerKg: 310,
    thicknesses: [0.5, 0.8, 1, 1.5, 2, 3, 4, 5, 6, 8, 10],
    defaultSheets: STAINLESS_SHEETS,
    mc: {
      category: 'stal_listovaya_nerzhaveyushchaya_nikelsoderzhashchaya',
      mark: 'AISI 304 \\(|08Х18Н10\\)|^AISI 304$',
    },
    aliases: /(aisi\s?304\w*|08[хx]18[нh]10(?![тt])|(?:^|[\s_\-.])304(?=$|[\s_\-.]))/i,
  },
  {
    id: 'aisi321',
    label: 'Нерж. AISI 321 (12Х18Н10Т)',
    short: 'AISI 321',
    density: 7900,
    extraKgM2: 0,
    cutK: 1.8,
    bendK: 1.5,
    policy: 'whole', // цех обычно докупает такой металл целыми листами
    fallbackPricePerKg: 360,
    thicknesses: [0.5, 0.8, 1, 1.5, 2, 3, 4, 5, 6, 8, 10],
    defaultSheets: STAINLESS_SHEETS,
    mc: {
      category: 'stal_listovaya_nerzhaveyushchaya_nikelsoderzhashchaya',
      mark: '321|12Х18Н10Т|08Х18Н10Т',
    },
    aliases: /(aisi\s?321|[01][28][хx]18[нh]10[тt])/i,
  },
  {
    id: 'aisi430',
    label: 'Нерж. AISI 430 (08Х17)',
    short: 'AISI 430',
    density: 7700,
    extraKgM2: 0,
    cutK: 1.6,
    bendK: 1.3,
    policy: 'whole', // цех обычно докупает такой металл целыми листами
    fallbackPricePerKg: 190,
    thicknesses: [0.5, 0.8, 1, 1.5, 2, 3],
    defaultSheets: STAINLESS_SHEETS,
    mc: { category: 'stal_listovaya_nerzhaveyushchaya_bez_nikelya', mark: '430' },
    aliases: /(aisi\s?430|08[хx]17|(?:^|[\s_\-.])430(?=$|[\s_\-.]))/i,
  },
  {
    id: 'amg2',
    label: 'Алюминий АМг2',
    short: 'АМг2',
    density: 2680,
    extraKgM2: 0,
    cutK: 1.5,
    bendK: 1.2,
    policy: 'whole', // цех обычно докупает такой металл целыми листами
    fallbackPricePerKg: 600,
    thicknesses: [0.5, 0.8, 1, 1.5, 2, 2.5, 3, 4, 5, 6],
    defaultSheets: ALU_SHEETS,
    mc: { category: 'alyuminievyj_list', mark: 'АМГ2', exclude: '(^|\\s)НН(\\s|$)|РМРС' },
    aliases: /(amg2|амг2)/i,
  },
  {
    id: 'amg2r',
    label: 'Алюминий АМг2 рифлёный (квинтет)',
    short: 'АМг2 рифл.',
    density: 2680,
    extraKgM2: 0.4,
    cutK: 1.5,
    bendK: 1.3,
    policy: 'whole', // цех обычно докупает такой металл целыми листами
    fallbackPricePerKg: 670,
    thicknesses: [1.5, 2, 3, 4, 5],
    defaultSheets: ALU_SHEETS,
    mc: { category: 'alyuminievyj_list_riflenie', name: 'квинтет' },
    aliases: /((amg2|амг2).*(rifl|рифл|kvint|квинт))|((rifl|рифл|kvint|квинт).*(amg2|амг2))/i,
  },
  {
    id: 'amg5',
    label: 'Алюминий АМг5',
    short: 'АМг5',
    density: 2650,
    extraKgM2: 0,
    cutK: 1.6,
    bendK: 1.3,
    policy: 'whole', // цех обычно докупает такой металл целыми листами
    fallbackPricePerKg: 650,
    thicknesses: [1, 1.5, 2, 3, 4, 5, 6, 8, 10],
    defaultSheets: ALU_SHEETS,
    mc: { category: 'alyuminievyj_list', mark: 'АМГ5', exclude: '(^|\\s)НН(\\s|$)' },
    aliases: /(amg5|амг5)/i,
  },
];

export const MATERIAL_BY_ID = new Map(MATERIALS.map((m) => [m.id, m]));

export function getMaterial(id: string): Material {
  return MATERIAL_BY_ID.get(id) ?? MATERIALS[0];
}

/** Масса 1 м² листа, кг */
export function kgPerM2(m: Material, t: number): number {
  return (m.density * t) / 1000 + m.extraKgM2;
}

// ---------- разбор имени файла ----------

export interface ParsedName {
  name: string; // обозначение детали
  materialId: string | null;
  thickness: number | null;
  qty: number | null;
}

export function parseFileName(fileName: string): ParsedName {
  const base = fileName.replace(/\.[^.]+$/, '').trim();
  let materialId: string | null = null;
  // порядок важен: сначала более специфичные
  for (const id of ['amg2r', 'rifl', 'aisi321', 'aisi304', 'aisi430', 'ocink', 'amg2', 'amg5', '09g2s', '08ps', 'st3']) {
    if (MATERIAL_BY_ID.get(id)!.aliases.test(base)) {
      materialId = id;
      break;
    }
  }
  const tm =
    /(?:^|[\s_\-.])s\s?(\d+(?:[.,]\d+)?)\s?(?:mm|мм)?(?=$|[\s_\-.])/i.exec(base) ??
    /(?:^|[\s_\-.])(?:t|δ|s=|t=)\s?(\d+(?:[.,]\d+)?)(?:\s?(?:mm|мм))?(?=$|[\s_\-.])/i.exec(base) ??
    /(?:^|[\s_\-.])(\d+(?:[.,]\d+)?)\s?(?:mm|мм)(?=$|[\s_\-.])/i.exec(base);
  const thickness = tm ? parseFloat(tm[1].replace(',', '.')) : null;
  const qm = /(?:^|[\s_\-.])(\d+)\s?(?:sht|шт|pcs|pc)\.?(?=$|[\s_\-.])/i.exec(base) ?? /(?:^|[\s_\-.])[xх×](\d+)(?=$|[\s_\-.])/i.exec(base);
  const qty = qm ? parseInt(qm[1], 10) : null;

  // обозначение — всё до первого распознанного токена
  const cuts = [tm?.index, qm?.index].filter((v): v is number => typeof v === 'number');
  if (materialId) {
    const mm = MATERIAL_BY_ID.get(materialId)!.aliases.exec(base);
    if (mm) cuts.push(mm.index);
  }
  let name = cuts.length ? base.slice(0, Math.min(...cuts)) : base;
  name = name.replace(/[\s_\-.]+$/, '').trim() || base;
  return { name, materialId, thickness: thickness && thickness > 0 && thickness < 200 ? thickness : null, qty: qty && qty > 0 ? qty : null };
}
