import { flattenPath } from './offset';
import { inkAlpha } from './svg';
import { inkWidth, penFor, type Pen } from '../scene/pens';
import type { Scene } from '../scene/types';

/**
 * A plot plan: the order the plotter draws a plotter-ready scene in, and how long that takes. Pens go in palette
 * order (the order of the SVG's pen layers), and within a pen the lines are sorted so the pen travels as little as
 * possible with the pen up, the way plotting software (vpype, the AxiDraw tools) sorts them. Each line can be
 * drawn from either end.
 */

/** How fast the machine moves. Starting values are typical of a desk plotter such as an AxiDraw at its default speeds. */
export interface PlotterSpeed {
  /** pen down, drawing, mm/s */
  drawMmS: number;
  /** pen up, moving between lines, mm/s */
  travelMmS: number;
  /** lifting the pen and putting it down again, s */
  liftS: number;
  /** stopping to change the pen, s */
  swapS: number;
}
export const DEFAULT_SPEED: PlotterSpeed = { drawMmS: 60, travelMmS: 200, liftS: 0.3, swapS: 60 };
export const SPEED_KEY = 'city-plot-plotter-speed';

export function loadSpeed(storage?: Pick<Storage, 'getItem'>): PlotterSpeed {
  try {
    const st = storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage);
    const raw = JSON.parse(st?.getItem(SPEED_KEY) ?? 'null') as Partial<PlotterSpeed> | null;
    const ok = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : d);
    return {
      drawMmS: ok(raw?.drawMmS, 1, 2000, DEFAULT_SPEED.drawMmS),
      travelMmS: ok(raw?.travelMmS, 1, 2000, DEFAULT_SPEED.travelMmS),
      liftS: ok(raw?.liftS, 0, 10, DEFAULT_SPEED.liftS),
      swapS: ok(raw?.swapS, 0, 3600, DEFAULT_SPEED.swapS),
    };
  } catch { return { ...DEFAULT_SPEED }; }
}
export function storeSpeed(s: PlotterSpeed, storage?: Pick<Storage, 'setItem'>): void {
  try { (storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage))?.setItem(SPEED_KEY, JSON.stringify(s)); } catch { /* blocked or full */ }
}

/** One pen-down line: its points as x, y pairs in mm, in drawing order, and when it is drawn (seconds from the start). */
export interface PlotStroke { pts: Float64Array; lenMm: number; t0: number; t1: number }
export interface PlotPen {
  pen: Pen;
  /** width of the ink line on paper, mm, and how strongly one pass shows */
  inkMm: number;
  alpha: number;
  strokes: PlotStroke[];
  /** when this pen starts (after the swap to it) and finishes, s */
  start: number;
  end: number;
}
export interface PlotPlan {
  pens: PlotPen[];
  totalS: number;
  drawMm: number;
  travelMm: number;
  lifts: number;
  swaps: number;
}

/** A line shorter than this is a dot; travel shorter than this is not a pen lift. */
const JOIN_MM = 0.05;
const CELL_MM = 10;

/** Lines in an order that keeps pen-up travel short: always the nearest unused line end next, found through a grid. */
export function sortStrokes(lines: Float64Array[], start: [number, number] = [0, 0]): Float64Array[] {
  const n = lines.length;
  if (n < 2) return lines;
  const grid = new Map<string, number[]>();
  const key = (x: number, y: number) => `${Math.floor(x / CELL_MM)},${Math.floor(y / CELL_MM)}`;
  // each line end is filed under its cell as 2*i (the start) or 2*i+1 (the end)
  const endAt = (e: number): [number, number] => {
    const l = lines[e >> 1]!;
    return e & 1 ? [l[l.length - 2]!, l[l.length - 1]!] : [l[0]!, l[1]!];
  };
  let minCx = Infinity, maxCx = -Infinity, minCy = Infinity, maxCy = -Infinity;
  for (let e = 0; e < 2 * n; e++) {
    const [x, y] = endAt(e);
    const k = key(x, y);
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(e);
    const cx = Math.floor(x / CELL_MM), cy = Math.floor(y / CELL_MM);
    minCx = Math.min(minCx, cx); maxCx = Math.max(maxCx, cx); minCy = Math.min(minCy, cy); maxCy = Math.max(maxCy, cy);
  }
  const used = new Uint8Array(n);
  const out: Float64Array[] = [];
  let [px, py] = start;
  const maxRing = Math.max(maxCx - minCx, maxCy - minCy) + 2 + Math.ceil((Math.abs(px) + Math.abs(py)) / CELL_MM);
  for (let k = 0; k < n; k++) {
    const cx = Math.floor(px / CELL_MM), cy = Math.floor(py / CELL_MM);
    let best = -1, bestD = Infinity;
    // search rings of cells outward until no closer end can be in a further ring
    for (let r = 0; r <= maxRing; r++) {
      if (best >= 0 && (r - 1) * CELL_MM > Math.sqrt(bestD)) break;
      // the cells on the ring's edge only: full rows at the top and bottom, the two side columns between
      for (let gy = cy - r; gy <= cy + r; gy++) {
        const edgeRow = gy === cy - r || gy === cy + r;
        for (let gx = cx - r; gx <= cx + r; gx += edgeRow || r === 0 ? 1 : 2 * r) {
          const bucket = grid.get(`${gx},${gy}`);
          if (!bucket) continue;
          for (let b = bucket.length - 1; b >= 0; b--) {
            const e = bucket[b]!;
            if (used[e >> 1]) { bucket[b] = bucket[bucket.length - 1]!; bucket.pop(); continue; }
            const [x, y] = endAt(e);
            const d = (x - px) ** 2 + (y - py) ** 2;
            if (d < bestD) { bestD = d; best = e; }
          }
        }
      }
    }
    if (best < 0) break;
    const i = best >> 1;
    used[i] = 1;
    const l = lines[i]!;
    // reached at its end: draw it backwards
    const line = best & 1 ? reversed(l) : l;
    out.push(line);
    px = line[line.length - 2]!;
    py = line[line.length - 1]!;
  }
  return out;
}

function reversed(l: Float64Array): Float64Array {
  const r = new Float64Array(l.length);
  for (let i = 0; i < l.length; i += 2) { r[l.length - 2 - i] = l[i]!; r[l.length - 1 - i] = l[i + 1]!; }
  return r;
}

const lengthOf = (l: Float64Array) => { let s = 0; for (let i = 2; i < l.length; i += 2) s += Math.hypot(l[i]! - l[i - 2]!, l[i + 1]! - l[i - 1]!); return s; };

/** The plan for a scene already prepared for the plotter (`prepareScene(…, 'plotter')`): every primitive is a stroke. */
export function planPlot(scene: Scene, pens: Pen[], speed: PlotterSpeed = DEFAULT_SPEED): PlotPlan {
  const byPen = new Map<string, Float64Array[]>();
  for (const p of scene.prims) {
    if (p.kind !== 'path' || p.mode !== 'stroke') continue;
    const id = penFor(pens, p.pen).id;
    const list = byPen.get(id) ?? byPen.set(id, []).get(id)!;
    for (const s of flattenPath(p.d)) {
      const pts = s.closed ? [...s.pts, s.pts[0]!] : s.pts;
      list.push(Float64Array.from(pts.flat()));
    }
  }
  let t = 0, drawMm = 0, travelMm = 0, lifts = 0, swaps = 0;
  let pos: [number, number] = [0, 0];
  const out: PlotPen[] = [];
  for (const pen of pens) {
    const lines = byPen.get(pen.id);
    if (!lines?.length) continue;
    if (out.length) { t += speed.swapS; swaps++; }
    const start = t;
    const strokes: PlotStroke[] = [];
    for (const pts of sortStrokes(lines, pos)) {
      const hop = Math.hypot(pts[0]! - pos[0], pts[1]! - pos[1]);
      if (hop > JOIN_MM || !strokes.length) {
        // lift, travel, put the pen down
        t += hop / speed.travelMmS + speed.liftS;
        travelMm += hop;
        lifts++;
      }
      const len = lengthOf(pts);
      strokes.push({ pts, lenMm: len, t0: t, t1: t + len / speed.drawMmS });
      t += len / speed.drawMmS;
      drawMm += len;
      pos = [pts[pts.length - 2]!, pts[pts.length - 1]!];
    }
    out.push({ pen, inkMm: inkWidth(pen), alpha: inkAlpha(pen), strokes, start, end: t });
  }
  // back to the corner it started from
  const home = Math.hypot(pos[0], pos[1]);
  if (out.length) { t += home / speed.travelMmS; travelMm += home; }
  return { pens: out, totalS: t, drawMm, travelMm, lifts, swaps };
}

/** "about 47 min", "about 2 h 05 min", "under a minute". */
export function formatDuration(s: number): string {
  if (s < 60) return 'under a minute';
  const m = Math.round(s / 60);
  if (m < 60) return `about ${m} min`;
  return `about ${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

/** "12:05" or "1:02:05" for a clock. */
export function formatClock(s: number): string {
  const v = Math.max(0, Math.round(s));
  const h = Math.floor(v / 3600), m = Math.floor((v % 3600) / 60), sec = v % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

/** "38 m", "820 mm" */
export const formatLength = (mm: number) => (mm >= 1000 ? `${(mm / 1000).toFixed(mm >= 10000 ? 0 : 1)} m` : `${Math.round(mm)} mm`);
