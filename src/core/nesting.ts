// Оценка раскроя: укладка габаритных прямоугольников деталей на листы
// алгоритмом MaxRects (Best Short Side Fit) с поворотом на 90°.
// Это оценка «сверху»: реальный раскрой по контуру даёт меньше отхода.

export interface NestItem {
  key: string; // идентификатор позиции
  w: number;
  h: number;
  qty: number;
}

export interface Placed {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotated: boolean;
}

export interface Sheet {
  placed: Placed[];
  usedLength: number; // занятая длина листа по длинной стороне, мм
  usedWidth: number; // занятая ширина, мм
}

export interface NestResult {
  sheetW: number; // длинная сторона
  sheetH: number;
  sheets: Sheet[];
  unplaced: { key: string; qty: number; w: number; h: number }[]; // не влезли в лист
  sheetsFractional: number; // полные листы + доля последнего (занятый прямоугольник)
  utilization: number; // площадь деталей (габариты) / площадь использованных листов
  truncated: boolean; // слишком много деталей — укладку посчитали по образцу
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const MAX_SIM = 4000; // предел числа укладываемых прямоугольников

class MaxRectsBin {
  free: Rect[];
  placed: Placed[] = [];
  W: number;
  H: number;
  constructor(W: number, H: number) {
    this.W = W;
    this.H = H;
    this.free = [{ x: 0, y: 0, w: W, h: H }];
  }

  find(w: number, h: number): { r: Rect; rot: boolean } | null {
    let best: { r: Rect; rot: boolean } | null = null;
    let bestShort = Infinity;
    let bestLong = Infinity;
    let bestX = Infinity;
    for (const f of this.free) {
      for (const rot of [false, true]) {
        const pw = rot ? h : w;
        const ph = rot ? w : h;
        if (pw > f.w + 1e-9 || ph > f.h + 1e-9) continue;
        const ls = Math.min(f.w - pw, f.h - ph);
        const ll = Math.max(f.w - pw, f.h - ph);
        // при равенстве — ближе к началу листа (экономим длину)
        if (ls < bestShort - 1e-9 || (Math.abs(ls - bestShort) < 1e-9 && (f.x < bestX - 1e-9 || (Math.abs(f.x - bestX) < 1e-9 && ll < bestLong)))) {
          bestShort = ls;
          bestLong = ll;
          bestX = f.x;
          best = { r: { x: f.x, y: f.y, w: pw, h: ph }, rot };
        }
      }
    }
    return best;
  }

  place(r: Rect) {
    const next: Rect[] = [];
    for (const f of this.free) {
      if (r.x >= f.x + f.w || r.x + r.w <= f.x || r.y >= f.y + f.h || r.y + r.h <= f.y) {
        next.push(f);
        continue;
      }
      if (r.x > f.x) next.push({ x: f.x, y: f.y, w: r.x - f.x, h: f.h });
      if (r.x + r.w < f.x + f.w) next.push({ x: r.x + r.w, y: f.y, w: f.x + f.w - r.x - r.w, h: f.h });
      if (r.y > f.y) next.push({ x: f.x, y: f.y, w: f.w, h: r.y - f.y });
      if (r.y + r.h < f.y + f.h) next.push({ x: f.x, y: r.y + r.h, w: f.w, h: f.y + f.h - r.y - r.h });
    }
    // убираем вложенные свободные прямоугольники
    next.sort((a, b) => b.w * b.h - a.w * a.h);
    const pruned: Rect[] = [];
    for (const a of next) {
      if (a.w < 1 || a.h < 1) continue;
      if (pruned.some((b) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h)) continue;
      pruned.push(a);
    }
    this.free = pruned;
  }
}

export interface NestOptions {
  sheetW: number;
  sheetH: number;
  gap: number; // перемычка между деталями, мм
  margin: number; // отступ от края листа, мм
}

export function nest(items: NestItem[], o: NestOptions): NestResult {
  const L = Math.max(o.sheetW, o.sheetH);
  const S = Math.min(o.sheetW, o.sheetH);
  // рабочее поле: минус поля, плюс одна перемычка (её «съедает» последняя деталь)
  const UW = L - 2 * o.margin + o.gap;
  const UH = S - 2 * o.margin + o.gap;

  const unplaced: NestResult['unplaced'] = [];
  const queue: { key: string; w: number; h: number }[] = [];
  let totalQty = 0;
  for (const it of items) totalQty += it.qty;
  // при огромных количествах укладываем пропорциональную выборку и масштабируем
  const scale = totalQty > MAX_SIM ? MAX_SIM / totalQty : 1;
  for (const it of items) {
    const w = it.w + o.gap;
    const h = it.h + o.gap;
    const fits = (w <= UW && h <= UH) || (h <= UW && w <= UH);
    if (!fits) {
      unplaced.push({ key: it.key, qty: it.qty, w: it.w, h: it.h });
      continue;
    }
    const n = scale < 1 ? Math.max(1, Math.round(it.qty * scale)) : it.qty;
    for (let k = 0; k < n; k++) queue.push({ key: it.key, w, h });
  }
  // крупные первыми
  queue.sort((a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h) || b.w * b.h - a.w * a.h);

  const bins: MaxRectsBin[] = [];
  for (const q of queue) {
    let done = false;
    for (const b of bins) {
      const f = b.find(q.w, q.h);
      if (f) {
        b.place(f.r);
        b.placed.push({ key: q.key, x: f.r.x, y: f.r.y, w: f.r.w, h: f.r.h, rotated: f.rot });
        done = true;
        break;
      }
    }
    if (!done) {
      const b = new MaxRectsBin(UW, UH);
      const f = b.find(q.w, q.h)!;
      b.place(f.r);
      b.placed.push({ key: q.key, x: f.r.x, y: f.r.y, w: f.r.w, h: f.r.h, rotated: f.rot });
      bins.push(b);
    }
  }

  const sheets: Sheet[] = bins.map((b) => ({
    // обратно в координаты листа, без перемычки
    placed: b.placed.map((p) => ({ ...p, x: p.x + o.margin, y: p.y + o.margin, w: p.w - o.gap, h: p.h - o.gap })),
    usedLength: Math.min(L, Math.max(0, ...b.placed.map((p) => p.x + p.w)) - o.gap + 2 * o.margin),
    usedWidth: Math.min(S, Math.max(0, ...b.placed.map((p) => p.y + p.h)) - o.gap + 2 * o.margin),
  }));

  // последний лист — по занятому прямоугольнику (остаток остаётся деловым)
  let frac = 0;
  if (sheets.length) {
    const last = sheets[sheets.length - 1];
    frac = sheets.length - 1 + (last.usedLength * last.usedWidth) / (L * S);
  }
  if (scale < 1) frac /= scale;
  const partsArea = queue.reduce((s, q) => s + (q.w - o.gap) * (q.h - o.gap), 0) / (scale < 1 ? scale : 1);
  const utilization = frac > 0 ? partsArea / (frac * L * S) : 0;
  return { sheetW: L, sheetH: S, sheets, unplaced, sheetsFractional: frac, utilization, truncated: scale < 1 };
}
