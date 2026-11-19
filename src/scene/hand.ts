import { clipPolygon, clipPolygonConvex, clipPolyline, clipPolylineConvex, simplifyXY, type Rect, type XY } from '../geo/clip';
import { flattenPath } from '../export/offset';
import type { PathPrim } from './types';

/**
 * Hand-drawn lines: the map drawn as if inked by hand rather than by a machine. Two kinds of unsteadiness:
 *
 * - a slow drift of the whole sheet (smooth noise over the paper, about 25 mm across), so lines sway gently and
 *   streets that meet still meet, and areas move with their own outlines;
 * - a small tremor along each line (noise along its length, about 9 mm across), different for every line.
 *
 * Both follow a seed, so the same seed always gives the same drawing, and "another take" is just a new seed.
 */
export interface HandSettings {
  /** 0 = steady (a machine line), 1 = sketchy */
  amount: number;
  seed: number;
}
export const DEFAULT_HAND: HandSettings = { amount: 0, seed: 1 };

/** Largest sideways drift and tremor at amount 1, mm. */
export const DRIFT_MM = 0.9;
export const TREMOR_MM = 0.4;
const DRIFT_SCALE_MM = 25;
const TREMOR_SCALE_MM = 9;
/** Lines are cut into steps this long first, so the drift can bend a long straight line. */
const STEP_MM = 1;

/** A repeatable pseudo-random value in [-1, 1] for an integer lattice point. */
function hash(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return ((h >>> 0) / 4294967295) * 2 - 1;
}
const fade = (t: number) => t * t * (3 - 2 * t);
/** Smooth value noise in [-1, 1]. */
function noise2(x: number, y: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = fade(x - ix), fy = fade(y - iy);
  const a = hash(ix, iy, seed), b = hash(ix + 1, iy, seed), c = hash(ix, iy + 1, seed), d = hash(ix + 1, iy + 1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** The slow drift of the sheet at a point. */
function drift(x: number, y: number, h: HandSettings): XY {
  const a = DRIFT_MM * h.amount, u = x / DRIFT_SCALE_MM, v = y / DRIFT_SCALE_MM;
  return [a * noise2(u, v, h.seed), a * noise2(u + 31.7, v - 17.3, h.seed + 1)];
}

/** Points no further than STEP_MM apart, so the drift bends the line rather than only moving its corners. */
function resample(pts: XY[]): XY[] {
  const out: XY[] = [pts[0]!];
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1]!, [bx, by] = pts[i]!;
    const n = Math.ceil(Math.hypot(bx - ax, by - ay) / STEP_MM);
    for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  return out;
}

/** One line, drifted with the sheet and trembling along its length. `tremor`: false for the edges of filled areas. */
export function handLine(pts: XY[], h: HandSettings, tremor = true): XY[] {
  if (h.amount <= 0 || pts.length < 2) return pts;
  const dense = resample(pts);
  // each line trembles its own way: its own seed from where it starts
  const lineSeed = h.seed * 7919 + Math.round(pts[0]![0] * 13) * 31 + Math.round(pts[0]![1] * 17);
  const amp = TREMOR_MM * h.amount;
  let along = 0;
  return dense.map(([x, y], i) => {
    if (i) along += Math.hypot(x - dense[i - 1]![0], y - dense[i - 1]![1]);
    const [dx, dy] = drift(x, y, h);
    if (!tremor) return [x + dx, y + dy];
    // tremor sideways to the line
    const [px, py] = dense[Math.max(0, i - 1)]!, [nx, ny] = dense[Math.min(dense.length - 1, i + 1)]!;
    const len = Math.hypot(nx - px, ny - py) || 1;
    const t = amp * noise2(along / TREMOR_SCALE_MM, 0.5, lineSeed);
    return [x + dx - ((ny - py) / len) * t, y + dy + ((nx - px) / len) * t];
  });
}

const f = (n: number) => +n.toFixed(2);
const sub = (pts: XY[], close: boolean) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${f(x)} ${f(y)}`).join('') + (close ? 'Z' : '');

/**
 * A map primitive redrawn by hand. Lines tremble and drift; filled areas only drift, so they stay under their
 * outlines. With `frame` (and a coaster's `clip`) the result is cut to it again, so nothing wanders off the map.
 */
export function handPrim(p: PathPrim, h: HandSettings, frame?: Rect, clip?: { poly: XY[]; safe: Rect }): PathPrim {
  if (h.amount <= 0) return p;
  const parts: string[] = [];
  for (const s of flattenPath(p.d)) {
    const fill = p.mode === 'fill';
    const pts = s.closed ? [...s.pts, s.pts[0]!] : s.pts;
    const moved = simplifyXY(handLine(pts, h, !fill), 0.02);
    if (fill) {
      const ring = !frame ? moved : clip ? clipPolygonConvex(moved, clip.poly) : clipPolygon(moved, frame);
      if (ring.length >= 3) parts.push(sub(ring, true));
    } else if (!frame) {
      parts.push(sub(moved, s.closed));
    } else {
      for (const piece of clip ? clipPolylineConvex(moved, clip.poly, clip.safe) : clipPolyline(moved, frame)) parts.push(sub(piece, false));
    }
  }
  return { ...p, d: parts.join('') };
}
