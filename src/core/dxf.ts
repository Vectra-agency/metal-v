// Минимальный парсер ASCII DXF (R12…2018) для задач раскроя.
// Отдаёт примитивы в мировых координатах уже «расплющенными» в полилинии
// с точной длиной, плюс позиции текстов (по ним отсеиваем рамки и штампы).

export interface Vec {
  x: number;
  y: number;
}

export interface Prim {
  pts: Vec[]; // аппроксимация для площади/отрисовки
  length: number; // длина реза, мм (дуги — аналитически)
  closed: boolean;
  kind: string; // LINE / ARC / CIRCLE / LWPOLYLINE / SPLINE …
  layer: string;
  dashed: boolean;
}

export interface DxfDrawing {
  prims: Prim[];
  texts: Vec[];
  version: string;
  insUnits: number; // $INSUNITS: 4 = мм, 1 = дюймы, 0 = не задано
  warnings: string[];
}

type Pair = [number, string];

interface Rec {
  type: string;
  pairs: Pair[];
  children?: Rec[]; // VERTEX у POLYLINE
}

interface Block {
  name: string;
  base: Vec;
  ents: Rec[];
}

interface LayerInfo {
  ltype: string;
  visible: boolean;
}

// 2D-аффинное преобразование: x' = a*x + c*y + e, y' = b*x + d*y + f
interface Mat {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

const IDENTITY: Mat = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
const ARC_TOL = 0.02; // допустимая стрелка прогиба хорды, мм

function mul(m: Mat, n: Mat): Mat {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  };
}

function apply(m: Mat, p: Vec): Vec {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
}

// Масштаб длины для преобразования (для дуг; при неравномерном масштабе — среднее)
function lenScale(m: Mat): number {
  const sx = Math.hypot(m.a, m.b);
  const sy = Math.hypot(m.c, m.d);
  return (sx + sy) / 2;
}

// ---------- чтение текста ----------

export function decodeDxf(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 22));
  if (head.startsWith('AutoCAD Binary DXF')) {
    throw new Error('Бинарный DXF не поддерживается — пересохраните файл как ASCII DXF');
  }
  // Версия и кодовая страница лежат в начале HEADER
  const probe = new TextDecoder('latin1').decode(bytes.subarray(0, 4096));
  const ver = /\$ACADVER\s*\r?\n\s*1\s*\r?\n\s*(AC\d+)/.exec(probe)?.[1] ?? 'AC1009';
  const cp = /\$DWGCODEPAGE\s*\r?\n\s*3\s*\r?\n\s*(\S+)/.exec(probe)?.[1] ?? '';
  let enc = 'windows-1251';
  if (Number(ver.slice(2)) >= 1021) enc = 'utf-8';
  else if (/ANSI_1252/i.test(cp)) enc = 'windows-1252';
  try {
    return new TextDecoder(enc).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function toPairs(text: string): Pair[] {
  const lines = text.split(/\r\n|\r|\n/);
  const out: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    if (Number.isNaN(code)) continue;
    out.push([code, lines[i + 1].trim()]);
  }
  return out;
}

// Разбивает поток пар на записи по коду 0
function toRecords(pairs: Pair[]): Rec[] {
  const recs: Rec[] = [];
  let cur: Rec | null = null;
  for (const p of pairs) {
    if (p[0] === 0) {
      cur = { type: p[1], pairs: [] };
      recs.push(cur);
    } else if (cur) cur.pairs.push(p);
  }
  return recs;
}

function num(r: Rec, code: number, def = 0): number {
  for (const p of r.pairs) if (p[0] === code) return parseFloat(p[1]);
  return def;
}

function str(r: Rec, code: number, def = ''): string {
  for (const p of r.pairs) if (p[0] === code) return p[1];
  return def;
}

function extrusionZ(r: Rec): number {
  return num(r, 230, 1);
}

// ---------- разбор секций ----------

interface Parsed {
  header: Map<string, string>;
  layers: Map<string, LayerInfo>;
  dashedLtypes: Set<string>;
  blocks: Map<string, Block>;
  entities: Rec[];
}

function groupPolylines(recs: Rec[]): Rec[] {
  const out: Rec[] = [];
  let poly: Rec | null = null;
  for (const r of recs) {
    if (poly) {
      if (r.type === 'VERTEX') {
        poly.children!.push(r);
        continue;
      }
      poly = null; // SEQEND или что угодно ещё закрывает POLYLINE
      if (r.type === 'SEQEND') continue;
    }
    if (r.type === 'POLYLINE') {
      poly = { ...r, children: [] };
      out.push(poly);
      continue;
    }
    if (r.type === 'SEQEND') continue;
    out.push(r);
  }
  return out;
}

function parse(text: string): Parsed {
  const recs = toRecords(toPairs(text));
  const header = new Map<string, string>();
  const layers = new Map<string, LayerInfo>();
  const dashedLtypes = new Set<string>();
  const blocks = new Map<string, Block>();
  let entities: Rec[] = [];

  let i = 0;
  while (i < recs.length) {
    const r = recs[i];
    if (r.type !== 'SECTION') {
      i++;
      continue;
    }
    const name = str(r, 2);
    const body: Rec[] = [];
    i++;
    while (i < recs.length && recs[i].type !== 'ENDSEC') body.push(recs[i++]);
    i++;

    if (name === 'HEADER') {
      // в HEADER всё лежит в одной «записи»: пары 9 / значение
      const pairs = r.pairs;
      for (let k = 0; k < pairs.length; k++) {
        if (pairs[k][0] === 9 && k + 1 < pairs.length) header.set(pairs[k][1], pairs[k + 1][1]);
      }
    } else if (name === 'TABLES') {
      for (const t of body) {
        if (t.type === 'LAYER') {
          const color = num(t, 62, 7);
          const flags = num(t, 70, 0);
          layers.set(str(t, 2), { ltype: str(t, 6, 'CONTINUOUS'), visible: color >= 0 && (flags & 1) === 0 });
        } else if (t.type === 'LTYPE') {
          const dashes = t.pairs.filter((p) => p[0] === 49).map((p) => parseFloat(p[1]));
          if (dashes.some((d) => d < 0)) dashedLtypes.add(str(t, 2).toUpperCase());
        }
      }
    } else if (name === 'BLOCKS') {
      let cur: Block | null = null;
      let ents: Rec[] = [];
      for (const b of body) {
        if (b.type === 'BLOCK') {
          cur = { name: str(b, 2), base: { x: num(b, 10), y: num(b, 20) }, ents: [] };
          ents = [];
        } else if (b.type === 'ENDBLK') {
          if (cur) {
            cur.ents = groupPolylines(ents);
            blocks.set(cur.name, cur);
          }
          cur = null;
        } else if (cur) ents.push(b);
      }
    } else if (name === 'ENTITIES') {
      entities = groupPolylines(body);
    }
  }
  return { header, layers, dashedLtypes, blocks, entities };
}

// ---------- геометрия примитивов ----------

function arcPoints(cx: number, cy: number, r: number, a0: number, sweep: number, scale: number): Vec[] {
  // a0, sweep — в радианах; sweep может быть отрицательным
  const rr = Math.max(r * scale, 1e-9);
  const step = rr > ARC_TOL ? 2 * Math.acos(1 - ARC_TOL / rr) : Math.PI / 4;
  const n = Math.min(2000, Math.max(2, Math.ceil(Math.abs(sweep) / Math.max(step, 1e-4))));
  const pts: Vec[] = [];
  for (let k = 0; k <= n; k++) {
    const a = a0 + (sweep * k) / n;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

// Вершины полилинии с «выпуклостью» (bulge) → точки и длина
function bulgePath(verts: { p: Vec; bulge: number }[], closed: boolean, scale: number): { pts: Vec[]; len: number } {
  const pts: Vec[] = [];
  let len = 0;
  const n = verts.length;
  if (!n) return { pts, len };
  const segs = closed ? n : n - 1;
  pts.push(verts[0].p);
  for (let k = 0; k < segs; k++) {
    const p1 = verts[k].p;
    const p2 = verts[(k + 1) % n].p;
    const b = verts[k].bulge;
    const chord = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    if (Math.abs(b) < 1e-9 || chord < 1e-12) {
      pts.push(p2);
      len += chord;
      continue;
    }
    const theta = 4 * Math.atan(b); // центральный угол со знаком
    const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
    // центр: от середины хорды по нормали
    const mx = (p1.x + p2.x) / 2;
    const my = (p1.y + p2.y) / 2;
    const h = r * Math.cos(Math.abs(theta) / 2);
    const ux = (p2.x - p1.x) / chord;
    const uy = (p2.y - p1.y) / chord;
    const sgn = b > 0 ? 1 : -1;
    const cx = mx - sgn * uy * h;
    const cy = my + sgn * ux * h;
    const a0 = Math.atan2(p1.y - cy, p1.x - cx);
    const arc = arcPoints(cx, cy, r, a0, theta, scale);
    arc[arc.length - 1] = p2;
    for (let j = 1; j < arc.length; j++) pts.push(arc[j]);
    len += r * Math.abs(theta);
  }
  return { pts, len };
}

function nurbs(degree: number, knots: number[], ctrl: Vec[], weights: number[], samples: number): Vec[] {
  const n = ctrl.length;
  const p = degree;
  if (knots.length !== n + p + 1) {
    // равномерные зажатые узлы как запасной вариант
    knots = [];
    for (let k = 0; k <= p; k++) knots.push(0);
    for (let k = 1; k < n - p; k++) knots.push(k);
    for (let k = 0; k <= p; k++) knots.push(Math.max(1, n - p));
  }
  const w = weights.length === n ? weights : ctrl.map(() => 1);
  const t0 = knots[p];
  const t1 = knots[n];
  const out: Vec[] = [];
  for (let s = 0; s <= samples; s++) {
    let t = t0 + ((t1 - t0) * s) / samples;
    if (s === samples) t = t1 - 1e-10 * (t1 - t0 || 1);
    // поиск интервала
    let k = p;
    while (k < n - 1 && t >= knots[k + 1]) k++;
    // де Бур в однородных координатах
    const d: { x: number; y: number; w: number }[] = [];
    for (let j = 0; j <= p; j++) {
      const idx = Math.min(Math.max(j + k - p, 0), n - 1);
      d.push({ x: ctrl[idx].x * w[idx], y: ctrl[idx].y * w[idx], w: w[idx] });
    }
    for (let r = 1; r <= p; r++) {
      for (let j = p; j >= r; j--) {
        const i = j + k - p;
        const den = knots[i + p - r + 1] - knots[i];
        const alpha = den === 0 ? 0 : (t - knots[i]) / den;
        d[j] = {
          x: (1 - alpha) * d[j - 1].x + alpha * d[j].x,
          y: (1 - alpha) * d[j - 1].y + alpha * d[j].y,
          w: (1 - alpha) * d[j - 1].w + alpha * d[j].w,
        };
      }
    }
    out.push({ x: d[p].x / d[p].w, y: d[p].y / d[p].w });
  }
  return out;
}

function polyLen(pts: Vec[]): number {
  let l = 0;
  for (let k = 1; k < pts.length; k++) l += Math.hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y);
  return l;
}

// ---------- обход сущностей ----------

const SKIP = new Set([
  'DIMENSION', 'HATCH', 'SOLID', 'POINT', 'ATTRIB', 'ATTDEF', 'LEADER', 'MLEADER', 'MULTILEADER',
  'VIEWPORT', 'IMAGE', 'WIPEOUT', '3DFACE', 'REGION', '3DSOLID', 'BODY', 'TOLERANCE', 'OLE2FRAME',
  'XLINE', 'RAY', 'TRACE', 'MESH', 'SURFACE',
]);

export function parseDxf(buf: ArrayBuffer): DxfDrawing {
  const text = decodeDxf(buf);
  const P = parse(text);
  const prims: Prim[] = [];
  const texts: Vec[] = [];
  const warnings: string[] = [];
  const unknown = new Set<string>();
  const insUnits = parseInt(P.header.get('$INSUNITS') ?? '0', 10) || 0;

  const isDashed = (lt: string) => P.dashedLtypes.has(lt.toUpperCase());

  const walk = (ents: Rec[], M: Mat, parentLayer: string, parentLt: string, depth: number) => {
    if (depth > 12) return;
    for (const e of ents) {
      if (num(e, 67, 0) === 1) continue; // пространство листа
      let layer = str(e, 8, '0');
      if (layer === '0' && depth > 0) layer = parentLayer;
      const li = P.layers.get(layer);
      if (li && !li.visible) continue;
      if (/^defpoints$/i.test(layer)) continue;
      let lt = str(e, 6, 'BYLAYER');
      if (/^bylayer$/i.test(lt)) lt = li?.ltype ?? 'CONTINUOUS';
      else if (/^byblock$/i.test(lt)) lt = parentLt;
      const dashed = isDashed(lt);
      const ez = extrusionZ(e);
      // OCS с осью -Z: зеркалим X
      const O: Mat = ez < 0 ? mul(M, { a: -1, b: 0, c: 0, d: 1, e: 0, f: 0 }) : M;
      const sc = lenScale(M);
      const push = (kind: string, pts: Vec[], length: number, closed: boolean, m: Mat) => {
        prims.push({ kind, pts: pts.map((p) => apply(m, p)), length: length * sc, closed, layer, dashed });
      };

      switch (e.type) {
        case 'LINE': {
          const a = { x: num(e, 10), y: num(e, 20) };
          const b = { x: num(e, 11), y: num(e, 21) };
          const l = Math.hypot(b.x - a.x, b.y - a.y);
          if (l > 1e-9) push('LINE', [a, b], l, false, M);
          break;
        }
        case 'CIRCLE': {
          const r = num(e, 40);
          if (r <= 0) break;
          const pts = arcPoints(num(e, 10), num(e, 20), r, 0, 2 * Math.PI, sc);
          pts[pts.length - 1] = pts[0];
          push('CIRCLE', pts, 2 * Math.PI * r, true, O);
          break;
        }
        case 'ARC': {
          const r = num(e, 40);
          const a0 = (num(e, 50) * Math.PI) / 180;
          let a1 = (num(e, 51) * Math.PI) / 180;
          while (a1 <= a0) a1 += 2 * Math.PI;
          const sweep = a1 - a0;
          if (r <= 0) break;
          push('ARC', arcPoints(num(e, 10), num(e, 20), r, a0, sweep, sc), r * sweep, false, O);
          break;
        }
        case 'ELLIPSE': {
          // ELLIPSE задан в МСК; ось малая = Z × большая
          const c = { x: num(e, 10), y: num(e, 20) };
          const mj = { x: num(e, 11), y: num(e, 21) };
          const ratio = num(e, 40, 1);
          let t0 = num(e, 41, 0);
          let t1 = num(e, 42, 2 * Math.PI);
          while (t1 <= t0) t1 += 2 * Math.PI;
          const s = ez < 0 ? -1 : 1;
          const mn = { x: -mj.y * ratio * s, y: mj.x * ratio * s };
          const n = Math.max(16, Math.ceil(((t1 - t0) / (2 * Math.PI)) * 256));
          const pts: Vec[] = [];
          for (let k = 0; k <= n; k++) {
            const t = t0 + ((t1 - t0) * k) / n;
            pts.push({ x: c.x + mj.x * Math.cos(t) + mn.x * Math.sin(t), y: c.y + mj.y * Math.cos(t) + mn.y * Math.sin(t) });
          }
          const full = Math.abs(t1 - t0 - 2 * Math.PI) < 1e-6;
          if (full) pts[pts.length - 1] = pts[0];
          push('ELLIPSE', pts, polyLen(pts), full, M);
          break;
        }
        case 'LWPOLYLINE': {
          const verts: { p: Vec; bulge: number }[] = [];
          for (const [code, val] of e.pairs) {
            if (code === 10) verts.push({ p: { x: parseFloat(val), y: 0 }, bulge: 0 });
            else if (code === 20 && verts.length) verts[verts.length - 1].p.y = parseFloat(val);
            else if (code === 42 && verts.length) verts[verts.length - 1].bulge = parseFloat(val);
          }
          const closed = (num(e, 70) & 1) === 1;
          const { pts, len } = bulgePath(verts, closed, sc);
          if (pts.length > 1) push('LWPOLYLINE', pts, len, closed, O);
          break;
        }
        case 'POLYLINE': {
          const flags = num(e, 70);
          if (flags & (16 | 64)) break; // сети и многогранники
          const verts: { p: Vec; bulge: number }[] = [];
          for (const v of e.children ?? []) {
            const vf = num(v, 70);
            if (vf & 16) continue; // управляющие точки сплайна
            verts.push({ p: { x: num(v, 10), y: num(v, 20) }, bulge: num(v, 42) });
          }
          const closed = (flags & 1) === 1;
          const { pts, len } = bulgePath(verts, closed, sc);
          if (pts.length > 1) push('POLYLINE', pts, len, closed, flags & 8 ? M : O);
          break;
        }
        case 'SPLINE': {
          const degree = num(e, 71, 3);
          const knots: number[] = [];
          const ctrl: Vec[] = [];
          const fit: Vec[] = [];
          const weights: number[] = [];
          for (const [code, val] of e.pairs) {
            const v = parseFloat(val);
            if (code === 40) knots.push(v);
            else if (code === 41) weights.push(v);
            else if (code === 10) ctrl.push({ x: v, y: 0 });
            else if (code === 20 && ctrl.length) ctrl[ctrl.length - 1].y = v;
            else if (code === 11) fit.push({ x: v, y: 0 });
            else if (code === 21 && fit.length) fit[fit.length - 1].y = v;
          }
          let pts: Vec[];
          if (ctrl.length > degree) pts = nurbs(degree, knots, ctrl, weights, Math.min(4000, Math.max(64, ctrl.length * 24)));
          else if (fit.length > 1) pts = fit;
          else break;
          const closed = (num(e, 70) & 1) === 1 || Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) < 1e-6;
          if (closed) pts[pts.length - 1] = pts[0];
          push('SPLINE', pts, polyLen(pts), closed, M);
          break;
        }
        case 'TEXT':
        case 'MTEXT': {
          texts.push(apply(M, { x: num(e, 10), y: num(e, 20) }));
          break;
        }
        case 'INSERT': {
          const blk = P.blocks.get(str(e, 2));
          if (!blk) break;
          const ins = { x: num(e, 10), y: num(e, 20) };
          const sx = num(e, 41, 1);
          const sy = num(e, 42, 1);
          const rot = (num(e, 50) * Math.PI) / 180;
          const cols = Math.max(1, num(e, 70, 1));
          const rows = Math.max(1, num(e, 71, 1));
          const dx = num(e, 44);
          const dy = num(e, 45);
          const cs = Math.cos(rot);
          const sn = Math.sin(rot);
          for (let ci = 0; ci < cols; ci++) {
            for (let ri = 0; ri < rows; ri++) {
              // локальное смещение массива в повёрнутой системе вставки
              const ox = ci * dx;
              const oy = ri * dy;
              const T: Mat = {
                a: cs * sx,
                b: sn * sx,
                c: -sn * sy,
                d: cs * sy,
                e: ins.x + cs * ox - sn * oy,
                f: ins.y + sn * ox + cs * oy,
              };
              const B: Mat = { a: 1, b: 0, c: 0, d: 1, e: -blk.base.x, f: -blk.base.y };
              let L = mul(T, B);
              if (ez < 0) L = mul({ a: -1, b: 0, c: 0, d: 1, e: 0, f: 0 }, L);
              walk(blk.ents, mul(M, L), layer, lt, depth + 1);
            }
          }
          break;
        }
        default:
          if (!SKIP.has(e.type)) unknown.add(e.type);
      }
    }
  };

  walk(P.entities, IDENTITY, '0', 'CONTINUOUS', 0);
  if (unknown.size) warnings.push('Пропущены неподдерживаемые объекты: ' + [...unknown].join(', '));
  if (insUnits === 1) {
    // дюймы → мм
    for (const p of prims) {
      p.pts = p.pts.map((v) => ({ x: v.x * 25.4, y: v.y * 25.4 }));
      p.length *= 25.4;
    }
    for (const t of texts) {
      t.x *= 25.4;
      t.y *= 25.4;
    }
    warnings.push('Чертёж в дюймах — пересчитан в мм');
  }
  return { prims, texts, version: P.header.get('$ACADVER') ?? '?', insUnits, warnings };
}
