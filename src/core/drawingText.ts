// Текст чертежей и документов для ИИ-анализа.
// PDF: фрагменты pdf.js → строки в порядке чтения (по базовой линии с учётом поворота),
// «Технические требования» первыми, штамп одной строкой, таблица исполнений компактно,
// размерные числа отбрасываются. DXF: строки TEXT/MTEXT без кодов форматирования.
// Модуль чистый: работает и в браузере, и в Node.

import { AI_LIMITS } from './ai.ts';
import type { DxfLabel } from './dxf.ts';
import type { PdfPageData, PdfText } from './pdf.ts';
import { findDesignation, keyDesig, normText, readTitle, titleRegion } from './pdfAnalyze.ts';
import type { Box } from './geometry.ts';

/** Метка обрезанного текста — модель должна понимать, что текст неполный */
export const CUT_MARK = '…[обрезано]';

/** Обрезает текст до max символов (по границе строки, если она недалеко) с меткой обрезки */
export function clipText(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  if (max <= CUT_MARK.length) return t.slice(0, Math.max(0, max));
  const room = max - CUT_MARK.length;
  let cut = t.slice(0, room);
  const nl = cut.lastIndexOf('\n');
  if (nl > room * 0.7) cut = cut.slice(0, nl);
  else {
    const sp = cut.lastIndexOf(' ');
    if (sp > room * 0.85) cut = cut.slice(0, sp);
  }
  return cut.trimEnd() + CUT_MARK;
}

// ---------- нормализация строк ----------

/** Символьные шрифты КОМПАС (Symbol type A/B) отдают служебные буквы вместо знаков */
export function cleanPdfStr(s: string): string {
  return s
    .replace(/[\u0000-\u001f\u007f\ufffd\ue000-\uf8ff]/g, ' ')
    .replace(/Ç/g, 'Ø') // знак диаметра
    .replace(/Å/g, '°') // градус
    .replace(/(\d)\s*•\s*(?=\d)/g, '$1×') // 27•45 → 27×45
    .replace(/^ä$/, '') // знак «развёрнуто»
    .replace(/\s+/g, ' ')
    .trim();
}

const LETTERS2 = /[A-Za-zА-Яа-яЁё]{2,}/;
const KEEP_SHORT = [/^[МM]\s?\d/, /^[sS]\s?\d/]; // резьба М6, толщина s2

/** Размерные числа, буквенные обозначения размеров и видов, шероховатость — для ИИ шум */
const NOISE = [
  /^[-+±]?\s*[ØR⌀]?\s*\d+(?:[.,]\d+)?\s*[*°]?\s*\*?$/, // 25, Ø10,5, R3, 2*, 141°
  /^[-+±]?\d+(?:[.,]\d+)?\s*[×xх]\s*\d+(?:[.,]\d+)?\s*°?$/, // 27×45°
  /^\(?\s*\d+(?:[.,]\d+)?\s*:\s*\d+(?:[.,]\d+)?\s*\)?$/, // (1:5)
  /^[A-Za-zА-Яа-яЁё]{1,2}\s*\*?$/, // L, A*, Б
  /^[A-ZА-ЯЁ]\s*-\s*[A-ZА-ЯЁ]$/i, // разрез А-А
  /^[()*°.,:;|\-_/\\\s]+$/, // скобки, звёздочки, черта
  /^Ra\s*\d/i, // шероховатость
  /^[A-LN-ZА-ЛН-ЯЁ]\d{1,2}$/, // типы сварных швов С2, У4 (кроме М — резьба)
];
/** Подпись вида с масштабом: «A(1:5)», «Изометрический вид (1:15)» */
const VIEW_LABEL = /^[^\d]{0,40}\(\s*\d+(?:[.,]\d+)?\s*:\s*\d+(?:[.,]\d+)?\s*\)$/;

export function isNoise(s: string): boolean {
  const t = s.trim();
  if (!t) return true;
  if (KEEP_SHORT.some((re) => re.test(t))) return false;
  if (VIEW_LABEL.test(t) && t.split(' ').length <= 4) return true;
  if (LETTERS2.test(t)) return /^Ra\s*\d/i.test(t);
  return NOISE.some((re) => re.test(t)) || !/[A-Za-zА-Яа-яЁё]/.test(t);
}

/** Подписи граф штампа и полей (без значений) — в текст не идут */
const TITLE_LABEL =
  /^(ИЗМ\.?|ИЗМ\.? ЛИСТ|ЛИСТ|ЛИСТОВ|ЛИТ\.?|МАССА|МАСШТАБ|РАЗРАБ\.?|ПРОВ\.?|Т\.? ?КОНТР\.?|Н\.? ?КОНТР\.?|УТВ\.?|СОГЛ\.?|[№N] ?ДОКУМ\.?|ПОДП\.?|ПОДПИСЬ|ДАТА|КОПИРОВАЛ|ФОРМАТ( ?А\d)?|А\d|ВСЕ|ЗАМ\.?|НОВ\.?|НАЧ\.? ?ОТД\.?|ГЛ\.? ?КОНСТР\.?)$/;
const MARGIN_LABEL = /^(ИНВ|ПОДП|ВЗАМ|СПРАВ|ПЕРВ|И ?НВ|ДУБЛ|ПОДЛ)/;

const isTitleLabel = (s: string) => TITLE_LABEL.test(normText(s));

// ---------- фрагменты → строки ----------

interface Frag {
  str: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number; // 0 / 90 / 270 / прочий угол (округлённый)
  u: number; // вдоль строки
  v: number; // поперёк (базовая линия), больше — выше
}

interface Seg {
  text: string;
  u0: number;
  u1: number;
  v: number;
  h: number;
  x: number;
  y: number;
  rot: number;
  parts: Frag[];
}

interface Line {
  segs: Seg[];
  v: number;
  h: number;
  rot: number;
}

function rotBucket(angle: number): number {
  const a = ((angle % 360) + 360) % 360;
  for (const r of [0, 90, 180, 270, 360]) if (Math.abs(a - r) < 4) return r % 360;
  return Math.round(a / 5) * 5;
}

function fragsOf(page: PdfPageData, keep: (t: PdfText) => boolean = () => true): Frag[] {
  const seen = new Set<string>();
  const out: Frag[] = [];
  for (const t of page.texts) {
    if (!keep(t)) continue;
    const str = cleanPdfStr(t.str);
    if (!str) continue;
    // КОМПАС часто выводит один и тот же текст дважды
    const key = `${str}|${Math.round(t.x * 2)}|${Math.round(t.y * 2)}|${Math.round(t.angle)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const rot = rotBucket(t.angle);
    const th = (rot * Math.PI) / 180;
    const c = Math.cos(th);
    const s = Math.sin(th);
    out.push({ str, x: t.x, y: t.y, w: Math.max(0, t.w), h: Math.max(0.8, t.h), rot, u: t.x * c + t.y * s, v: -t.x * s + t.y * c });
  }
  return out;
}

const joinSep = (prev: string, gap: number, h: number) => (gap > 0.18 * h && !prev.endsWith(' ') ? ' ' : '');

/** Ячейки таблицы: фрагменты строки, разбитые по разрывам больше 0,6 высоты шрифта */
function cellsOf(segs: Seg[]): { text: string; u0: number; u1: number; seg: Seg }[] {
  const out: { text: string; u0: number; u1: number; seg: Seg }[] = [];
  for (const s of segs) {
    let cur: (typeof out)[number] | null = null;
    for (const f of s.parts) {
      const gap = cur ? f.u - cur.u1 : Infinity;
      if (cur && gap <= 0.6 * f.h) {
        cur.text += joinSep(cur.text, gap, f.h) + f.str;
        cur.u1 = Math.max(cur.u1, f.u + f.w);
      } else {
        cur = { text: f.str, u0: f.u, u1: f.u + f.w, seg: s };
        out.push(cur);
      }
    }
  }
  return out;
}

/** Группировка по базовой линии и разбиение строки на ячейки по большим разрывам */
function linesOf(frags: Frag[]): Line[] {
  const byRot = new Map<number, Frag[]>();
  for (const f of frags) byRot.set(f.rot, [...(byRot.get(f.rot) ?? []), f]);
  const lines: Line[] = [];
  for (const [rot, fs] of byRot) {
    fs.sort((a, b) => b.v - a.v || a.u - b.u);
    const groups: { v: number; h: number; items: Frag[] }[] = [];
    for (const f of fs) {
      // группы идут сверху вниз: смотрим только последние, что выше не больше чем на 10 мм
      let g: (typeof groups)[number] | undefined;
      for (let k = groups.length - 1; k >= 0 && groups[k].v - f.v <= 10; k--) {
        if (Math.abs(groups[k].v - f.v) <= 0.35 * Math.min(groups[k].h, f.h)) {
          g = groups[k];
          break;
        }
      }
      if (g) g.items.push(f);
      else groups.push({ v: f.v, h: f.h, items: [f] });
    }
    for (const g of groups) {
      g.items.sort((a, b) => a.u - b.u);
      const segs: Seg[] = [];
      let cur: Seg | null = null;
      for (const f of g.items) {
        const h = Math.max(f.h, cur?.h ?? 0);
        const gap = cur ? f.u - cur.u1 : Infinity;
        if (cur && gap <= 1.6 * h) {
          if (gap < 0 && f.u + f.w <= cur.u1 + 0.5 && cur.text.endsWith(f.str)) continue; // наложение
          cur.text += joinSep(cur.text, gap, h) + f.str;
          cur.u1 = Math.max(cur.u1, f.u + f.w);
          cur.h = h;
          cur.parts.push(f);
        } else {
          cur = { text: f.str, u0: f.u, u1: f.u + f.w, v: f.v, h: f.h, x: f.x, y: f.y, rot, parts: [f] };
          segs.push(cur);
        }
      }
      lines.push({ segs, v: g.v, h: Math.max(...g.items.map((f) => f.h)), rot });
    }
  }
  // порядок чтения: горизонтальный текст сверху вниз, потом повёрнутый
  const rank = (r: number) => (r === 0 ? 0 : r === 90 ? 1 : r === 270 ? 2 : 3);
  return lines.sort((a, b) => rank(a.rot) - rank(b.rot) || b.v - a.v || a.segs[0].u0 - b.segs[0].u0);
}

const inBox = (p: { x: number; y: number }, b: Box | null) => !!b && p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY;
const fmtNum = (v: number) => String(Math.round(v * 1000) / 1000).replace('.', ',');

// ---------- штамп ----------

const SPEC_RE = /ГОСТ|ОСТ\s|ТУ\s|ТУ$|AISI|DIN\s|ASTM|EN\s?\d/;
const KIND_RE = /^(ЛИСТ|ЛЕНТА|ПОЛОСА|ПРУТОК|КРУГ|ТРУБА|УГОЛОК|ШВЕЛЛЕР|ПРОФИЛЬ)(\s+[^\d\s]+)?$/; // «Лист», «Лист ромб»
const ORG_RE = /(^|\s)(ООО|ОАО|ЗАО|ПАО|АО|ИП|ФГУП|НПО|НПП)(\s|$)|«|"/;

/** Штамп одной строкой: обозначение, наименование, материал, масса, масштаб, организация */
export function titleLine(page: PdfPageData): string | null {
  const reg = titleRegion(page);
  if (!reg) return null;
  const info = readTitle(page, reg);
  const texts = fragsOf(page, (t) => Math.abs(t.angle) < 5 && inBox(t, reg));
  if (!texts.length) return null;
  // левый край штампа — графы «Изм», «Разраб.»…; подписи, фамилии, даты и извещения — первые 65 мм
  const lefts = texts.filter((t) => /^(ИЗМ|РАЗРАБ|ПРОВ|Т\.? ?КОНТР|Н\.? ?КОНТР|УТВ)/.test(normText(t.str))).map((t) => t.x);
  const left = lefts.length ? Math.min(...lefts) - 1 : page.width - 190;
  const midL = left + 64;
  const midR = left + 136;
  const dKey = info.designation ? keyDesig(info.designation) : '';
  const isDesig = (t: Frag) => !!dKey && keyDesig(findDesignation(t.str) ?? t.str) === dKey;
  const middle = texts.filter((t) => t.x + t.w / 2 >= midL && t.x <= midR && !/^_+$/.test(t.str));
  const specs = middle.filter((t) => SPEC_RE.test(normText(t.str))).sort((a, b) => b.y - a.y || a.x - b.x);
  // «Лист» слева от дроби «2 ГОСТ 19904-90 / Ст3 ГОСТ 16523-97» (не путать с графой «Лист»)
  const kinds = texts.filter(
    (t) => KIND_RE.test(normText(t.str)) && t.x >= midL - 5 && specs.some((s) => s.x > t.x + 4 && s.x - t.x < 60 && Math.abs(s.y - t.y) <= 9),
  );
  const matText = [kinds.map((t) => t.str).join(' '), specs.map((t) => t.str).join(' / ')].filter(Boolean).join(' ');
  const name = middle
    .filter(
      (t) =>
        !specs.includes(t) &&
        !kinds.includes(t) &&
        !isDesig(t) &&
        !isTitleLabel(t.str) &&
        LETTERS2.test(t.str) &&
        !ORG_RE.test(t.str) &&
        !/^\d/.test(t.str) &&
        !/см\.?\s*табл/i.test(t.str),
    )
    .sort((a, b) => b.y - a.y || a.x - b.x)
    .map((t) => t.str)
    .join(' ');
  const org = texts.find((t) => t.x >= midL && ORG_RE.test(t.str) && LETTERS2.test(t.str));
  const parts: string[] = [];
  if (info.designation) parts.push(info.designation + (name ? ` «${name}»` : ''));
  else if (name) parts.push(`«${name}»`);
  if (matText) parts.push(`материал: ${matText}`);
  if (info.mass) parts.push(`масса ${fmtNum(info.mass)} кг`);
  else if (info.massInTable) parts.push('масса: см. таблицу');
  if (info.sheetScale) parts.push(`масштаб 1:${fmtNum(info.sheetScale)}`);
  if (org) parts.push(org.str);
  return parts.length ? `Штамп: ${parts.join('; ')}` : null;
}

// ---------- технические требования и таблицы ----------

const TT_HEAD = /^ТЕХНИЧЕСКИЕ\s+ТРЕБОВАНИЯ/;
const ITEM = /^\d{1,2}(?:[.)]\s*|\s+)\S/;
const TABLE_HEAD = /^(ОБОЗНАЧЕНИЕ|ПОЗ\.?|НАИМЕНОВАНИЕ|КОЛ\.?|КОЛ-ВО)$/;
const isNumCell = (s: string) => /^[-+±]?[ØR]?\s*\d+(?:[.,]\d+)?\s*[*°]?$/.test(s.trim());
const isRowKey = (s: string) => !!findDesignation(s) || /^-\d{1,4}$/.test(s.trim());

interface PageText {
  tt: string[]; // пункты технических требований
  title: string | null;
  table: string[];
  notes: string[];
}

function pageText(page: PdfPageData): PageText {
  const reg = titleRegion(page);
  const title = titleLine(page);
  const info = reg ? readTitle(page, reg) : null;
  const dKey = info?.designation ? keyDesig(info.designation) : '';
  const W = page.width;
  const frags = fragsOf(page, (t) => {
    const r = rotBucket(t.angle);
    if (r === 180) return false; // перевёрнутое обозначение в углу (графа 26)
    if (W > 200 && t.x < 22 && r !== 0 && MARGIN_LABEL.test(normText(t.str))) return false; // поля подшивки
    if (r === 0 && inBox(t, reg)) return false; // штамп — отдельной строкой
    return true;
  });
  const lines = linesOf(frags);
  const used = new Set<Seg>();

  // таблицы: строка-заголовок с «Обозначение» и строки ниже с обозначением и числами
  const table: string[] = [];
  const flat = lines.filter((l) => l.rot === 0);
  for (let i = 0; i < flat.length; i++) {
    const head = flat[i];
    const hcells = cellsOf(head.segs.filter((s) => !used.has(s)));
    const hi = hcells.findIndex((c) => TABLE_HEAD.test(normText(c.text)));
    if (hi < 0 || hcells.length - hi < 2) continue;
    const x0 = hcells[hi].u0 - 32;
    const x1 = hcells[hcells.length - 1].u1 + 12;
    const within = (cs: ReturnType<typeof cellsOf>) => cs.filter((c) => c.u0 >= x0 && c.u0 <= x1 && !/^[*()°.,\s]+$/.test(c.text));
    const hs = within(hcells);
    const rows: string[] = [];
    const rowSegs: Seg[] = [];
    let lastV = head.v;
    let base = '';
    for (let j = i + 1; j < flat.length; j++) {
      const l = flat[j];
      if (lastV - l.v > 16) break;
      const cs = within(cellsOf(l.segs.filter((s) => !used.has(s))));
      if (cs.length < 2 || !isRowKey(cs[0].text) || !cs.slice(1).some((c) => isNumCell(c.text))) continue;
      rowSegs.push(...cs.map((c) => c.seg));
      lastV = l.v;
      let key = cs[0].text;
      // длинные таблицы исполнений: «НГЭН.745421.0001-05» → «-05» после первой строки
      if (!base) base = (findDesignation(key) ?? key).replace(/-\d{1,4}$/, '');
      else if (key.startsWith(base + '-')) key = key.slice(base.length);
      rows.push([key, ...cs.slice(1).map((c) => c.text)].join(' | '));
    }
    if (!rows.length) continue;
    hs.forEach((c) => used.add(c.seg));
    rowSegs.forEach((sg) => used.add(sg));
    table.push(`Таблица: ${hs.map((c) => c.text).join(' | ')}`, ...rows);
  }

  // технические требования: абзац с заголовком или нумерованный (с «1»), выровненный по левому краю
  type Cand = { s: Seg; l: Line };
  const cand: Cand[] = flat.flatMap((l) => l.segs.filter((s) => !used.has(s) && LETTERS2.test(s.text)).map((s) => ({ s, l })));
  let best: { score: number; head: Seg | null; block: Cand[] } | null = null;
  for (let i = 0; i < cand.length; i++) {
    const first = cand[i];
    const head = TT_HEAD.test(normText(first.s.text));
    if (!head && !/^1(?:[.)]\s*|\s+)\S/.test(first.s.text)) continue;
    const block: Cand[] = head ? [] : [first];
    let prev = first;
    let left = head ? NaN : first.s.u0;
    for (let j = i + 1; j < cand.length; j++) {
      const c = cand[j];
      if (c.l === prev.l) continue;
      if (prev.l.v - c.l.v > 2.3 * Math.max(prev.s.h, c.s.h)) break; // строки отсортированы сверху вниз
      if (Number.isNaN(left)) {
        if (c.s.u0 < first.s.u0 - 80 || c.s.u0 > first.s.u1) continue; // первый пункт — под заголовком
        left = c.s.u0;
      }
      if (Math.abs(c.s.u0 - left) > 4) continue;
      block.push(c);
      prev = c;
    }
    if (!block.length) continue;
    const chars = block.reduce((a, c) => a + c.s.text.length, 0);
    const score = (head ? 100 : 50) + chars / 10;
    if (!best || score > best.score) best = { score, head: head ? first.s : null, block };
  }
  const tt: string[] = [];
  if (best) {
    if (best.head) used.add(best.head);
    const left = best.block[0].s.u0;
    for (const { l } of best.block) {
      // вся строка правее левого края блока (хвосты вроде «IT14/2» бывают отдельной ячейкой)
      const parts = l.segs.filter((s) => s.u0 >= left - 1 && s.u0 <= left + 210 && !used.has(s));
      parts.forEach((s) => used.add(s));
      const text = parts.map((s) => s.text).join(' ');
      if (ITEM.test(text) || !tt.length) tt.push(text);
      else tt[tt.length - 1] += ' ' + text;
    }
  }

  // остальные надписи: выноски «Ø10,5 / 4 отв.», «27×45° / 6 фасок», примечания на поле
  const rest = lines.flatMap((l) => l.segs.filter((s) => !used.has(s)));
  const noise = rest.filter((s) => isNoise(s.text));
  const notes: string[] = [];
  for (const s of rest) {
    if (isNoise(s.text) || isTitleLabel(s.text)) continue;
    if (dKey && keyDesig(findDesignation(s.text) ?? s.text) === dKey) continue; // обозначение над видом — как в штампе
    let text = s.text;
    if (text.length <= 30) {
      const above = noise.find((n) => !used.has(n) && n.rot === s.rot && Math.abs(n.u0 - s.u0) <= Math.max(3, 0.5 * s.h) && n.v > s.v && n.v - s.v <= 2.2 * s.h);
      if (above) {
        used.add(above);
        text = `${above.text} ${text}`;
      }
    }
    used.add(s);
    if (!notes.includes(text)) notes.push(text);
  }
  return { tt, title, table, notes };
}

/** Строки текста чертежа: технические требования, штамп, надписи на поле, таблица исполнений */
export function pdfTextLines(pages: PdfPageData[]): string[] {
  const parts = pages.map(pageText);
  const out: string[] = [];
  const tt = [...new Set(parts.flatMap((p) => p.tt))];
  if (tt.length) out.push('Технические требования:', ...tt);
  const title = parts.find((p) => p.title)?.title;
  if (title) out.push(title);
  parts.forEach((p, i) => {
    if (p.notes.length) out.push(`${i ? `Лист ${pages[i].index + 1}, надписи` : 'Надписи'}: ${p.notes.join('; ')}`);
  });
  const seen = new Set<string>();
  for (const p of parts) {
    for (const l of p.table) {
      if (seen.has(l)) continue;
      seen.add(l);
      out.push(l);
    }
  }
  return out;
}

/** Текст чертежа для ИИ (обрезан до AI_LIMITS.drawingTextChars) */
export function drawingTextFromPdf(pages: PdfPageData[], max: number = AI_LIMITS.drawingTextChars): string {
  return clipText(pdfTextLines(pages).join('\n'), max);
}

/** Листы без чертежа (заявка, спецификация, счёт): весь текст по строкам, ячейки через « | » */
export function documentLines(pages: PdfPageData[]): string[] {
  const out: string[] = [];
  for (const page of pages) {
    const W = page.width;
    const frags = fragsOf(page, (t) => {
      const r = rotBucket(t.angle);
      if (r === 180) return false;
      return !(W > 200 && t.x < 22 && r !== 0 && MARGIN_LABEL.test(normText(t.str)));
    });
    const lines = linesOf(frags).map((l) => l.segs.map((s) => s.text).join(' | ')).filter((s) => s.trim());
    if (!lines.length) continue;
    if (pages.length > 1) out.push(`[стр. ${page.index + 1}]`);
    out.push(...lines);
  }
  return out;
}

/** Текст документа для ИИ (обрезан до AI_LIMITS.documentChars) */
export function documentTextFromPdf(pages: PdfPageData[], max: number = AI_LIMITS.documentChars): string {
  return clipText(documentLines(pages).join('\n'), max);
}

// ---------- DXF ----------

/** Убирает коды форматирования MTEXT (\P \f…; \H…; {} \U+XXXX …) и %%-коды AutoCAD */
export function cleanMtext(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) {
      const c = s[i + 1];
      if (c === 'P' || c === 'N' || c === 'X') {
        out += '\n';
        i++;
      } else if (c === '~') {
        out += ' ';
        i++;
      } else if (c === '\\' || c === '{' || c === '}') {
        out += c;
        i++;
      } else if ('LlOoKk'.includes(c)) i++;
      else if ((c === 'U' || c === 'u') && s[i + 2] === '+' && /^[0-9a-fA-F]{4}/.test(s.slice(i + 3, i + 7))) {
        out += String.fromCodePoint(parseInt(s.slice(i + 3, i + 7), 16));
        i += 6;
      } else if ((c === 'M' || c === 'm') && s[i + 2] === '+' && /^\d[0-9a-fA-F]{4}/.test(s.slice(i + 3, i + 8))) {
        out += '?'; // двухбайтовые восточные кодировки — не наш случай
        i += 7;
      } else if (c === 'S') {
        const end = s.indexOf(';', i);
        const body = end > 0 ? s.slice(i + 2, end) : s.slice(i + 2);
        out += body.replace(/[\^#]/, '/');
        i = end > 0 ? end : s.length;
      } else if ('fFHhWwQqTtAaCcp'.includes(c)) {
        const end = s.indexOf(';', i);
        if (end > 0) i = end;
        else i++;
      } else {
        out += c;
        i++;
      }
      continue;
    }
    if (ch === '{' || ch === '}') continue;
    out += ch;
  }
  out = out.replace(/%%(\d{3}|[cdpuokCDPUOK%])/g, (_, c: string) => {
    if (/^\d{3}$/.test(c)) return String.fromCharCode(parseInt(c, 10));
    const k = c.toLowerCase();
    return k === 'c' ? 'Ø' : k === 'd' ? '°' : k === 'p' ? '±' : k === '%' ? '%' : '';
  });
  return out
    .split('\n')
    .map((l) => l.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/** Текст DXF для ИИ: надписи без размерных чисел и подписей граф; «Масса»/«Масштаб» со значением */
export function dxfTextLines(labels: DxfLabel[]): string[] {
  const items = labels
    .map((l) => ({ x: l.x, y: l.y, text: cleanMtext(l.str) }))
    .filter((l) => l.text);
  const used = new Set<(typeof items)[number]>();
  const fields: string[] = [];
  for (const lab of items) {
    const n = normText(lab.text);
    const field = /^МАССА$/.test(n) ? 'Масса' : /^МАСШТАБ$/.test(n) ? 'Масштаб' : null;
    if (!field) continue;
    used.add(lab);
    const val = items
      .filter((t) => t !== lab && !used.has(t) && Math.abs(t.x - lab.x) <= 12 && lab.y - t.y >= 2 && lab.y - t.y <= 14)
      .filter((t) => (field === 'Масса' ? /^(\d+(?:[.,]\d+)?|см\.?\s*табл\.?)$/i.test(t.text) : /^\d+(?:[.,]\d+)?\s*:\s*\d+(?:[.,]\d+)?$/.test(t.text)))
      .sort((a, b) => lab.y - a.y - (lab.y - b.y))[0];
    if (val) {
      used.add(val);
      fields.push(`${field} ${val.text}`);
    }
  }
  const rest = items.filter((t) => !used.has(t) && !isTitleLabel(t.text) && !MARGIN_LABEL.test(normText(t.text)));
  // строки: по высоте сверху вниз, в строке — слева направо
  rest.sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: { y: number; parts: { x: number; text: string }[] }[] = [];
  for (const t of rest) {
    const r = rows.find((x) => Math.abs(x.y - t.y) <= 1.5);
    if (r) r.parts.push(t);
    else rows.push({ y: t.y, parts: [t] });
  }
  const tt: string[] = [];
  const other: string[] = [];
  for (const r of rows) {
    r.parts.sort((a, b) => a.x - b.x);
    for (const p of r.parts) {
      for (const line of p.text.split('\n')) {
        if (isNoise(line) || isTitleLabel(line)) continue;
        const target = TT_HEAD.test(normText(line)) || (ITEM.test(line) && line.split(' ').length >= 3) ? tt : other;
        if (!tt.includes(line) && !other.includes(line)) target.push(line);
      }
    }
  }
  // многострочный MTEXT уже разбит на строки; пункт ТТ без номера — продолжение предыдущего не склеиваем
  return [...tt, ...other, ...fields];
}

/** Текст DXF для ИИ (обрезан до AI_LIMITS.drawingTextChars) */
export function dxfText(labels: DxfLabel[], max: number = AI_LIMITS.drawingTextChars): string {
  return clipText(dxfTextLines(labels).join('\n'), max);
}

/** Текст позиции из PDF и DXF одной детали: PDF первым, строки DXF без повторов */
export function mergeDrawingTexts(pdf?: string, dxf?: string, max: number = AI_LIMITS.drawingTextChars): string | undefined {
  const a = pdf?.trim();
  const b = dxf?.trim();
  if (!a) return b || undefined;
  if (!b) return a;
  const have = new Set(a.split('\n').map((l) => normText(l)));
  const extra = b.split('\n').filter((l) => !have.has(normText(l)) && !a.includes(l));
  return extra.length ? clipText(`${a}\nТекст DXF: ${extra.join('; ')}`, max) : a;
}
