import { clipPolylineConvex, clipPolyline, simplifyXY, type Rect, type XY } from '../geo/clip';
import type { Fit } from '../geo/project';
import type { LayerData, WaterlineStyle } from './types';

/**
 * Waterlines: lines inside the water that follow the shore at growing distances, the way engraved charts drew
 * the sea. They are contours of the distance from land, worked out on a fine grid over the frame:
 *
 * 1. every water area is filled into the grid (non-zero winding, so islands stay land and the pieces a tile edge
 *    cut an area into join up again without a seam);
 * 2. each water cell gets its exact distance to the nearest land cell (Felzenszwalb's distance transform);
 * 3. the lines are traced where that distance equals each level (marching squares), smoothed and simplified.
 *
 * Ground beyond what the data covers counts as water, so the edge of the fetched area is never taken for a shore.
 */

/** Grid cell size: fine enough that the lines are smooth under a 0.3 mm pen, capped so a big poster stays quick. */
const MIN_CELL_MM = 0.2;
const MAX_CELLS = 5_000_000;
const SIMPLIFY_MM = 0.03;

/** The distances (mm from the shore) the lines are drawn at: the first gap, then each gap `widen` wider than the one before. */
export function waterlineLevels(s: WaterlineStyle): number[] {
  const out: number[] = [];
  let d = 0;
  let gap = Math.max(0.2, s.gapMm);
  for (let k = 0; k < Math.min(30, Math.max(0, Math.round(s.count))); k++) {
    d += gap;
    out.push(+d.toFixed(4));
    gap *= 1 + Math.max(0, s.widen);
  }
  return out;
}

interface Grid { x0: number; y0: number; cell: number; w: number; h: number }

/** Mark the cells whose centers are inside the rings (non-zero winding), OR-ed into `mask`. */
function fillRings(mask: Uint8Array, g: Grid, rings: XY[][]) {
  const rows: number[][] = Array.from({ length: g.h }, () => []);
  for (const r of rings) {
    for (let i = 0; i < r.length; i++) {
      const [ax, ay] = r[i]!;
      const [bx, by] = r[(i + 1) % r.length]!;
      if (ay === by) continue;
      const dir = by > ay ? 1 : -1;
      const [lo, hi] = ay < by ? [ay, by] : [by, ay];
      // rows whose center line y is in [lo, hi)
      const j0 = Math.max(0, Math.ceil((lo - g.y0) / g.cell - 0.5));
      const j1 = Math.min(g.h - 1, Math.ceil((hi - g.y0) / g.cell - 0.5) - 1);
      for (let j = j0; j <= j1; j++) {
        const y = g.y0 + (j + 0.5) * g.cell;
        rows[j]!.push(ax + ((y - ay) / (by - ay)) * (bx - ax), dir);
      }
    }
  }
  for (let j = 0; j < g.h; j++) {
    const row = rows[j]!;
    if (!row.length) continue;
    const xs: { x: number; d: number }[] = [];
    for (let k = 0; k < row.length; k += 2) xs.push({ x: row[k]!, d: row[k + 1]! });
    xs.sort((a, b) => a.x - b.x);
    let wind = 0;
    for (let k = 0; k < xs.length - 1; k++) {
      wind += xs[k]!.d;
      if (!wind) continue;
      const i0 = Math.max(0, Math.ceil((xs[k]!.x - g.x0) / g.cell - 0.5));
      const i1 = Math.min(g.w - 1, Math.ceil((xs[k + 1]!.x - g.x0) / g.cell - 0.5) - 1);
      for (let i = i0; i <= i1; i++) mask[j * g.w + i] = 1;
    }
  }
}

const INF = 1e20;

/** One line of Felzenszwalb & Huttenlocher's squared distance transform, in place on f[off + k*stride]. */
function edt1d(f: Float32Array, off: number, stride: number, n: number, d: Float64Array, v: Int32Array, z: Float64Array, tmp: Float64Array) {
  for (let q = 0; q < n; q++) tmp[q] = f[off + q * stride]!;
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (tmp[q]! + q * q - (tmp[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    while (s <= z[k]!) {
      k--;
      s = (tmp[q]! + q * q - (tmp[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    const p = v[k]!;
    d[q] = (q - p) * (q - p) + tmp[p]!;
  }
  for (let q = 0; q < n; q++) f[off + q * stride] = d[q]!;
}

/** Squared distance (in cells) from every cell to the nearest land cell (mask 0); land cells are 0. */
function distanceField(mask: Uint8Array, w: number, h: number): Float32Array {
  const f = new Float32Array(w * h);
  for (let i = 0; i < f.length; i++) f[i] = mask[i] ? INF : 0;
  const n = Math.max(w, h) + 1;
  const d = new Float64Array(n), z = new Float64Array(n + 1), tmp = new Float64Array(n);
  const v = new Int32Array(n);
  for (let i = 0; i < w; i++) edt1d(f, i, w, h, d, v, z, tmp);
  for (let j = 0; j < h; j++) edt1d(f, j * w, 1, w, d, v, z, tmp);
  return f;
}

/** Marching-squares cases: which square edges (0 top, 1 right, 2 bottom, 3 left) each segment joins. Corner bits: TL 8, TR 4, BR 2, BL 1. */
const CASES: Record<number, number[][]> = {
  1: [[3, 2]], 2: [[2, 1]], 3: [[3, 1]], 4: [[0, 1]], 6: [[0, 2]], 7: [[3, 0]], 8: [[3, 0]], 9: [[0, 2]],
  11: [[0, 1]], 12: [[3, 1]], 13: [[2, 1]], 14: [[3, 2]],
};
const SADDLE: Record<number, [number[][], number[][]]> = {
  // [center above the level, center below]
  5: [[[3, 0], [2, 1]], [[0, 1], [3, 2]]],
  10: [[[0, 1], [3, 2]], [[3, 0], [2, 1]]],
};

/** The lines where `field` equals each level, as polylines in mm (closed ones end where they start). */
function contours(field: Float32Array, g: Grid, levels: number[]): XY[][] {
  const { w, h, cell } = g;
  const out: XY[][] = [];
  const minL = levels[0]!, maxL = levels[levels.length - 1]!;
  // only squares that some level crosses: most of the grid is land or open water far from any shore
  const cand: number[] = [];
  for (let j = 0; j < h - 1; j++) {
    for (let i = 0; i < w - 1; i++) {
      const k = j * w + i;
      const tl = field[k]!, tr = field[k + 1]!, bl = field[k + w]!, br = field[k + w + 1]!;
      if (Math.max(tl, tr, bl, br) >= minL && Math.min(tl, tr, bl, br) < maxL) cand.push(k);
    }
  }
  for (const L of levels) {
    // each crossing point is one slot: its position and up to two neighbours along the line
    const slotOf = new Map<number, number>();
    const px: number[] = [], py: number[] = [], nb: number[] = [];
    const slot = (id: number, x: number, y: number): number => {
      let s = slotOf.get(id);
      if (s === undefined) { s = px.length; slotOf.set(id, s); px.push(x); py.push(y); nb.push(-1, -1); }
      return s;
    };
    const link = (a: number, b: number) => {
      nb[2 * a] === -1 ? (nb[2 * a] = b) : (nb[2 * a + 1] = b);
      nb[2 * b] === -1 ? (nb[2 * b] = a) : (nb[2 * b + 1] = a);
    };
    for (const k of cand) {
      const tl = field[k]!, tr = field[k + 1]!, bl = field[k + w]!, br = field[k + w + 1]!;
      const c = (tl >= L ? 8 : 0) | (tr >= L ? 4 : 0) | (br >= L ? 2 : 0) | (bl >= L ? 1 : 0);
      if (c === 0 || c === 15) continue;
      const segs = SADDLE[c] ? SADDLE[c]![(tl + tr + bl + br) / 4 >= L ? 0 : 1] : CASES[c]!;
      const i = k % w, j = (k - i) / w;
      const x = g.x0 + (i + 0.5) * cell, y = g.y0 + (j + 0.5) * cell;
      for (const [ea, eb] of segs) {
        const ends = [ea!, eb!].map((e) =>
          // edge ids: the horizontal edge from node (i, j) to (i+1, j) is 2k, the vertical one from (i, j) to (i, j+1) is 2k+1
          e === 0 ? slot(2 * k, x + ((L - tl) / (tr - tl)) * cell, y)
          : e === 2 ? slot(2 * (k + w), x + ((L - bl) / (br - bl)) * cell, y + cell)
          : e === 3 ? slot(2 * k + 1, x, y + ((L - tl) / (bl - tl)) * cell)
          : slot(2 * (k + 1) + 1, x + cell, y + ((L - tr) / (br - tr)) * cell));
        link(ends[0]!, ends[1]!);
      }
    }
    // walk the slots into polylines: open chains from their ends first, then the loops that are left
    const seen = new Uint8Array(px.length);
    const walk = (start: number) => {
      const line: XY[] = [[px[start]!, py[start]!]];
      seen[start] = 1;
      let prev = -1, cur = start;
      for (;;) {
        const a = nb[2 * cur]!, b = nb[2 * cur + 1]!;
        const next = a !== -1 && a !== prev && !seen[a] ? a : b !== -1 && b !== prev && !seen[b] ? b : -1;
        if (next === -1) {
          if ((a === start || b === start) && line.length > 2) line.push(line[0]!); // a loop closes on its start
          break;
        }
        seen[next] = 1;
        line.push([px[next]!, py[next]!]);
        prev = cur;
        cur = next;
      }
      if (line.length > 1) out.push(line);
    };
    for (let s = 0; s < px.length; s++) if (!seen[s] && nb[2 * s + 1] === -1) walk(s);
    for (let s = 0; s < px.length; s++) if (!seen[s]) walk(s);
  }
  return out;
}

/** Chaikin corner cutting: rounds off the grid's small steps. Closed lines stay closed, open ones keep their ends. */
function smooth(line: XY[], rounds = 2): XY[] {
  let pts = line;
  for (let r = 0; r < rounds; r++) {
    if (pts.length < 3) return pts;
    const closed = pts[0]![0] === pts[pts.length - 1]![0] && pts[0]![1] === pts[pts.length - 1]![1];
    const out: XY[] = closed ? [] : [pts[0]!];
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, ay] = pts[i]!, [bx, by] = pts[i + 1]!;
      out.push([0.75 * ax + 0.25 * bx, 0.75 * ay + 0.25 * by], [0.25 * ax + 0.75 * bx, 0.25 * ay + 0.75 * by]);
    }
    if (closed) out.push(out[0]!);
    else out.push(pts[pts.length - 1]!);
    pts = out;
  }
  return pts;
}

/** Where the waterlines run, in mm, before they are cut to the frame. */
export function traceWaterlines(data: LayerData, fit: Fit, frame: Rect, s: WaterlineStyle): XY[][] {
  const levels = waterlineLevels(s);
  if (!levels.length) return [];
  const reach = levels[levels.length - 1]!;
  // the grid covers the frame and enough around it that land just outside still pushes the lines away
  const pad = reach + 1;
  const area = (frame.w + 2 * pad) * (frame.h + 2 * pad);
  const cell = Math.max(MIN_CELL_MM, Math.sqrt(area / MAX_CELLS));
  const g: Grid = { x0: frame.x - pad, y0: frame.y - pad, cell, w: Math.ceil((frame.w + 2 * pad) / cell), h: Math.ceil((frame.h + 2 * pad) / cell) };

  const rings: XY[][] = [];
  for (const way of data.ways) {
    if (!way.closed) continue;
    const r: XY[] = [];
    for (let i = 0; i + 1 < way.pts.length; i += 2) r.push(fit.toMm(way.pts[i]!, way.pts[i + 1]!));
    if (r.length >= 3) rings.push(r);
  }
  if (!rings.length) return [];
  const water = new Uint8Array(g.w * g.h);
  fillRings(water, g, rings);

  // outside the fetched area nothing is known: treat it as water, not as a shore
  const c = data.covers;
  const coversMm: XY[] = [fit.toMm(c.minLat, c.minLon), fit.toMm(c.minLat, c.maxLon), fit.toMm(c.maxLat, c.maxLon), fit.toMm(c.maxLat, c.minLon)];
  const known = new Uint8Array(g.w * g.h);
  fillRings(known, g, [coversMm]);
  for (let i = 0; i < water.length; i++) if (!known[i]) water[i] = 1;

  // a sliver of land one cell thin between two pieces of water is a seam, not a shore
  for (let j = 1; j < g.h - 1; j++) {
    for (let i = 1; i < g.w - 1; i++) {
      const k = j * g.w + i;
      if (!water[k] && ((water[k - 1] && water[k + 1]) || (water[k - g.w] && water[k + g.w]))) water[k] = 1;
    }
  }

  const sq = distanceField(water, g.w, g.h);
  // distance from a water cell's center to the shore, in mm: the nearest land cell's center is half a cell past it
  const field = new Float32Array(sq.length);
  for (let i = 0; i < sq.length; i++) field[i] = sq[i]! >= INF / 2 ? reach * 10 : water[i] ? Math.sqrt(sq[i]!) * cell - cell / 2 : -cell / 2;
  // and no lines are drawn out there either: what is beyond the fetched area is not known to be water
  return contours(field, g, levels)
    .flatMap((l) => clipPolylineConvex(simplifyXY(smooth(l), SIMPLIFY_MM), coversMm))
    .filter((l) => l.length > 1);
}

/** The last answer, so moving a slider elsewhere on the page does not trace the lines again. */
let cache: { data: LayerData; key: string; lines: XY[][] } | undefined;

/**
 * `traceWaterlines`, remembered for the same water, view and settings. With `onlyCached` (while the map is being
 * dragged or zoomed) nothing new is traced: it answers undefined unless the lines for exactly this view are known.
 */
export function waterlinesFor(data: LayerData, fit: Fit, frame: Rect, s: WaterlineStyle, onlyCached = false): XY[][] | undefined {
  const probe = [fit.toMm(data.covers.minLat, data.covers.minLon), fit.toMm(data.covers.maxLat, data.covers.maxLon), fit.toMm(data.covers.minLat, data.covers.maxLon)];
  const key = JSON.stringify([probe.flat().map((v) => v.toFixed(4)), frame, s.count, s.gapMm, s.widen]);
  if (cache && cache.data === data && cache.key === key) return cache.lines;
  if (onlyCached) return undefined;
  const lines = traceWaterlines(data, fit, frame, s);
  cache = { data, key, lines };
  return lines;
}

/** The lines cut to the frame (or a coaster's shape). */
export function clipWaterlines(lines: XY[][], frame: Rect, clip?: { poly: XY[]; safe: Rect }): XY[][] {
  return lines.flatMap((l) => (clip ? clipPolylineConvex(l, clip.poly, clip.safe) : clipPolyline(l, frame)));
}
