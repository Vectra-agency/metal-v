// Из примитивов DXF собираем замкнутые контуры, раскладываем их на
// наружные (деталь) и внутренние (отверстия), отсеиваем рамки/штампы,
// находим линии гиба. Всё — в мм.

import type { DxfDrawing, Prim, Vec } from './dxf.ts';

export interface Loop {
  id: number;
  pts: Vec[];
  length: number;
  area: number; // модуль площади, мм²
  bbox: Box;
  parent: number; // id родителя или -1
  depth: number; // 0 — наружный контур детали, 1 — отверстие, 2 — «остров» и т.д.
}

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface OpenPath {
  pts: Vec[];
  length: number;
  straight: boolean;
  dashed: boolean;
  layer?: string;
  ltype?: string;
  closed?: boolean; // замкнутая цепочка штриховых линий (контуром детали не считается)
}

/** Прямая или линия внутри детали: засчитана гибом или нет — и почему (для показа в карточке) */
export interface BendCand {
  pts: Vec[];
  length: number;
  bend: boolean;
  why: string;
}

/** Незамкнутая линия после сцепки: где лежит (для проверки DXF — зазоры, хвосты, мусор) */
export interface OpenLine {
  pts: Vec[];
  length: number;
  straight: boolean;
  where: 'bend' | 'inner' | 'stray' | 'anno'; // гиб / внутри детали, не гиб / вне детали / в рамке
}

export interface PartGeom {
  outer: Loop;
  holes: Loop[];
  islands: Loop[]; // детали внутри отверстий — считаем отдельными наружными
}

export interface Analysis {
  parts: PartGeom[]; // найденные детали (наружные контуры)
  annotations: Loop[]; // рамки/штампы, отброшенные автоматически
  bends: OpenPath[]; // линии гиба внутри детали
  bendCands: BendCand[]; // гибы и отвергнутые линии внутри детали — с причиной
  stray: OpenPath[]; // незамкнутые обрывки (предупреждение)
  open: OpenLine[]; // все незамкнутые линии после сцепки
  dupInPart: number; // задвоенных линий в детали (вне рамки)
  eps: number; // допуск стыковки концов, мм
  bbox: Box; // габарит всего, что считаем деталью
  warnings: string[];
}

export function boxOf(pts: Vec[]): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export function unionBox(boxes: Box[]): Box {
  return {
    minX: Math.min(...boxes.map((b) => b.minX)),
    minY: Math.min(...boxes.map((b) => b.minY)),
    maxX: Math.max(...boxes.map((b) => b.maxX)),
    maxY: Math.max(...boxes.map((b) => b.maxY)),
  };
}

export function signedArea(pts: Vec[]): number {
  let s = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

export function inside(p: Vec, poly: Vec[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

function boxInside(a: Box, b: Box, eps: number): boolean {
  return a.minX >= b.minX - eps && a.maxX <= b.maxX + eps && a.minY >= b.minY - eps && a.maxY <= b.maxY + eps;
}

const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);

// Точки контура A лежат внутри B (по большинству нескольких проб)
function loopInside(a: Loop, b: Loop): boolean {
  if (b.area <= a.area) return false;
  if (!boxInside(a.bbox, b.bbox, 1e-6)) return false;
  const n = a.pts.length;
  const probes = Math.min(n, 7);
  let yes = 0;
  for (let k = 0; k < probes; k++) {
    const i = Math.floor((k * n) / probes);
    const p = a.pts[i];
    const q = a.pts[(i + 1) % n];
    if (inside({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }, b.pts)) yes++;
  }
  return yes * 2 > probes;
}

function isStraight(pts: Vec[], tol: number): boolean {
  if (pts.length < 2) return false;
  const a = pts[0];
  const b = pts[pts.length - 1];
  const L = dist(a, b);
  if (L < 1e-9) return false;
  for (const p of pts) {
    const d = Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / L;
    if (d > tol) return false;
  }
  return true;
}

// Удаляем точные дубли (одна линия, нарисованная дважды — двойной рез)
function dedupe(prims: Prim[], eps: number): { prims: Prim[]; removed: Prim[] } {
  const seen = new Map<string, Prim[]>();
  const out: Prim[] = [];
  const removed: Prim[] = [];
  const key = (p: Prim) => {
    const a = p.pts[0];
    const b = p.pts[p.pts.length - 1];
    const m = p.pts[Math.floor(p.pts.length / 2)];
    const r = (v: number) => Math.round(v / (eps * 10));
    const ends = [`${r(a.x)},${r(a.y)}`, `${r(b.x)},${r(b.y)}`].sort().join('|');
    return `${ends}|${r(m.x)},${r(m.y)}|${Math.round(p.length / (eps * 10))}`;
  };
  for (const p of prims) {
    const k = key(p);
    if (seen.has(k)) {
      removed.push(p);
      continue;
    }
    seen.set(k, [p]);
    out.push(p);
  }
  return { prims: out, removed };
}

interface Chain {
  pts: Vec[];
  length: number;
  closed: boolean;
  dashed: boolean;
  layer: string;
  ltype: string;
}

// Отделяем «висячие» примитивы: у которых хотя бы один конец ни с чем не
// стыкуется (линии гиба, обрывки, лишние сегменты в углах). Повторяем,
// пока что-то отрезается — так уходят и цепочки висячих кусков.
function splitDangling(open: Prim[], eps: number): { core: Prim[]; dangling: Prim[] } {
  const cell = Math.max(eps * 4, 1e-3);
  const nodes: Vec[] = [];
  const grid = new Map<string, number[]>();
  const nodeOf = (v: Vec): number => {
    const cx = Math.floor(v.x / cell);
    const cy = Math.floor(v.y / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const id of grid.get(`${cx + dx},${cy + dy}`) ?? []) if (dist(nodes[id], v) <= eps) return id;
      }
    }
    nodes.push(v);
    const k = `${cx},${cy}`;
    const arr = grid.get(k);
    if (arr) arr.push(nodes.length - 1);
    else grid.set(k, [nodes.length - 1]);
    return nodes.length - 1;
  };
  const ends = open.map((p) => [nodeOf(p.pts[0]), nodeOf(p.pts[p.pts.length - 1])] as const);
  const alive = open.map(() => true);
  const degree = new Int32Array(nodes.length);
  ends.forEach(([a, b]) => {
    degree[a]++;
    degree[b]++;
  });
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < open.length; i++) {
      if (!alive[i]) continue;
      const [a, b] = ends[i];
      if (degree[a] < 2 || degree[b] < 2) {
        alive[i] = false;
        degree[a]--;
        degree[b]--;
        changed = true;
      }
    }
  }
  return { core: open.filter((_, i) => alive[i]), dangling: open.filter((_, i) => !alive[i]) };
}

// Сцепляем незамкнутые примитивы по совпадающим концам
function chainPrims(prims: Prim[], eps: number): Chain[] {
  const chains: Chain[] = [];
  const openAll: Prim[] = [];
  for (const p of prims) {
    const closedGeom = p.closed || (p.pts.length > 2 && dist(p.pts[0], p.pts[p.pts.length - 1]) <= eps);
    if (closedGeom) {
      const pts = p.pts.slice();
      if (dist(pts[0], pts[pts.length - 1]) <= eps) pts.pop();
      chains.push({ pts, length: p.length, closed: true, dashed: p.dashed, layer: p.layer, ltype: p.ltype });
    } else openAll.push(p);
  }
  const { core, dangling } = splitDangling(openAll, eps);
  return chains.concat(chainOpen(core, eps), chainOpen(dangling, eps));
}

function chainOpen(open: Prim[], eps: number): Chain[] {
  const chains: Chain[] = [];
  // пространственный хеш концов
  const cell = Math.max(eps * 4, 1e-3);
  const grid = new Map<string, { idx: number; end: 0 | 1 }[]>();
  const keyOf = (v: Vec) => `${Math.floor(v.x / cell)},${Math.floor(v.y / cell)}`;
  const addEnd = (idx: number, end: 0 | 1, v: Vec) => {
    const k = keyOf(v);
    let arr = grid.get(k);
    if (!arr) grid.set(k, (arr = []));
    arr.push({ idx, end });
  };
  open.forEach((p, i) => {
    addEnd(i, 0, p.pts[0]);
    addEnd(i, 1, p.pts[p.pts.length - 1]);
  });
  const used = new Uint8Array(open.length);

  // продолжение — ближайший конец в пределах допуска; линия того же слоя и типа важнее (контур продолжается контуром,
  // а не линией гиба, которая подходит к тому же углу)
  const findNext = (v: Vec, from: Prim): { idx: number; end: 0 | 1 } | null => {
    const cx = Math.floor(v.x / cell);
    const cy = Math.floor(v.y / cell);
    let best: { idx: number; end: 0 | 1 } | null = null;
    let bestKey = Infinity;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const arr = grid.get(`${cx + dx},${cy + dy}`);
        if (!arr) continue;
        for (const c of arr) {
          if (used[c.idx]) continue;
          const p = open[c.idx];
          if (p.dashed !== from.dashed) continue;
          const q = c.end === 0 ? p.pts[0] : p.pts[p.pts.length - 1];
          const d = dist(q, v);
          if (d > eps) continue;
          const key = (p.layer === from.layer && p.ltype === from.ltype ? 0 : 1) * 10 * eps + d;
          if (key < bestKey) {
            bestKey = key;
            best = c;
          }
        }
      }
    }
    return best;
  };

  for (let i = 0; i < open.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const first = open[i];
    let pts = first.pts.slice();
    let length = first.length;
    // вперёд
    for (;;) {
      const nx = findNext(pts[pts.length - 1], first);
      if (!nx) break;
      used[nx.idx] = 1;
      const seg = open[nx.idx].pts;
      const add = nx.end === 0 ? seg : seg.slice().reverse();
      pts = pts.concat(add.slice(1));
      length += open[nx.idx].length;
      if (dist(pts[0], pts[pts.length - 1]) <= eps) break;
    }
    // назад, если не замкнулись
    if (dist(pts[0], pts[pts.length - 1]) > eps) {
      for (;;) {
        const nx = findNext(pts[0], first);
        if (!nx) break;
        used[nx.idx] = 1;
        const seg = open[nx.idx].pts;
        const add = nx.end === 1 ? seg : seg.slice().reverse();
        pts = add.slice(0, -1).concat(pts);
        length += open[nx.idx].length;
        if (dist(pts[0], pts[pts.length - 1]) <= eps) break;
      }
    }
    const closed = pts.length > 2 && dist(pts[0], pts[pts.length - 1]) <= eps;
    if (closed) pts.pop();
    chains.push({ pts, length, closed, dashed: first.dashed, layer: first.layer, ltype: first.ltype });
  }
  return chains;
}

// Стандартные форматы листов чертежа (рамки), мм
const SHEET_FORMATS = [
  [210, 297], [297, 420], [420, 594], [594, 841], [841, 1189], [297, 630], [297, 841], [420, 891],
  [185, 287], [287, 410], [410, 584], [584, 831], // внутренние рамки ЕСКД
];

function looksLikeSheetFrame(b: Box): boolean {
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  const [s, l] = w < h ? [w, h] : [h, w];
  return SHEET_FORMATS.some(([fs, fl]) => Math.abs(s - fs) < 1.5 && Math.abs(l - fl) < 1.5);
}

export interface AnalyzeOptions {
  /** 'frame' — убрать контур, вложенные поднять на уровень выше (рамка листа);
   *  'drop' — убрать контур вместе со всем вложенным (штамп, таблица) */
  loopFilter?: (l: Loop) => 'frame' | 'drop' | null;
}

export function analyze(dwg: DxfDrawing, opts: AnalyzeOptions = {}): Analysis {
  const warnings: string[] = [];
  if (!dwg.prims.length) {
    return { parts: [], annotations: [], bends: [], bendCands: [], stray: [], open: [], dupInPart: 0, eps: 0.01, bbox: { minX: 0, minY: 0, maxX: 0, maxY: 0 }, warnings: ['В файле нет геометрии'] };
  }
  const all = boxOf(dwg.prims.flatMap((p) => [p.pts[0], p.pts[p.pts.length - 1]]));
  const diag = Math.hypot(all.maxX - all.minX, all.maxY - all.minY);
  const eps = Math.min(0.5, Math.max(0.01, diag * 2e-5));

  const { prims, removed } = dedupe(dwg.prims, eps);

  const chains = chainPrims(prims, eps);
  const loops: Loop[] = [];
  const openPaths: OpenPath[] = [];
  for (const c of chains) {
    if (c.closed && !c.dashed && c.pts.length >= 3) {
      const a = Math.abs(signedArea(c.pts));
      if (a < 1e-6) {
        openPaths.push({ pts: c.pts, length: c.length, straight: isStraight(c.pts, eps * 2), dashed: c.dashed, layer: c.layer, ltype: c.ltype, closed: true });
        continue;
      }
      loops.push({ id: loops.length, pts: c.pts, length: c.length, area: a, bbox: boxOf(c.pts), parent: -1, depth: 0 });
    } else {
      const closed = c.closed && c.pts.length >= 3; // замкнутая штриховая цепочка: прямоугольник линий гиба вокруг основания
      openPaths.push({ pts: c.pts, length: c.length, straight: !closed && isStraight(c.pts, Math.max(eps * 2, 0.05)), dashed: c.dashed, layer: c.layer, ltype: c.ltype, closed });
    }
  }

  // дерево вложенности: родитель — наименьший охватывающий контур
  const order = loops.slice().sort((a, b) => a.area - b.area);
  for (const l of order) {
    let best: Loop | null = null;
    for (const m of order) {
      if (m === l || m.area <= l.area) continue;
      if (best && m.area >= best.area) continue;
      if (loopInside(l, m)) best = m;
    }
    l.parent = best ? best.id : -1;
  }
  let byId = new Map(loops.map((l) => [l.id, l]));
  if (opts.loopFilter) {
    const removed = new Set<number>();
    const verdict = new Map(loops.map((l) => [l.id, opts.loopFilter!(l)]));
    // рамки: убираем, вложенное поднимаем к родителю рамки
    for (const l of loops.slice().sort((a, b) => b.area - a.area)) {
      if (verdict.get(l.id) !== 'frame') continue;
      for (const c of loops) if (c.parent === l.id) c.parent = l.parent;
      removed.add(l.id);
    }
    // штампы/таблицы: убираем с потомками
    const isUnder = (l: Loop, id: number): boolean => (l.parent < 0 ? false : l.parent === id || isUnder(byId.get(l.parent)!, id));
    for (const l of loops) {
      if (verdict.get(l.id) !== 'drop' || removed.has(l.id)) continue;
      removed.add(l.id);
      for (const c of loops) if (isUnder(c, l.id)) removed.add(c.id);
    }
    if (removed.size) {
      const keep = loops.filter((l) => !removed.has(l.id));
      loops.length = 0;
      loops.push(...keep);
      byId = new Map(loops.map((l) => [l.id, l]));
    }
  }
  const depthOf = (l: Loop): number => (l.parent < 0 ? 0 : depthOf(byId.get(l.parent)!) + 1);
  for (const l of loops) l.depth = depthOf(l);
  const rootOf = (l: Loop): Loop => (l.parent < 0 ? l : rootOf(byId.get(l.parent)!));

  // рамки/штампы: корневой контур с текстом внутри или контур формата листа
  const annotationRoots = new Set<number>();
  for (const l of loops) {
    if (l.depth !== 0) continue;
    const hasText = dwg.texts.some((t) => t.x >= l.bbox.minX && t.x <= l.bbox.maxX && t.y >= l.bbox.minY && t.y <= l.bbox.maxY && inside(t, l.pts));
    if (hasText || looksLikeSheetFrame(l.bbox)) annotationRoots.add(l.id);
  }
  // если всё оказалось «аннотацией» — значит текст лежит на самой детали, не отбрасываем
  const roots = loops.filter((l) => l.depth === 0);
  if (roots.length && roots.every((l) => annotationRoots.has(l.id))) {
    annotationRoots.clear();
    warnings.push('Текст внутри контура детали — проверьте, что рамка не попала в расчёт');
  }

  const annotations = loops.filter((l) => annotationRoots.has(rootOf(l).id) && l.depth === 0);
  const live = loops.filter((l) => !annotationRoots.has(rootOf(l).id));

  // Наружные контуры: чётная глубина; отверстия: нечётная
  const parts: PartGeom[] = [];
  const partByOuter = new Map<number, PartGeom>();
  for (const l of live) {
    if (l.depth % 2 === 0) {
      const pg: PartGeom = { outer: l, holes: [], islands: [] };
      parts.push(pg);
      partByOuter.set(l.id, pg);
    }
  }
  for (const l of live) {
    if (l.depth % 2 === 1) partByOuter.get(l.parent)?.holes.push(l);
  }
  for (const pg of parts) if (pg.outer.depth > 0) pg.islands = [];
  // крупные сначала
  parts.sort((a, b) => b.outer.area - a.outer.area);

  // Открытые линии: прямые внутри детали — кандидаты в линии гиба; прочее — обрывки
  const stray: OpenPath[] = [];
  const open: OpenLine[] = [];
  const annoLoops = loops.filter((l) => annotationRoots.has(l.id));
  const inner: { op: OpenPath; host: PartGeom }[] = [];
  for (const op of openPaths) {
    // где лежит линия — по точкам вдоль неё (вершины ломаной могут лежать на самом контуре, середина — в отверстии)
    const probes = samples(op.pts, op.closed);
    if (annoLoops.some((l) => inside(probes[0], l.pts))) {
      open.push({ pts: op.pts, length: op.length, straight: op.straight, where: 'anno' }); // внутри рамки — игнор
      continue;
    }
    const roots = parts.filter((pg) => pg.outer.depth === 0);
    const inMetal = (pg: PartGeom, v: Vec) => inside(v, pg.outer.pts) && !pg.holes.some((h) => inside(v, h.pts));
    const host = roots.find((pg) => probes.some((v) => inMetal(pg, v))) ?? roots.find((pg) => inside(probes[0], pg.outer.pts));
    if (host) inner.push({ op, host });
    else {
      if (op.length > eps * 10) stray.push(op);
      open.push({ pts: op.pts, length: op.length, straight: op.straight, where: 'stray' });
    }
  }
  const { bends, cands } = classifyBends(inner, eps);
  for (const { op } of inner) open.push({ pts: op.pts, length: op.length, straight: op.straight, where: bends.some((b) => b.src.includes(op)) ? 'bend' : 'inner' });


  // о дублях сообщаем, только если они в самой детали (в рамке чертежа — не важно)
  const dupInPart = removed.filter((p) => {
    const mid = p.pts[Math.floor(p.pts.length / 2)];
    return !annoLoops.some((l) => inside(mid, l.pts));
  }).length;
  if (dupInPart) warnings.push(`Линии контура задвоены (${dupInPart} шт) — двойной рез не считаем`);
  if (stray.length) {
    const L = stray.reduce((s, o) => s + o.length, 0);
    warnings.push(`Незамкнутые линии вне детали: ${stray.length} шт, ${Math.round(L)} мм — проверьте контур`);
  }
  if (!parts.length) warnings.push('Не найдено ни одного замкнутого контура');

  const bbox = parts.length ? unionBox(parts.map((p) => p.outer.bbox)) : all;
  return { parts, annotations, bends: bends.map((b) => b.path), bendCands: cands, stray, open, dupInPart, eps, bbox, warnings };
}

// ---------- линии гиба ----------

const fmt0 = (v: number) => String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
const linesWord = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? 'линию' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'линии' : 'линий');

/** Расстояние от точки до ломаной (замкнутой) */
export function distToPoly(p: Vec, poly: Vec[], closed = true): number {
  let best = Infinity;
  const n = poly.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L2 = dx * dx + dy * dy;
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2)) : 0;
    const d = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
    if (d < best) best = d;
  }
  return best;
}

/** Точка, где отрезки ab и cd пересекаются внутри (не концами); null — не пересекаются */
export function crossPoint(a: Vec, b: Vec, c: Vec, d: Vec, tol: number): Vec | null {
  const r = { x: b.x - a.x, y: b.y - a.y };
  const q = { x: d.x - c.x, y: d.y - c.y };
  const den = r.x * q.y - r.y * q.x;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c.x - a.x) * q.y - (c.y - a.y) * q.x) / den;
  const u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / den;
  const lr = Math.hypot(r.x, r.y);
  const lq = Math.hypot(q.x, q.y);
  return t * lr > tol && (1 - t) * lr > tol && u * lq > tol && (1 - u) * lq > tol ? { x: a.x + r.x * t, y: a.y + r.y * t } : null;
}

/** Точки вдоль ломаной: середина самого длинного отрезка и ещё 6 точек по длине */
function samples(pts: Vec[], closed = false): Vec[] {
  const p = closed ? [...pts, pts[0]] : pts;
  let k = 0;
  let best = -1;
  let total = 0;
  for (let i = 0; i + 1 < p.length; i++) {
    const l = dist(p[i], p[i + 1]);
    total += l;
    if (l > best) {
      best = l;
      k = i;
    }
  }
  const out: Vec[] = [{ x: (p[k].x + p[k + 1].x) / 2, y: (p[k].y + p[k + 1].y) / 2 }];
  for (const f of [0.15, 0.3, 0.45, 0.6, 0.75, 0.9]) {
    let need = total * f;
    for (let i = 0; i + 1 < p.length; i++) {
      const l = dist(p[i], p[i + 1]);
      if (need <= l && l > 0) {
        out.push({ x: p[i].x + ((p[i + 1].x - p[i].x) * need) / l, y: p[i].y + ((p[i + 1].y - p[i].y) * need) / l });
        break;
      }
      need -= l;
    }
  }
  return out;
}

/** Прямые участки ломаной (замкнутая — с замыкающим отрезком): излом больше 1° — новый участок; дуги дают короткие участки */
function straightRuns(op: OpenPath, eps: number): OpenPath[] {
  const p = op.pts.slice();
  if (op.closed && dist(p[0], p[p.length - 1]) > eps) p.push(p[0]); // замыкающий отрезок
  const out: OpenPath[] = [];
  let start = 0;
  const dir = (i: number) => Math.atan2(p[i + 1].y - p[i].y, p[i + 1].x - p[i].x);
  for (let i = 1; i < p.length; i++) {
    const last = i === p.length - 1;
    let turn = 0;
    if (!last) {
      turn = Math.abs(dir(i) - dir(i - 1));
      if (turn > Math.PI) turn = 2 * Math.PI - turn;
    }
    if (last || turn > Math.PI / 180) {
      const seg = p.slice(start, i + 1);
      const len = seg.reduce((s, v, k) => (k ? s + dist(seg[k - 1], v) : 0), 0);
      if (len > eps) out.push({ pts: [seg[0], seg[seg.length - 1]], length: len, straight: true, dashed: op.dashed, layer: op.layer, ltype: op.ltype });
      start = i;
    }
  }
  return out;
}

/**
 * Линии гиба из незамкнутых линий внутри детали — с причиной для каждой (видно в карточке позиции):
 * прямая не короче ¼ меньшей стороны детали; отрезки на одной прямой — один гиб (линию разрезало отверстие);
 * линия, которая пересекает другие линии гиба, — ось или вспомогательная линия (гибы на развёртке не пересекаются).
 */
function classifyBends(inner: { op: OpenPath; host: PartGeom }[], eps: number): { bends: { path: OpenPath; src: OpenPath[] }[]; cands: BendCand[] } {
  const rejected: BendCand[] = [];
  type Cand = { host: PartGeom; a: Vec; b: Vec; len: number; src: OpenPath[]; op: OpenPath; merged: number };
  const cands: Cand[] = [];
  // ломаная из прямых (линии гиба, сошедшиеся в углу основания) — каждый прямой участок отдельно; src — исходная линия
  const pieces: { op: OpenPath; host: PartGeom; parent: OpenPath }[] = [];
  for (const it of inner) {
    if (it.op.straight || it.op.pts.length < 3) pieces.push({ ...it, parent: it.op });
    else for (const run of straightRuns(it.op, eps)) pieces.push({ op: run, host: it.host, parent: it.op });
  }
  for (const { op, host, parent } of pieces) {
    const w = host.outer.bbox.maxX - host.outer.bbox.minX;
    const h = host.outer.bbox.maxY - host.outer.bbox.minY;
    const minSide = Math.min(w, h);
    const minBend = Math.max(10, 0.25 * minSide);
    if (!op.straight) {
      if (op.length >= minBend) rejected.push({ pts: op.pts, length: op.length, bend: false, why: 'не прямая линия — гибом быть не может' });
      continue;
    }
    if (op.length < minBend) {
      if (op.length >= Math.max(5, 0.1 * minSide))
        rejected.push({ pts: op.pts, length: op.length, bend: false, why: `короче ¼ меньшей стороны детали (${fmt0(op.length)} < ${fmt0(minBend)} мм) — не гиб` });
      continue;
    }
    cands.push({ host, a: op.pts[0], b: op.pts[op.pts.length - 1], len: op.length, src: [parent], op, merged: 1 });
  }
  // отрезки на одной прямой в одной детали — один гиб
  const tolOff = Math.max(eps * 4, 0.2);
  for (let i = 0; i < cands.length; i++) {
    for (let j = i + 1; j < cands.length; j++) {
      const A = cands[i];
      const B = cands[j];
      if (A.host !== B.host) continue;
      const ux = (A.b.x - A.a.x) / dist(A.a, A.b);
      const uy = (A.b.y - A.a.y) / dist(A.a, A.b);
      const off = (p: Vec) => Math.abs((p.x - A.a.x) * uy - (p.y - A.a.y) * ux);
      if (off(B.a) > tolOff || off(B.b) > tolOff) continue;
      const ts = [A.a, A.b, B.a, B.b].map((p) => (p.x - A.a.x) * ux + (p.y - A.a.y) * uy);
      const t0 = Math.min(...ts);
      const t1 = Math.max(...ts);
      A.a = { x: A.a.x + ux * t0, y: A.a.y + uy * t0 };
      A.b = { x: A.a.x + ux * (t1 - t0), y: A.a.y + uy * (t1 - t0) };
      A.len = t1 - t0;
      A.src.push(...B.src);
      A.merged += B.merged;
      cands.splice(j, 1);
      j = i; // заново: продолжение могло стать ближе
    }
  }
  // линии, пересекающиеся в металле (в вырезе или отверстии — можно): убираем ту, что пересекает больше других
  const tolX = Math.max(1, eps * 20);
  const crossInMetal = (c: Cand, d: Cand) => {
    if (c.host !== d.host) return false;
    const x = crossPoint(c.a, c.b, d.a, d.b, tolX);
    return !!x && inside(x, c.host.outer.pts) && !c.host.holes.some((h) => inside(x, h.pts));
  };
  for (;;) {
    const counts = cands.map((c, i) => cands.reduce((n, d, j) => n + (i !== j && crossInMetal(c, d) ? 1 : 0), 0));
    const worst = counts.reduce((bi, n, i) => (n > counts[bi] ? i : bi), 0);
    if (!cands.length || counts[worst] === 0) break;
    const c = cands[worst];
    rejected.push({ pts: [c.a, c.b], length: c.len, bend: false, why: `пересекает ${counts[worst]} ${linesWord(counts[worst])} гиба — гибы не пересекаются: это ось или вспомогательная линия` });
    cands.splice(worst, 1);
  }
  const bends = cands.map((c) => {
    const tol = Math.max(1, eps * 20);
    const onEdge = [c.a, c.b].filter((p) => distToPoly(p, c.host.outer.pts) <= tol).length;
    const op = c.op;
    const parts = ['прямая', onEdge === 2 ? 'от края до края детали' : onEdge === 1 ? 'от края детали' : 'не доходит до краёв детали'];
    if (op.dashed) parts.push(`штриховая${op.ltype ? ` (${op.ltype})` : ''}`);
    else if (op.ltype && !/^(CONTINUOUS|BYLAYER|BYBLOCK|K5LT_BASIC.*)$/i.test(op.ltype)) parts.push(`тип линии ${op.ltype}`);
    if (op.layer && op.layer !== '0') parts.push(`слой «${op.layer}»`);
    if (c.merged > 1) parts.push(`${c.merged} отрезка на одной прямой — один гиб`);
    const path: OpenPath = { pts: [c.a, c.b], length: c.len, straight: true, dashed: op.dashed, layer: op.layer, ltype: op.ltype };
    return { path, src: c.src, why: parts.join(', ') };
  });
  const cand: BendCand[] = [
    ...bends.map((b) => ({ pts: b.path.pts, length: b.path.length, bend: true, why: b.why })),
    ...rejected.sort((x, y) => y.length - x.length).slice(0, 20),
  ];
  return { bends, cands: cand };
}

// Сводные метрики по выбранному набору деталей файла
export interface Metrics {
  count: number; // число контуров-деталей
  width: number; // габарит, мм (по наибольшей детали — для раскладки)
  height: number;
  bboxArea: number; // сумма габаритных площадей деталей, мм²
  netArea: number; // площадь металла (наружные минус отверстия), мм²
  cutLength: number; // общая длина реза, мм
  pierces: number; // число врезок (замкнутых контуров)
  holes: number;
  bendCount: number;
  bendMaxLen: number; // самая длинная линия гиба, мм
  bendLens: number[];
}

export function metricsOf(parts: PartGeom[], bends: OpenPath[], strayCutLength = 0): Metrics {
  let bboxArea = 0;
  let netArea = 0;
  let cut = strayCutLength;
  let pierces = 0;
  let holes = 0;
  let width = 0;
  let height = 0;
  for (const p of parts) {
    const w = p.outer.bbox.maxX - p.outer.bbox.minX;
    const h = p.outer.bbox.maxY - p.outer.bbox.minY;
    if (w * h > width * height) {
      width = w;
      height = h;
    }
    bboxArea += w * h;
    netArea += p.outer.area - p.holes.reduce((s, x) => s + x.area, 0);
    cut += p.outer.length + p.holes.reduce((s, x) => s + x.length, 0);
    pierces += 1 + p.holes.length;
    holes += p.holes.length;
  }
  const bendLens = bends.map((b) => b.length);
  return {
    count: parts.length,
    width,
    height,
    bboxArea,
    netArea,
    cutLength: cut,
    pierces,
    holes,
    bendCount: bends.length,
    bendMaxLen: bendLens.length ? Math.max(...bendLens) : 0,
    bendLens,
  };
}
