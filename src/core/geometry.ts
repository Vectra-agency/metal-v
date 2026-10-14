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
  stray: OpenPath[]; // незамкнутые обрывки (предупреждение)
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

function signedArea(pts: Vec[]): number {
  let s = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

function inside(p: Vec, poly: Vec[]): boolean {
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
      chains.push({ pts, length: p.length, closed: true, dashed: p.dashed });
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

  const findNext = (v: Vec, dashed: boolean): { idx: number; end: 0 | 1 } | null => {
    const cx = Math.floor(v.x / cell);
    const cy = Math.floor(v.y / cell);
    let best: { idx: number; end: 0 | 1 } | null = null;
    let bestD = eps;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const arr = grid.get(`${cx + dx},${cy + dy}`);
        if (!arr) continue;
        for (const c of arr) {
          if (used[c.idx]) continue;
          const p = open[c.idx];
          if (p.dashed !== dashed) continue;
          const q = c.end === 0 ? p.pts[0] : p.pts[p.pts.length - 1];
          const d = dist(q, v);
          if (d <= bestD) {
            bestD = d;
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
      const nx = findNext(pts[pts.length - 1], first.dashed);
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
        const nx = findNext(pts[0], first.dashed);
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
    chains.push({ pts, length, closed, dashed: first.dashed });
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

export function analyze(dwg: DxfDrawing): Analysis {
  const warnings: string[] = [];
  if (!dwg.prims.length) {
    return { parts: [], annotations: [], bends: [], stray: [], bbox: { minX: 0, minY: 0, maxX: 0, maxY: 0 }, warnings: ['В файле нет геометрии'] };
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
        openPaths.push({ pts: c.pts, length: c.length, straight: isStraight(c.pts, eps * 2), dashed: c.dashed });
        continue;
      }
      loops.push({ id: loops.length, pts: c.pts, length: c.length, area: a, bbox: boxOf(c.pts), parent: -1, depth: 0 });
    } else {
      openPaths.push({ pts: c.pts, length: c.length, straight: isStraight(c.pts, Math.max(eps * 2, 0.05)), dashed: c.dashed });
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
  const byId = new Map(loops.map((l) => [l.id, l]));
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

  // Открытые линии: прямые внутри детали — линии гиба; прочее — обрывки
  const bends: OpenPath[] = [];
  const stray: OpenPath[] = [];
  const annoLoops = loops.filter((l) => annotationRoots.has(l.id));
  for (const op of openPaths) {
    const mid = op.pts[Math.floor(op.pts.length / 2)];
    const a = op.pts[0];
    const b = op.pts[op.pts.length - 1];
    const midSeg = op.pts.length === 2 ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : mid;
    if (annoLoops.some((l) => inside(midSeg, l.pts))) continue; // внутри рамки — игнор
    const host = parts.find((pg) => pg.outer.depth === 0 && inside(midSeg, pg.outer.pts) && !pg.holes.some((h) => inside(midSeg, h.pts)));
    // линия гиба — прямая, заметной длины относительно детали
    const minBend = host ? Math.max(10, 0.25 * Math.min(host.outer.bbox.maxX - host.outer.bbox.minX, host.outer.bbox.maxY - host.outer.bbox.minY)) : Infinity;
    if (host && op.straight && op.length >= minBend) bends.push(op);
    else if (host) continue; // мелкий мусор внутри детали — не режется отдельно
    else if (op.length > eps * 10) stray.push(op);
  }
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
  return { parts, annotations, bends, stray, bbox, warnings };
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
