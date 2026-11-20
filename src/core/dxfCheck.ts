// Проверка DXF перед расчётом — что мешает станку и расчёту, что цех попросит исправить и что просто к сведению.
// Уровни: error — цена позиции не считается, пока файл не исправят или менеджер не нажмёт «Считать как есть»
// (разомкнутый контур, самопересечение, 3D вместо развёртки, деталь только на листе, картинка, неверный масштаб);
// warn — цена считается, но файл стоит поправить (дубли, мусор, хвосты, надписи и заливки внутри детали);
// info — только в карточке (оформление, сплайны, пересчёт единиц).
// Толщина здесь не известна: самое маленькое отверстие и самую узкую перемычку сравнивает с толщиной attention.ts.

import type { DxfDrawing, Vec } from './dxf.ts';
import { distToPoly, inside, type Analysis } from './geometry.ts';

export type DxfIssueLevel = 'error' | 'warn' | 'info';
export type DxfIssueCode =
  | 'nocontour'
  | 'gap'
  | 'cross'
  | '3d'
  | 'paper'
  | 'image'
  | 'scale'
  | 'dup'
  | 'micro'
  | 'tail'
  | 'inner'
  | 'stray'
  | 'text'
  | 'fill'
  | 'unknown'
  | 'anno'
  | 'spline'
  | 'units';

export interface DxfIssue {
  code: DxfIssueCode;
  level: DxfIssueLevel;
  text: string;
  at?: [number, number][]; // где (мм, координаты чертежа) — до 8 меток на эскизе
}

/** Размер и где он на чертеже */
export interface Spot {
  d: number;
  at: [number, number];
}

export interface DxfCheck {
  issues: DxfIssue[];
  minHole?: Spot; // самое маленькое отверстие (меньшая сторона габарита)
  minBridge?: Spot; // самая узкая перемычка между контурами одной детали
}

const GAP = 2; // мм: концы линий ближе — недотянутый стык контура
const BRIDGE_R = 25; // мм: перемычки шире не ищем (толще 25 мм не режем)
const MAX_AT = 8;

const n1 = (v: number) => (Math.round(v * 10) / 10).toString().replace('.', ',');
const n0 = (v: number) => String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const pcs = (n: number, one: string, few: string, many: string) =>
  `${n} ${n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many}`;
const pt = (v: Vec): [number, number] => [Math.round(v.x * 100) / 100, Math.round(v.y * 100) / 100];
const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);

/** Точки, где отрезки контуров пересекаются внутри (не концами): петли и наложенные контуры */
function crossings(loops: Vec[][], tol: number): { at: Vec; self: boolean }[] {
  type Seg = { a: Vec; b: Vec; loop: number; i: number; n: number };
  const segs: Seg[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  loops.forEach((pts, loop) => {
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      segs.push({ a, b, loop, i, n });
      minX = Math.min(minX, a.x);
      maxX = Math.max(maxX, a.x);
      minY = Math.min(minY, a.y);
      maxY = Math.max(maxY, a.y);
    }
  });
  if (segs.length < 4) return [];
  const cell = Math.max(Math.hypot(maxX - minX, maxY - minY) / 120, 0.5);
  const grid = new Map<string, number[]>();
  segs.forEach((s, k) => {
    const x0 = Math.floor(Math.min(s.a.x, s.b.x) / cell);
    const x1 = Math.floor(Math.max(s.a.x, s.b.x) / cell);
    const y0 = Math.floor(Math.min(s.a.y, s.b.y) / cell);
    const y1 = Math.floor(Math.max(s.a.y, s.b.y) / cell);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4000) return; // длинный отрезок через всё — крайне редкий случай, пропускаем
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        const key = `${x},${y}`;
        const arr = grid.get(key);
        if (arr) arr.push(k);
        else grid.set(key, [k]);
      }
  });
  const out: { at: Vec; self: boolean }[] = [];
  const seen = new Set<number>();
  for (const arr of grid.values()) {
    for (let p = 0; p < arr.length; p++) {
      for (let q = p + 1; q < arr.length; q++) {
        const A = segs[arr[p]];
        const B = segs[arr[q]];
        if (A.loop === B.loop) {
          const d = Math.abs(A.i - B.i);
          if (d <= 1 || d === A.n - 1) continue; // соседние отрезки стыкуются концами
        }
        const key = arr[p] * segs.length + arr[q];
        if (seen.has(key)) continue;
        seen.add(key);
        const r = { x: A.b.x - A.a.x, y: A.b.y - A.a.y };
        const s = { x: B.b.x - B.a.x, y: B.b.y - B.a.y };
        const den = r.x * s.y - r.y * s.x;
        if (Math.abs(den) < 1e-12) continue;
        const t = ((B.a.x - A.a.x) * s.y - (B.a.y - A.a.y) * s.x) / den;
        const u = ((B.a.x - A.a.x) * r.y - (B.a.y - A.a.y) * r.x) / den;
        const lr = Math.hypot(r.x, r.y);
        const ls = Math.hypot(s.x, s.y);
        if (t * lr > tol && (1 - t) * lr > tol && u * ls > tol && (1 - u) * ls > tol) {
          out.push({ at: { x: A.a.x + r.x * t, y: A.a.y + r.y * t }, self: A.loop === B.loop });
          if (out.length >= 50) return out;
        }
      }
    }
  }
  return out;
}

/** Самое близкое место двух ломаных (замкнутых), если ближе r */
function closest(A: Vec[], B: Vec[], r: number): Spot | null {
  let best = null as Spot | null;
  const probe = (P: Vec[], Q: Vec[]) => {
    for (const p of P) {
      const d = distToPoly(p, Q);
      if (d < r && (!best || d < best.d)) best = { d, at: pt(p) };
    }
  };
  probe(A, B);
  probe(B, A);
  return best;
}

export function checkDxf(dwg: DxfDrawing, an: Analysis): DxfCheck {
  const issues: DxfIssue[] = [];
  const st = dwg.stats;
  const add = (code: DxfIssueCode, level: DxfIssueLevel, text: string, at?: Vec[]) =>
    issues.push({ code, level, text, ...(at?.length ? { at: at.slice(0, MAX_AT).map(pt) } : {}) });

  // ---------- файл: плоскость, лист, картинки ----------
  if (st && (st.tilted > 0 || (Number.isFinite(st.zMin) && st.zMax - st.zMin > 0.01))) {
    const z = Number.isFinite(st.zMin) && st.zMax - st.zMin > 0.01 ? `: Z от ${n1(st.zMin)} до ${n1(st.zMax)} мм` : `: ${pcs(st.tilted, 'объект', 'объекта', 'объектов')} не в плоскости чертежа`;
    add('3d', 'error', `Геометрия не в одной плоскости${z} — похоже на 3D-модель, а не развёртку. Нужна плоская развёртка 1:1`);
  }
  if (!dwg.prims.length && st?.paper) add('paper', 'error', 'Деталь нарисована на листе (Layout), а в модели пусто — пересохраните DXF из модели в масштабе 1:1');
  if (st?.images) {
    if (!an.parts.length) add('image', 'error', 'В файле картинка, а не векторный контур — по картинке резать нельзя, нужен DXF с линиями');
    else add('image', 'warn', `В файле ${pcs(st.images, 'картинка', 'картинки', 'картинок')} (растровая подложка) — для станка удалите`);
  }

  // ---------- контур: зазоры, петли, наложения ----------
  const loose = an.open.filter((o) => o.where === 'inner' || o.where === 'stray');
  const ends: { p: Vec; i: number }[] = [];
  loose.forEach((o, i) => {
    if (o.pts.length < 2 || o.length < an.eps * 2) return;
    ends.push({ p: o.pts[0], i }, { p: o.pts[o.pts.length - 1], i });
  });
  const gaps: { at: Vec; d: number }[] = [];
  // концы ближе GAP, но дальше допуска стыковки — недотянутый стык (ячейки по GAP: соседей ищем в 3×3)
  const grid = new Map<string, number[]>();
  ends.forEach((e, k) => {
    const key = `${Math.floor(e.p.x / GAP)},${Math.floor(e.p.y / GAP)}`;
    const arr = grid.get(key);
    if (arr) arr.push(k);
    else grid.set(key, [k]);
  });
  const used = new Set<number>();
  ends.forEach((e, k) => {
    if (used.has(k)) return;
    const cx = Math.floor(e.p.x / GAP);
    const cy = Math.floor(e.p.y / GAP);
    let best = -1;
    let bestD = Infinity;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const j of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (j === k || used.has(j)) continue;
          if (ends[j].i === e.i && loose[e.i].length < GAP * 4) continue; // короткий обрывок сам с собой — не стык
          const d = dist(e.p, ends[j].p);
          if (d > an.eps && d <= GAP && d < bestD) {
            bestD = d;
            best = j;
          }
        }
    if (best >= 0) {
      used.add(k);
      used.add(best);
      gaps.push({ at: { x: (e.p.x + ends[best].p.x) / 2, y: (e.p.y + ends[best].p.y) / 2 }, d: bestD });
    }
  });
  if (gaps.length) {
    const max = Math.max(...gaps.map((g) => g.d));
    add(
      'gap',
      'error',
      `Контур разомкнут: ${pcs(gaps.length, 'зазор', 'зазора', 'зазоров')} до ${n1(Math.max(max, 0.1))} мм между концами линий — станок не поймёт, где деталь; замкните контур`,
      gaps.map((g) => g.at),
    );
  }
  if (!an.parts.length && !issues.some((i) => i.level === 'error')) add('nocontour', 'error', 'Не найдено ни одного замкнутого контура — деталь не определить');

  const loops: { pts: Vec[]; part: number }[] = [];
  an.parts.forEach((pg, part) => {
    loops.push({ pts: pg.outer.pts, part });
    for (const h of pg.holes) loops.push({ pts: h.pts, part });
  });
  if (loops.length) {
    const cr = crossings(
      loops.map((l) => l.pts),
      Math.max(an.eps * 2, 0.01),
    );
    const self = cr.filter((c) => c.self);
    const other = cr.filter((c) => !c.self);
    if (self.length) add('cross', 'error', `Контур пересекает сам себя (${pcs(self.length, 'место', 'места', 'мест')}) — петля или лишний выступ, площадь и рез посчитаны неверно`, self.map((c) => c.at));
    if (other.length) add('cross', 'error', `Контуры пересекаются (${pcs(other.length, 'место', 'места', 'мест')}): отверстие заходит за край детали или на другое отверстие`, other.map((c) => c.at));
  }

  // ---------- масштаб ----------
  if (an.parts.length) {
    const b = an.bbox;
    const size = Math.max(b.maxX - b.minX, b.maxY - b.minY);
    if (size < 5) add('scale', 'error', `Габарит детали ${n1(size)} мм — похоже, неверные единицы или масштаб: нужен чертёж 1:1 в мм`);
  }

  // ---------- что цех попросит поправить ----------
  if (an.dupInPart) add('dup', 'warn', `Линии задвоены (${an.dupInPart} шт) — в расчёте один рез, но станок пройдёт дважды: удалите дубли`);
  const junk = (st?.zeroLength ?? 0) + (st?.points ?? 0) + (st?.tiny ?? 0);
  if (junk) add('micro', 'warn', `Мусор в чертеже: ${pcs(junk, 'точка или отрезок', 'точки или отрезка', 'точек и отрезков')} короче 0,1 мм — CAM может не построить траекторию`);

  const partLoops = an.parts.flatMap((pg) => [pg.outer.pts, ...pg.holes.map((h) => h.pts)]);
  const touches = (p: Vec) => partLoops.some((l) => distToPoly(p, l) <= Math.max(an.eps * 4, 0.05));
  const inner = an.open.filter((o) => o.where === 'inner');
  // хвост — короткая линия, одним концом на контуре (внутрь или наружу)
  const tails = loose.filter((o) => {
    const a = touches(o.pts[0]);
    const b = touches(o.pts[o.pts.length - 1]);
    return a !== b && o.length < 20;
  });
  if (tails.length) add('tail', 'warn', `Хвосты: ${pcs(tails.length, 'линия торчит', 'линии торчат', 'линий торчат')} из контура — станок прорежет лишнее, удалите`, tails.map((o) => o.pts[0]));
  const curves = inner.filter((o) => !tails.includes(o) && !o.straight && o.length > 5);
  if (curves.length) {
    const L = curves.reduce((s, o) => s + o.length, 0);
    add('inner', 'warn', `Внутри детали ${pcs(curves.length, 'незамкнутая линия', 'незамкнутые линии', 'незамкнутых линий')} (${n0(L)} мм) — в рез не входят: если это прорези или гравировка, уточните`, curves.map((o) => o.pts[0]));
  }
  const stray = an.open.filter((o) => o.where === 'stray' && !tails.includes(o) && o.length > an.eps * 10);
  if (stray.length && an.parts.length) {
    const L = stray.reduce((s, o) => s + o.length, 0);
    add('stray', 'warn', `Вне детали ${pcs(stray.length, 'незамкнутая линия', 'незамкнутые линии', 'незамкнутых линий')} (${n0(L)} мм) — в расчёт не входят; если это часть детали, замкните контур`, stray.map((o) => o.pts[0]));
  }
  const inPart = (p: Vec) => an.parts.some((pg) => inside(p, pg.outer.pts) && !pg.holes.some((h) => inside(p, h.pts)));
  const textsIn = dwg.texts.filter(inPart);
  if (textsIn.length) add('text', 'warn', `Надписи внутри детали (${textsIn.length}) — если это гравировка, переведите в кривые; в расчёт не входят`, textsIn);
  const fills = st?.fills ?? [];
  const fillsIn = fills.filter(inPart);
  if (fillsIn.length) add('fill', 'warn', `Штриховка или заливка внутри детали (${fillsIn.length}) — для станка удалите`, fillsIn);
  const unknown = dwg.warnings.find((w) => w.startsWith('Пропущены неподдерживаемые объекты'));
  if (unknown) add('unknown', 'warn', `${unknown} — если в них часть контура, расчёт неполный`);

  // ---------- к сведению ----------
  const anno: string[] = [];
  if (an.annotations.length) anno.push('рамка или штамп');
  if (st?.dims) anno.push('размеры');
  if (dwg.texts.length > textsIn.length) anno.push('надписи');
  if (fills.length > fillsIn.length) anno.push('штриховки');
  if (anno.length) add('anno', 'info', `Оформление (${anno.join(', ')}) в расчёт не входит; для станка его лучше удалить`);
  if (st?.splines) add('spline', 'info', `Сплайны: ${st.splines} — если цех попросит, переведите в дуги и отрезки`);
  if (st?.units) add('units', 'info', `Чертёж в ${st.units} — пересчитан в мм`);

  // ---------- для сравнения с толщиной ----------
  let minHole: Spot | undefined;
  let minBridge: Spot | undefined;
  for (const pg of an.parts) {
    for (const h of pg.holes) {
      const d = Math.min(h.bbox.maxX - h.bbox.minX, h.bbox.maxY - h.bbox.minY);
      if (!minHole || d < minHole.d) minHole = { d, at: pt({ x: (h.bbox.minX + h.bbox.maxX) / 2, y: (h.bbox.minY + h.bbox.maxY) / 2 }) };
    }
    const ls = [pg.outer, ...pg.holes];
    if (ls.length > 400) continue; // сотни отверстий — перемычки не ищем (дорого)
    for (let i = 0; i < ls.length; i++)
      for (let j = i + 1; j < ls.length; j++) {
        const A = ls[i].bbox;
        const B = ls[j].bbox;
        // наружный контур охватывает отверстие — близость к краю смотрим всегда; отверстия — если габариты рядом
        if (i > 0 && (A.minX - BRIDGE_R > B.maxX || B.minX - BRIDGE_R > A.maxX || A.minY - BRIDGE_R > B.maxY || B.minY - BRIDGE_R > A.maxY)) continue;
        const c = closest(ls[i].pts, ls[j].pts, Math.min(BRIDGE_R, minBridge?.d ?? BRIDGE_R));
        if (c && (!minBridge || c.d < minBridge.d)) minBridge = c;
      }
  }
  return { issues, ...(minHole ? { minHole } : {}), ...(minBridge ? { minBridge } : {}) };
}

/** Есть ошибка, из-за которой цену не считаем */
export const hasDxfError = (c: DxfCheck | undefined): boolean => !!c?.issues.some((i) => i.level === 'error');
