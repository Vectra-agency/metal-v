// Распознавание детали на векторном PDF-чертеже (ЕСКД):
// 1) штамп: обозначение, материал, толщина, масса, масштаб листа;
// 2) замкнутые контуры по каждой толщине линий, без рамки, штампа и таблиц;
// 3) выбор вида-развёртки и масштаба: метка «(1:N)», совпадение с размерами
//    на чертеже, совпадение массы со штампом, штраф за изометрию;
// 4) таблица исполнений (L, A, B… и масса) — размеры подставляются по обозначению;
// 5) линии гиба — штриховые тонкие линии поперёк развёртки.

import type { Prim, Vec } from './dxf.ts';
import { analyze, boxOf, inside, signedArea, type Box, type Loop, type PartGeom } from './geometry.ts';
import { getMaterial, kgPerM2 } from './materials.ts';
import type { PdfPageData, PdfText } from './pdf.ts';

export const STD_SCALES = [1, 2, 2.5, 4, 5, 10, 15, 20, 25, 40, 50, 75, 100, 0.5, 0.4, 0.25, 0.2, 0.1];

// ---------- текст ----------

const LAT2CYR: Record<string, string> = {
  A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х', Y: 'У',
  a: 'а', c: 'с', e: 'е', o: 'о', p: 'р', x: 'х', y: 'у',
};
/** латиница-двойники → кириллица, пробелы схлопнуты, верхний регистр */
export const normText = (s: string) =>
  s
    .replace(/[A-Za-z]/g, (ch) => LAT2CYR[ch] ?? ch)
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();

const num = (s: string) => parseFloat(s.replace(',', '.'));

export function parseScale(str: string): number | null {
  const m = /^\(?\s*(\d+(?:[.,]\d+)?)\s*:\s*(\d+(?:[.,]\d+)?)\s*\)?$/.exec(str.trim());
  if (!m) return null;
  const a = num(m[1]);
  const b = num(m[2]);
  return a > 0 && b > 0 ? b / a : null;
}

/** обозначение вида «НГЭН.745421.0001-17», «БВС-305Х300.000» */
export function findDesignation(s: string): string | null {
  const m = /[A-Za-zА-Яа-яЁё]{1,10}[.\-]?[\dA-Za-zА-Яа-я]*\d[\dA-Za-zА-Яа-я]*(?:[.\-][\dA-Za-zА-Яа-я]+)+/.exec(s);
  return m ? m[0] : null;
}
export const keyDesig = (s: string) => normText(s).replace(/\s/g, '');

// ---------- штамп ----------

export interface TitleInfo {
  designation?: string;
  materialId?: string;
  materialText?: string;
  thickness?: number;
  mass?: number;
  massInTable: boolean;
  sheetScale?: number;
}

const TITLE_WORDS = /^(МАССА|МАСШТАБ|ЛИТ\.?|ЛИСТОВ|РАЗРАБ\.?|ПРОВ\.?|Т\. ?КОНТР\.?|Н\. ?КОНТР\.?|УТВ\.?|ИЗМ\.?|ИЗМ\. ЛИСТ|№ ?ДОКУМ\.?|ПОДП\.?|ДАТА|ПОДПИСЬ)$/;

function isGostSize(w: number, h: number) {
  const [s, l] = w < h ? [w, h] : [h, w];
  return [[210, 297], [297, 420], [420, 594], [594, 841], [841, 1189], [297, 630], [297, 841]].some(([a, b]) => Math.abs(s - a) < 3 && Math.abs(l - b) < 3);
}

export function titleRegion(page: PdfPageData): Box | null {
  const hits = page.texts.filter((t) => Math.abs(t.angle) < 5 && TITLE_WORDS.test(normText(t.str)));
  if (hits.length >= 3) {
    const b = boxOf(hits.map((t) => ({ x: t.x, y: t.y })));
    // штамп всегда в правом нижнем углу; верх — строка с обозначением над «Массой»
    return { minX: b.minX - 8, minY: -1, maxX: page.width + 1, maxY: Math.max(b.maxY + 16, 61) };
  }
  if (isGostSize(page.width, page.height)) return { minX: page.width - 192, minY: -1, maxX: page.width + 1, maxY: 61 };
  return null;
}

const inBox = (p: Vec, b: Box | null) => !!b && p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY;

/** Ближайший текст в ячейке под подписью (по центру колонки) */
function cellBelow(texts: PdfText[], label: PdfText): PdfText | null {
  const cx = label.x + label.w / 2;
  let best: PdfText | null = null;
  for (const t of texts) {
    if (t === label) continue;
    const dy = label.y - t.y;
    if (dy < 1.5 || dy > 16) continue;
    if (Math.abs(t.x + t.w / 2 - cx) > Math.max(9, label.w)) continue;
    if (!best || label.y - best.y > dy) best = t;
  }
  return best;
}

function valueBelow(texts: PdfText[], label: PdfText, re: RegExp): PdfText | null {
  const c = cellBelow(texts, label);
  return c && re.test(c.str.trim()) ? c : null;
}

export function detectMaterial(texts: PdfText[]): { materialId?: string; materialText?: string; thickness?: number } {
  const raw = texts.map((t) => t.str).join(' | ');
  const n = normText(raw);
  let thickness: number | undefined;
  for (const t of texts) {
    const s = normText(t.str);
    let m = /К-П[УВ]-(\d+(?:[.,]\d+)?)/.exec(s);
    if (!m) m = /^(?:ЛИСТ\s+)?(\d+(?:[.,]\d+)?)\s*(?:ГОСТ|ТУ|ОСТ)(?=[\s\d]|$)/.exec(s);
    if (!m) m = /П[НВ]-[А-Я]{1,3}-(\d+(?:[.,]\d+)?)/.exec(s);
    if (m && num(m[1]) > 0 && num(m[1]) <= 60) {
      thickness = num(m[1]);
      break;
    }
  }
  if (thickness == null) {
    const s = texts.find((t) => /^[sS]\s?\d+(?:[.,]\d+)?\s*\*?$/.test(t.str.trim()));
    if (s) thickness = num(s.str.replace(/[^\d.,]/g, ''));
  }
  const cold = /19904|Х\/К|ХОЛОДНОКАТ/.test(n);
  const riffled = /К-П[УВ]|РОМБ|ЧЕЧЕВИЦ|РИФЛ/.test(n);
  let materialId: string | undefined;
  let materialText: string | undefined;
  const pick = (id: string, txt: string) => {
    materialId = id;
    materialText = txt;
  };
  if (/AISI\s*321|12Х18Н10Т|08Х18Н10Т/.test(raw) || /12Х18Н10Т|08Х18Н10Т/.test(n)) pick('aisi321', '12Х18Н10Т');
  else if (/AISI\s*304/.test(raw) || /08Х18Н10(?!Т)/.test(n)) pick('aisi304', 'AISI 304');
  else if (/AISI\s*430/.test(raw) || /08Х17/.test(n)) pick('aisi430', 'AISI 430');
  else if (/АМГ\s?5/.test(n)) pick('amg5', 'АМг5');
  else if (/АМГ\s?2/.test(n)) pick(/РИФЛ|КВИНТЕТ/.test(n) ? 'amg2r' : 'amg2', 'АМг2');
  else if (/09Г2С/.test(n)) pick('09g2s', '09Г2С');
  else if (/ОЦИНК|14918|DX51/.test(n)) pick('ocink', 'оцинкованная');
  else if (riffled) pick('rifl', 'рифлёный лист');
  else if (/(^|[^\d])08 ?(ПС|КП|Ю)/.test(n)) pick('08ps', '08пс');
  else if (/СТ ?3/.test(n)) pick(cold ? '08ps' : 'st3', cold ? 'Ст3, лист х/к (ГОСТ 19904) → 08пс х/к' : 'Ст3');
  return { materialId, materialText, thickness };
}

export function readTitle(page: PdfPageData, region: Box | null): TitleInfo {
  const texts = page.texts;
  const inTitle = texts.filter((t) => inBox(t, region));
  const label = (re: RegExp) => inTitle.find((t) => re.test(normText(t.str)));
  const info: TitleInfo = { massInTable: false };

  const massLbl = label(/^МАССА/);
  if (massLbl) {
    const c = cellBelow(texts, massLbl);
    if (c && /^\d+(?:[.,]\d+)?$/.test(c.str.trim())) info.mass = num(c.str);
    else if (c && /см\.?\s*табл/i.test(c.str)) info.massInTable = true;
  }
  const scLbl = label(/^МАСШТАБ/);
  const scText = (scLbl && valueBelow(texts, scLbl, /^\d+(?:[.,]\d+)?\s*:\s*\d+(?:[.,]\d+)?$/)) || inTitle.find((t) => parseScale(t.str) && !t.str.includes('('));
  if (scText) info.sheetScale = parseScale(scText.str) ?? undefined;

  // обозначение — самый крупный «номерной» текст штампа
  const desig = inTitle
    .filter((t) => Math.abs(t.angle) < 5 && /\d/.test(t.str) && t.str.length >= 5 && !/ГОСТ|ТУ |ТУ$|^\d+([.,]\d+)?$|^\d\d\.\d\d\.\d{2,4}$|:/i.test(t.str) && findDesignation(t.str))
    .sort((a, b) => b.h - a.h || b.str.length - a.str.length)[0];
  if (desig) info.designation = findDesignation(desig.str) ?? desig.str;

  // материал и толщина: сначала из штампа, недостающее — со всего листа
  const fromTitle = detectMaterial(inTitle);
  const fromPage = detectMaterial(texts);
  info.materialId = fromTitle.materialId ?? fromPage.materialId;
  info.materialText = fromTitle.materialText ?? fromPage.materialText;
  info.thickness = fromTitle.thickness ?? fromPage.thickness;
  return info;
}

// ---------- таблица исполнений ----------

export interface VariantTable {
  cols: { key: string; label: string }[];
  rows: { designation: string; values: Record<string, number> }[];
}

export function readTables(page: PdfPageData, baseDesig?: string): VariantTable | null {
  const texts = page.texts.filter((t) => Math.abs(t.angle) < 5);
  const headers = texts.filter((t) => /^ОБОЗНАЧЕНИЕ$/.test(normText(t.str)));
  const cols = new Map<string, string>();
  const rows: VariantTable['rows'] = [];
  for (const H of headers) {
    const band = texts.filter((t) => t !== H && Math.abs(t.y - H.y) < 3 && t.x > H.x);
    const hc = band
      .map((t) => {
        const s = normText(t.str);
        let key = '';
        if (/^МАССА/.test(s)) key = 'mass';
        else {
          const m = /^([A-ZА-Я])\s*\*?\s*(,|$)/.exec(t.str.trim().toUpperCase());
          if (m) key = m[1].replace(/[А-Я]/g, (ch) => ({ А: 'A', В: 'B', С: 'C', Е: 'E', Н: 'H', К: 'K', М: 'M', О: 'O', Р: 'P', Т: 'T', Х: 'X' } as Record<string, string>)[ch] ?? ch);
        }
        return { key, label: t.str, cx: t.x + t.w / 2 };
      })
      .filter((c) => c.key);
    if (!hc.length) continue;
    for (const c of hc) cols.set(c.key, c.label);
    // строки: обозначения под заголовком в той же колонке
    const cand = texts
      .filter((t) => t.y < H.y - 2 && Math.abs(t.x - H.x) < 30 && /\d/.test(t.str) && (findDesignation(t.str) || /^-\d/.test(t.str.trim())))
      .sort((a, b) => b.y - a.y);
    let lastY = H.y;
    for (const r of cand) {
      if (lastY - r.y > 16) break;
      lastY = r.y;
      let d = r.str.trim();
      if (/^-\d/.test(d) && baseDesig) d = baseDesig + d;
      d = findDesignation(d) ?? d;
      const values: Record<string, number> = {};
      for (const c of hc) {
        const v = texts.find((t) => Math.abs(t.y - r.y) < 2.5 && Math.abs(t.x + t.w / 2 - c.cx) < 16 && /^\d+(?:[.,]\d+)?\s*°?$/.test(t.str.trim()));
        if (v) values[c.key] = num(v.str);
      }
      if (Object.keys(values).length && !rows.some((x) => keyDesig(x.designation) === keyDesig(d))) rows.push({ designation: d, values });
    }
  }
  if (!rows.length) return null;
  return { cols: [...cols.entries()].map(([key, label]) => ({ key, label })), rows };
}

export function findRow(table: VariantTable | null, designation?: string): number {
  if (!table || !designation) return -1;
  const k = keyDesig(designation);
  return table.rows.findIndex((r) => keyDesig(r.designation) === k);
}

// ---------- кандидаты-виды ----------

export interface Candidate {
  page: number;
  width: number; // класс толщины линии, мм
  part: PartGeom; // в мм листа
  area: number; // площадь металла на листе, мм²
  bbox: Box;
  isoFrac: number; // доля контура под углами изометрии
  label: { scale: number; text: string } | null; // метка вида «(1:5)» над видом
  edges: number[]; // длины прямых рёбер контура, мм листа
  bridged: boolean; // контур замкнут через обрыв вида
  brk: BreakInfo | null; // обрыв: где он и какие точки контура лежат за ним
}

export interface BreakInfo {
  axis: 'x' | 'y'; // вдоль какой оси вид укорочен
  at: number; // координата обрыва на листе, мм
  shift: number[]; // индексы точек наружного контура за обрывом
  target?: number | null; // настоящий габарит по этой оси, мм (из размеров на чертеже)
}

const nearV = (a: Vec, b: Vec) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;

/** Делит контур, замкнутый двумя «мостиками», на две части; дальняя сдвигается при удлинении */
function breakSplit(outer: Vec[], bridges: Prim[]): BreakInfo | null {
  const n = outer.length;
  const cuts: { i: number; axis: 'x' | 'y'; mid: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = outer[i];
    const b = outer[(i + 1) % n];
    const hit = bridges.some((p) => (nearV(p.pts[0], a) && nearV(p.pts[1], b)) || (nearV(p.pts[0], b) && nearV(p.pts[1], a)));
    if (!hit) continue;
    const dx = Math.abs(b.x - a.x);
    const dy = Math.abs(b.y - a.y);
    cuts.push({ i, axis: dx >= dy ? 'x' : 'y', mid: dx >= dy ? (a.x + b.x) / 2 : (a.y + b.y) / 2 });
  }
  if (cuts.length !== 2 || cuts[0].axis !== cuts[1].axis) return null;
  const axis = cuts[0].axis;
  const arc1: number[] = [];
  for (let k = cuts[0].i + 1; k <= cuts[1].i; k++) arc1.push(k);
  const in1 = new Set(arc1);
  const arc2 = [...Array(n).keys()].filter((k) => !in1.has(k));
  const mean = (arr: number[]) => arr.reduce((acc, k) => acc + (axis === 'x' ? outer[k].x : outer[k].y), 0) / Math.max(arr.length, 1);
  return { axis, at: (cuts[0].mid + cuts[1].mid) / 2, shift: mean(arc1) > mean(arc2) ? arc1 : arc2 };
}

function polyLength(pts: Vec[], closed: boolean) {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  if (closed && pts.length > 2) l += Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y);
  return l;
}

function edgesOf(pts: Vec[]): { len: number; ang: number }[] {
  const out: { len: number; ang: number }[] = [];
  const n = pts.length;
  let cur: { len: number; ang: number } | null = null;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-6) continue;
    const ang = ((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI + 360) % 180;
    if (cur && Math.min(Math.abs(cur.ang - ang), 180 - Math.abs(cur.ang - ang)) < 1) cur.len += len;
    else {
      if (cur) out.push(cur);
      cur = { len, ang };
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Пары ближайших свободных концов (до 9 мм) → соединительные отрезки */
function bridgeGaps(chains: Vec[][]): Prim[] {
  const ends: { p: Vec; c: number }[] = [];
  chains.forEach((pts, c) => {
    if (pts.length < 2) return;
    ends.push({ p: pts[0], c }, { p: pts[pts.length - 1], c });
  });
  const nearest = (i: number) => {
    let best = -1;
    let bd = 9;
    for (let j = 0; j < ends.length; j++) {
      if (j === i || ends[j].c === ends[i].c) continue;
      const d = Math.hypot(ends[j].p.x - ends[i].p.x, ends[j].p.y - ends[i].p.y);
      if (d > 0.05 && d < bd) {
        bd = d;
        best = j;
      }
    }
    return best;
  };
  const out: Prim[] = [];
  const used = new Set<number>();
  for (let i = 0; i < ends.length; i++) {
    if (used.has(i)) continue;
    const j = nearest(i);
    if (j < 0 || used.has(j) || nearest(j) !== i) continue; // только взаимно ближайшие
    used.add(i);
    used.add(j);
    const a = ends[i].p;
    const b = ends[j].p;
    out.push({ pts: [a, b], length: Math.hypot(b.x - a.x, b.y - a.y), closed: false, kind: 'BRIDGE', layer: 'bridge', dashed: false });
  }
  return out;
}

/** Замкнутая кривая с густой тонкой штриховкой внутри — условное обозначение материала */
function isHatchSymbol(page: PdfPageData, h: Loop, cls: number): boolean {
  let n = 0;
  for (const p of page.paths) {
    if (Math.abs(p.width - cls) < 0.01) continue;
    const m = p.pts[Math.floor(p.pts.length / 2)];
    if (m.x < h.bbox.minX || m.x > h.bbox.maxX || m.y < h.bbox.minY || m.y > h.bbox.maxY) continue;
    if (inside(m, h.pts) && ++n >= 8) return true;
  }
  return false;
}

function classesOf(page: PdfPageData): number[] {
  const ws = [...new Set(page.paths.map((p) => Math.round(p.width * 100) / 100))].sort((a, b) => a - b);
  // близкие толщины (±12%) — один класс
  const out: number[] = [];
  for (const w of ws) if (!out.length || w > out[out.length - 1] * 1.12 + 0.005) out.push(w);
  return out;
}
const classOf = (w: number, classes: number[]) => classes.reduce((best, c) => (Math.abs(c - w) < Math.abs(best - w) ? c : best), classes[0]);

export function findCandidates(page: PdfPageData, region: Box | null): Candidate[] {
  const classes = classesOf(page);
  const W = page.width;
  const H = page.height;
  const labels = page.texts
    .map((t) => {
      const m = /\(\s*(\d+(?:[.,]\d+)?\s*:\s*\d+(?:[.,]\d+)?)\s*\)/.exec(t.str);
      return m ? { scale: parseScale(m[1])!, text: t.str, x: t.x, y: t.y } : null;
    })
    .filter((x): x is { scale: number; text: string; x: number; y: number } => !!x && !!x.scale);

  const out: Candidate[] = [];
  for (const cls of classes) {
    const prims: Prim[] = [];
    let total = 0;
    for (const p of page.paths) {
      if (classOf(Math.round(p.width * 100) / 100, classes) !== cls) continue;
      if (p.pts.every((v) => inBox(v, region))) continue;
      prims.push({ pts: p.pts, length: p.length, closed: p.closed, kind: 'PDF', layer: String(cls), dashed: false });
      total += p.length;
    }
    if (total < 30 || !prims.length) continue;
    const textCenter = (t: PdfText) => ({ x: t.x + (t.w / 2) * Math.cos((t.angle * Math.PI) / 180), y: t.y + (t.w / 2) * Math.sin((t.angle * Math.PI) / 180) });
    const filter = (l: Loop): 'frame' | 'drop' | null => {
          const bw = l.bbox.maxX - l.bbox.minX;
          const bh = l.bbox.maxY - l.bbox.minY;
          if (bw > 0.55 * W && bh > 0.55 * H) return 'frame';
          const c = { x: (l.bbox.minX + l.bbox.maxX) / 2, y: (l.bbox.minY + l.bbox.maxY) / 2 };
          if (inBox(c, region)) return 'drop';
          if (W > 200 && c.x < 20) return 'drop'; // графы на левом поле
          const inner = page.texts.filter((t) => {
            const tc = textCenter(t);
            return tc.x > l.bbox.minX && tc.x < l.bbox.maxX && tc.y > l.bbox.minY && tc.y < l.bbox.maxY && inside(tc, l.pts);
          });
          const fill = l.area / Math.max(bw * bh, 1e-9);
          if (inner.some((t) => Math.abs(Math.abs(t.angle) - 180) < 5) && fill > 0.9) return 'drop'; // перевёрнутое обозначение в углу
          if (inner.length >= 3 && fill > 0.9) return 'drop'; // таблица
          return null;
    };
    const an = analyze({ prims, texts: [], version: 'pdf', insUnits: 4, warnings: [] }, { loopFilter: filter });
    // вид с обрывом: соединяем ближайшие свободные концы разомкнутых линий
    const bridges = bridgeGaps(an.stray.map((o) => o.pts));
    let parts = an.parts.map((p) => ({ p, bridged: false, brk: null as BreakInfo | null }));
    if (bridges.length) {
      const an2 = analyze({ prims: [...prims, ...bridges], texts: [], version: 'pdf', insUnits: 4, warnings: [] }, { loopFilter: filter });
      const before = new Set(an.parts.map((p) => `${p.outer.bbox.minX.toFixed(1)},${p.outer.bbox.minY.toFixed(1)},${p.outer.area.toFixed(0)}`));
      parts = an2.parts.map((p) => {
        const bridged = !before.has(`${p.outer.bbox.minX.toFixed(1)},${p.outer.bbox.minY.toFixed(1)},${p.outer.area.toFixed(0)}`);
        return { p, bridged, brk: bridged ? breakSplit(p.outer.pts, bridges) : null };
      });
    }
    for (const { p: part, bridged, brk } of parts) {
      // значок материала со штриховкой внутри — не отверстие
      part.holes = part.holes.filter((h) => !isHatchSymbol(page, h, cls));
      const b = part.outer.bbox;
      const bw = b.maxX - b.minX;
      const bh = b.maxY - b.minY;
      if (Math.hypot(bw, bh) < 8 || Math.min(bw, bh) < 1.5) continue;
      const edges = edgesOf(part.outer.pts);
      const per = edges.reduce((a, e) => a + e.len, 0) || 1;
      const iso = edges.filter((e) => Math.min(Math.abs(e.ang - 30), Math.abs(e.ang - 150)) < 4).reduce((a, e) => a + e.len, 0) / per;
      // метка вида: над видом (до 45 мм) и в пределах его ширины
      const lab = labels
        .filter((l) => l.y > b.maxY - 4 && l.y < b.maxY + 45 && l.x > b.minX - 35 && l.x < b.maxX + 10)
        .sort((p, q) => p.y - q.y)[0];
      out.push({
        page: page.index,
        width: cls,
        part,
        area: part.outer.area - part.holes.reduce((a, h) => a + h.area, 0),
        bbox: b,
        isoFrac: iso,
        label: lab ? { scale: lab.scale, text: lab.text } : null,
        edges: edges.filter((e) => e.len > 3).map((e) => e.len),
        bridged,
        brk,
      });
    }
  }
  return out;
}

// ---------- выбор вида и масштаба ----------

export interface Pick {
  cand: number;
  scale: number;
  score: number;
  why: string[];
}

function dimNumbers(page: PdfPageData): number[] {
  const out: number[] = [];
  for (const t of page.texts) {
    const s = t.str.trim();
    const m = /^[ØÇ⌀R]?\s*(\d+(?:[.,]\d+)?)\s*\*?$/.exec(s);
    if (m) {
      const v = num(m[1]);
      if (v >= 5) out.push(v);
    }
  }
  return out;
}

const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.6, 0.006 * b);

/** Масса вида при масштабе s; несколько вариантов плотности — в чертежах её часто считают как для стали */
function massVariants(areaPaper: number, s: number, materialId: string | undefined, t: number | undefined): number[] {
  if (!t) return [];
  const m = getMaterial(materialId ?? 'st3');
  const a = (areaPaper * s * s) / 1e6;
  return [a * kgPerM2(m, t), a * ((m.density * t) / 1000), a * 7.85 * t];
}

export function choose(cands: Candidate[], pages: PdfPageData[], title: TitleInfo, expectMass?: number): Pick | null {
  if (!cands.length) return null;
  const maxArea = Math.max(...cands.map((c) => c.area));
  const dimsByPage = new Map(pages.map((p) => [p.index, dimNumbers(p)]));
  let best: Pick | null = null;
  cands.forEach((c, i) => {
    const dims = dimsByPage.get(c.page) ?? [];
    const scales = new Set<number>(STD_SCALES);
    if (c.label) scales.add(c.label.scale);
    if (title.sheetScale) scales.add(title.sheetScale);
    for (const s of scales) {
      const why: string[] = [];
      let score = 3 * (c.area / maxArea);
      if (c.isoFrac > 0.25) {
        score -= 8;
        why.push('изометрия');
      }
      if (c.bridged) {
        score -= 1;
        why.push('вид с обрывом');
      }
      if (c.label) {
        score += 3;
        if (c.label.scale === s) {
          score += 3;
          why.push(`метка вида ${c.label.text.trim()}`);
        }
      }
      if (title.sheetScale === s) {
        score += 1.5;
        if (!c.label) why.push(`масштаб листа 1:${s}`);
      }
      const w = (c.bbox.maxX - c.bbox.minX) * s;
      const h = (c.bbox.maxY - c.bbox.minY) * s;
      const used = new Set<number>();
      let mwh = 0;
      for (const target of [w, h]) {
        const k = dims.findIndex((d, j) => !used.has(j) && close(target, d));
        if (k >= 0) {
          used.add(k);
          mwh++;
        }
      }
      let me = 0;
      for (const e of c.edges) {
        const k = dims.findIndex((d, j) => !used.has(j) && close(e * s, d));
        if (k >= 0) {
          used.add(k);
          me++;
        }
      }
      score += 3 * mwh + Math.min(4, me);
      if (mwh + me > 0) why.push(`размеров совпало: ${mwh + me}`);
      const M = expectMass ?? title.mass;
      if (M) {
        const r = Math.min(...massVariants(c.area, s, title.materialId, title.thickness).map((m) => Math.abs(Math.log(m / M))));
        const cl = 1 - r / Math.log(1.12);
        if (cl > 0) {
          score += 10 * cl;
          why.push('масса совпала');
        }
      }
      if (!best || score > best.score) best = { cand: i, scale: s, score, why };
    }
  });
  return best;
}

// ---------- линии гиба ----------

/** Интервал [lo, hi] (параметр t вдоль u от точки m) внутри многоугольника */
function chordRange(poly: Vec[], m: Vec, u: Vec): [number, number] | null {
  let lo = -Infinity;
  let hi = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const den = u.x * ey - u.y * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((a.x - m.x) * ey - (a.y - m.y) * ex) / den;
    const sp = ((a.x - m.x) * u.y - (a.y - m.y) * u.x) / den;
    if (sp < -1e-9 || sp > 1 + 1e-9) continue;
    if (t <= 0 && t > lo) lo = t;
    if (t > 0 && t < hi) hi = t;
  }
  return Number.isFinite(lo) && Number.isFinite(hi) ? [lo, hi] : null;
}

/** Линии гиба на развёртке (в мм листа). По ЕСКД — штрихпунктир с двумя точками.
 *  Если таких на виде нет, конструктор рисовал гибы штрихпунктиром/штрихами —
 *  тогда берём такие линии, пересекающие деталь от края до края.
 *  Линии обрезаются по контуру (на чертеже их часто выводят за деталь). */
export function findBendLines(page: PdfPageData, cand: Candidate): Vec[][] {
  const outer = cand.part.outer.pts;
  const holes = cand.part.holes.map((h) => h.pts);
  const b = cand.bbox;
  const M = 8; // смотрим и чуть за контур — там продолжения штрихов
  const groups = new Map<string, { th: number; rho: number; items: { t0: number; t1: number }[] }>();
  for (const p of page.paths) {
    if (Math.abs(p.width - cand.width) < 0.01) continue; // сам контур
    for (let i = 1; i < p.pts.length; i++) {
      const a = p.pts[i - 1];
      const c = p.pts[i];
      const len = Math.hypot(c.x - a.x, c.y - a.y);
      if (len < 0.2) continue;
      const m = { x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 };
      if (m.x < b.minX - M || m.x > b.maxX + M || m.y < b.minY - M || m.y > b.maxY + M) continue;
      let th = Math.atan2(c.y - a.y, c.x - a.x);
      if (th < 0) th += Math.PI;
      if (th >= Math.PI - 1e-9) th -= Math.PI;
      const ux = Math.cos(th);
      const uy = Math.sin(th);
      const rho = a.x * -uy + a.y * ux;
      const key = `${Math.round((th * 180) / Math.PI / 0.5)}|${Math.round(rho / 0.3)}`;
      const t0 = a.x * ux + a.y * uy;
      const t1 = c.x * ux + c.y * uy;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { th, rho, items: [] }));
      g.items.push({ t0: Math.min(t0, t1), t1: Math.max(t0, t1) });
    }
  }
  const strict: Vec[][] = [];
  const loose: Vec[][] = [];
  const minSpan = Math.max(8, 0.12 * Math.min(b.maxX - b.minX, b.maxY - b.minY));
  for (const g of groups.values()) {
    g.items.sort((p, q) => p.t0 - q.t0);
    // склеиваем перекрывающиеся куски (КОМПАС рисует штрих «туда-обратно»)
    const pieces: { t0: number; t1: number }[] = [];
    for (const it of g.items) {
      const last = pieces[pieces.length - 1];
      if (last && it.t0 <= last.t1 + 0.05) last.t1 = Math.max(last.t1, it.t1);
      else pieces.push({ ...it });
    }
    // цепочки штрихов с разрывами до 5 мм
    const runs: { t0: number; t1: number; ps: { t0: number; t1: number }[] }[] = [];
    for (const pc of pieces) {
      const r = runs[runs.length - 1];
      if (r && pc.t0 - r.t1 < 5) {
        r.t1 = pc.t1;
        r.ps.push(pc);
      } else runs.push({ t0: pc.t0, t1: pc.t1, ps: [pc] });
    }
    const ux = Math.cos(g.th);
    const uy = Math.sin(g.th);
    const at = (t: number) => ({ x: -uy * g.rho + ux * t, y: ux * g.rho + uy * t });
    for (const r of runs) {
      if (r.ps.length < 3) continue; // сплошные тонкие — размерные и выносные
      // точка линии внутри детали (не в отверстии)
      let mid: Vec | null = null;
      let tm = 0;
      for (let k = 1; k < 8 && !mid; k++) {
        const t = r.t0 + ((r.t1 - r.t0) * k) / 8;
        const v = at(t);
        if (inside(v, outer) && !holes.some((h) => inside(v, h))) {
          mid = v;
          tm = t;
        }
      }
      if (!mid) continue;
      const cr = chordRange(outer, mid, { x: ux, y: uy });
      if (!cr) continue;
      const c0 = Math.max(r.t0, tm + cr[0]);
      const c1 = Math.min(r.t1, tm + cr[1]);
      const span = c1 - c0;
      if (span < minSpan) continue;
      // рисунок штриха — только по целым штрихам внутри (обрезанные по краю искажают)
      const inPs = r.ps.filter((p) => p.t0 >= c0 - 0.01 && p.t1 <= c1 + 0.01).map((p) => p.t1 - p.t0);
      if (inPs.length < 3) continue;
      const maxLen = Math.max(...inPs);
      const dots = inPs.filter((l) => l < Math.min(2.5, 0.4 * maxLen)).length;
      const dashes = inPs.length - dots;
      if (dashes < 2) continue;
      const ratio = dots / dashes;
      const line = [at(c0), at(c1)];
      if (ratio > 1.5 && ratio < 2.6) strict.push(line);
      else if (span >= 0.85 * (cr[1] - cr[0])) loose.push(line); // поперёк всей детали
    }
  }
  return strict.length ? strict : loose;
}

// ---------- сборка результата ----------

export interface PdfBase {
  outer: Vec[];
  holes: Vec[][];
  bends: Vec[][];
  bbox: Box;
}

export interface PdfMeta {
  fileName: string;
  page: number;
  pages: number;
  scale: number;
  scaleWhy: string;
  title: TitleInfo;
  table: VariantTable | null;
  row: number; // выбранное исполнение (-1 — как на чертеже)
  axes: Record<string, 'x' | 'y'>; // буквенный размер → ось вида
  base: { outer: number[]; holes: number[][]; bends: number[][]; bbox: Box; brk?: BreakInfo | null };
}

export interface PdfGeometry {
  outer: Vec[];
  holes: Vec[][];
  bends: Vec[][];
  width: number;
  height: number;
  netArea: number;
  bboxArea: number;
  cutLength: number;
  pierces: number;
  bendMax: number;
  stretched: string[];
  massDrawing: number | null;
}

const flatArr = (pts: Vec[]) => pts.flatMap((p) => [Math.round(p.x * 1000) / 1000, Math.round(p.y * 1000) / 1000]);
const unflat = (a: number[]) => {
  const out: Vec[] = [];
  for (let i = 0; i + 1 < a.length; i += 2) out.push({ x: a[i], y: a[i + 1] });
  return out;
};

export function baseOf(c: Candidate, bends: Vec[][]): PdfMeta['base'] {
  return { outer: flatArr(c.part.outer.pts), holes: c.part.holes.map((h) => flatArr(h.pts)), bends: bends.map(flatArr), bbox: c.bbox, brk: c.brk };
}

/** Буквенные размеры (L, A, C*…) у выбранного вида → по какой оси они задают габарит */
export function letterAxes(page: PdfPageData, c: Candidate, table: VariantTable | null): Record<string, 'x' | 'y'> {
  const axes: Record<string, 'x' | 'y'> = {};
  if (!table) return axes;
  const b = c.bbox;
  for (const col of table.cols) {
    if (col.key.length !== 1) continue;
    const letters = page.texts.filter((t) => normText(t.str).replace(/\*$/, '') === normText(col.key));
    let bestD = 30;
    for (const t of letters) {
      const dx = t.x < b.minX ? b.minX - t.x : t.x > b.maxX ? t.x - b.maxX : 0;
      const dy = t.y < b.minY ? b.minY - t.y : t.y > b.maxY ? t.y - b.maxY : 0;
      const d = Math.hypot(dx, dy);
      if (d < bestD) {
        bestD = d;
        axes[col.key] = Math.abs(Math.abs(t.angle) - 90) < 15 ? 'y' : 'x';
      }
    }
  }
  return axes;
}

/** Реальная геометрия: масштаб + подстановка размеров исполнения из таблицы */
export function buildGeometry(meta: PdfMeta): PdfGeometry {
  const b = meta.base.bbox;
  const s = meta.scale;
  let fx = 1;
  let fy = 1;
  const stretched: string[] = [];
  let massDrawing: number | null = meta.title.mass ?? null;
  const row = meta.table && meta.row >= 0 ? meta.table.rows[meta.row] : null;
  if (row) {
    if (row.values.mass) massDrawing = row.values.mass;
    // на каждую ось — один буквенный размер, наибольший (габаритный)
    const perAxis = new Map<'x' | 'y', string>();
    for (const [k, axis] of Object.entries(meta.axes)) {
      const v = row.values[k];
      if (!v) continue;
      const cur = perAxis.get(axis);
      if (!cur || v > (row.values[cur] ?? 0)) perAxis.set(axis, k);
    }
    for (const [axis, k] of perAxis) {
      const v = row.values[k];
      const cur = (axis === 'x' ? b.maxX - b.minX : b.maxY - b.minY) * s;
      const f = v / cur;
      if (f > 0.05 && f < 20 && Math.abs(f - 1) > 0.002) {
        if (axis === 'x' && fx === 1) fx = f;
        if (axis === 'y' && fy === 1) fy = f;
        stretched.push(`${k} = ${v} мм`);
      }
    }
  }
  // вид с обрывом: недостающую длину вставляем в месте обрыва, а не растягиваем всё
  const brk = meta.base.brk;
  let shiftD = 0;
  if (brk) {
    const extent = brk.axis === 'x' ? b.maxX - b.minX : b.maxY - b.minY;
    const f = brk.axis === 'x' ? fx : fy;
    const target = f !== 1 ? extent * s * f : brk.target ?? null;
    if (target && target > extent * s * 1.01) {
      shiftD = target / s - extent;
      if (brk.axis === 'x') fx = 1;
      else fy = 1;
      if (f === 1) stretched.push(`длина по размеру на чертеже ${Math.round(target)} мм (вид с обрывом)`);
    }
  }
  const shiftIdx = new Set(brk && shiftD ? brk.shift : []);
  const sh = (v: Vec, on: boolean): Vec => (on && brk ? (brk.axis === 'x' ? { x: v.x + shiftD, y: v.y } : { x: v.x, y: v.y + shiftD }) : v);
  const beyond = (v: Vec) => !!brk && shiftD !== 0 && (brk.axis === 'x' ? v.x : v.y) > brk.at;
  const T = (v: Vec): Vec => ({ x: (v.x - b.minX) * s * fx, y: (v.y - b.minY) * s * fy });
  const outer = unflat(meta.base.outer).map((v, i) => T(sh(v, shiftIdx.has(i))));
  const holes = meta.base.holes.map((h) => {
    const pts = unflat(h);
    const c = pts.reduce((a, v) => ({ x: a.x + v.x / pts.length, y: a.y + v.y / pts.length }), { x: 0, y: 0 });
    return pts.map((v) => T(sh(v, beyond(c))));
  });
  const bends = meta.base.bends.map((h) => unflat(h).map((v) => T(sh(v, beyond(v)))));
  const bb = boxOf(outer);
  const netArea = Math.abs(signedArea(outer)) - holes.reduce((a, h) => a + Math.abs(signedArea(h)), 0);
  const cutLength = polyLength(outer, true) + holes.reduce((a, h) => a + polyLength(h, true), 0);
  const bendLens = bends.map((l) => polyLength(l, false));
  return {
    outer,
    holes,
    bends,
    width: bb.maxX - bb.minX,
    height: bb.maxY - bb.minY,
    netArea,
    bboxArea: (bb.maxX - bb.minX) * (bb.maxY - bb.minY),
    cutLength,
    pierces: 1 + holes.length,
    bendMax: bendLens.length ? Math.max(...bendLens) : 0,
    stretched,
    massDrawing,
  };
}

// ---------- всё вместе ----------

export interface PdfAnalysis {
  meta: PdfMeta | null;
  candidates: Candidate[];
  pick: Pick | null;
  scan: boolean;
  warnings: string[];
  title?: TitleInfo;
  table?: VariantTable | null;
  row?: number;
}

export function analyzePdf(pages: PdfPageData[], fileName: string, fileDesignation?: string): PdfAnalysis {
  const warnings: string[] = [];
  const vectorPaths = pages.reduce((a, p) => a + p.paths.length, 0);
  const images = pages.reduce((a, p) => a + p.images, 0);
  if (vectorPaths < 20) {
    return {
      meta: null,
      candidates: [],
      pick: null,
      scan: images > 0,
      warnings: [images > 0 ? 'PDF — скан (картинка): контур не распознать, введите размеры вручную' : 'В PDF нет векторной геометрии'],
    };
  }
  // штамп и таблицы берём с первой страницы, где они есть
  const title: TitleInfo = { massInTable: false };
  let table: VariantTable | null = null;
  for (const p of pages) {
    const t = readTitle(p, titleRegion(p));
    for (const k of Object.keys(t) as (keyof TitleInfo)[]) {
      if (title[k] == null || title[k] === false) (title as unknown as Record<string, unknown>)[k] = t[k];
    }
  }
  for (const p of pages) {
    const tb = readTables(p, title.designation);
    if (tb) {
      table = table ? { cols: [...table.cols, ...tb.cols.filter((c) => !table!.cols.some((x) => x.key === c.key))], rows: [...table.rows, ...tb.rows] } : tb;
    }
  }
  const desig = fileDesignation ?? title.designation;
  let row = findRow(table, desig);
  if (row < 0 && title.designation) row = findRow(table, title.designation);
  const expectMass = row >= 0 ? table!.rows[row].values.mass : undefined;

  const candidates = pages.flatMap((p) => findCandidates(p, titleRegion(p)));
  if (!candidates.length) {
    return { meta: null, candidates, pick: null, scan: false, warnings: ['На чертеже не найден замкнутый контур детали'], title, table, row };
  }
  // если у исполнения своя длина, масса базового вида не совпадёт — сначала выбираем без массы
  const hasLetters = !!table && table.cols.some((c) => c.key.length === 1);
  const pick = choose(candidates, pages, title, hasLetters ? undefined : expectMass)!;
  const meta = metaFor(pages, candidates[pick.cand], pick, fileName, title, table, row);
  return { meta, candidates, pick, scan: false, warnings, title, table, row };
}

/** Результат для конкретного вида и масштаба (автовыбор или выбор пользователя) */
export function metaFor(
  pages: PdfPageData[],
  c: Candidate,
  pick: { scale: number; why: string[] },
  fileName: string,
  title: TitleInfo,
  table: VariantTable | null,
  row: number,
): PdfMeta {
  const page = pages.find((p) => p.index === c.page)!;
  const bends = findBendLines(page, c);
  if (c.brk) {
    // настоящий габарит укороченного вида — наибольший размер вдоль этой оси рядом с видом
    const extent = (c.brk.axis === 'x' ? c.bbox.maxX - c.bbox.minX : c.bbox.maxY - c.bbox.minY) * pick.scale;
    const near = page.texts.filter((t) => {
      const along = c.brk!.axis === 'x' ? Math.abs(t.angle) < 10 : Math.abs(Math.abs(t.angle) - 90) < 10;
      const dx = t.x < c.bbox.minX ? c.bbox.minX - t.x : t.x > c.bbox.maxX ? t.x - c.bbox.maxX : 0;
      const dy = t.y < c.bbox.minY ? c.bbox.minY - t.y : t.y > c.bbox.maxY ? t.y - c.bbox.maxY : 0;
      return along && Math.hypot(dx, dy) < 45;
    });
    const vals = near
      .map((t) => /^[ØÇ⌀]?\s*(\d+(?:[.,]\d+)?)\s*\*?$/.exec(t.str.trim()))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => num(m[1]))
      .filter((v) => v > extent * 1.03 && v < extent * 20);
    c.brk.target = vals.length ? Math.max(...vals) : null;
  }
  return {
    fileName,
    page: c.page,
    pages: pages.length,
    scale: pick.scale,
    scaleWhy: pick.why.join(', ') || 'нет подтверждений — проверьте масштаб',
    title,
    table,
    row,
    axes: letterAxes(page, c, table),
    base: baseOf(c, bends),
  };
}

/** Лучший масштаб для вида, выбранного вручную */
export function pickFor(c: Candidate, pages: PdfPageData[], title: TitleInfo, scale?: number): Pick {
  if (scale) return { cand: 0, scale, score: 0, why: ['масштаб задан вручную'] };
  return choose([c], pages, title)!;
}

/** Масса по геометрии для сверки со штампом (берётся ближайший вариант плотности) */
export function massCheck(meta: PdfMeta, g: PdfGeometry, materialId: string, t: number): { calc: number; drawing: number | null; ratio: number | null } {
  const variants = massVariants(g.netArea, 1, materialId, t);
  const calc = variants[0] ?? 0;
  if (!g.massDrawing) return { calc, drawing: null, ratio: null };
  const ratios = variants.map((m) => m / g.massDrawing!);
  const ratio = ratios.reduce((p, q) => (Math.abs(Math.log(q)) < Math.abs(Math.log(p)) ? q : p));
  return { calc, drawing: g.massDrawing, ratio };
}

// ---------- многостраничные PDF и заявки ----------

export interface DrawingGroup {
  designation?: string;
  pages: PdfPageData[];
}

/** Разбивает PDF на чертежи: страница со своим обозначением в штампе начинает новый чертёж,
 *  листы без штампа и продолжения с тем же обозначением присоединяются к предыдущему */
export function groupDrawings(pages: PdfPageData[]): DrawingGroup[] {
  const groups: (DrawingGroup & { key: string | null })[] = [];
  for (const p of pages) {
    const t = readTitle(p, titleRegion(p));
    const key = t.designation ? keyDesig(t.designation) : null;
    const last = groups[groups.length - 1];
    if (last && (!key || key === last.key || !last.key)) {
      last.pages.push(p);
      if (!last.key && key) {
        last.key = key;
        last.designation = t.designation;
      }
    } else groups.push({ key, designation: t.designation, pages: [p] });
  }
  return groups.map(({ designation, pages }) => ({ designation, pages }));
}

export interface QtyLine {
  designation: string;
  qty: number;
}

/** Количество из заявки/спецификации в PDF: строка с обозначением и числом «… 5 шт» */
export function readQtyList(pages: PdfPageData[]): QtyLine[] {
  const out: QtyLine[] = [];
  for (const p of pages) {
    const hasQtyHeader = p.texts.some((t) => /^(КОЛ\.?-?ВО|КОЛИЧЕСТВО|КОЛ\.)/.test(normText(t.str)));
    const rows = new Map<number, PdfText[]>();
    for (const t of p.texts.filter((t) => Math.abs(t.angle) < 5)) {
      const k = Math.round(t.y / 2);
      const key = rows.has(k) ? k : rows.has(k - 1) ? k - 1 : rows.has(k + 1) ? k + 1 : k;
      rows.set(key, [...(rows.get(key) ?? []), t]);
    }
    for (const items of rows.values()) {
      items.sort((a, b) => a.x - b.x);
      const line = items.map((t) => t.str).join(' ');
      const d = findDesignation(line);
      if (!d) continue;
      const after = line.slice(line.indexOf(d) + d.length);
      const m = /(\d{1,6})\s*(?:шт|компл)/i.exec(after) ?? (hasQtyHeader ? /(?:^|\s)(\d{1,6})(?:\s|$)/.exec(after) : null);
      if (!m) continue;
      const qty = parseInt(m[1], 10);
      if (qty > 0 && !out.some((x) => keyDesig(x.designation) === keyDesig(d))) out.push({ designation: d, qty });
    }
  }
  return out;
}
