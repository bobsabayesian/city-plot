import { contours as d3contours } from 'd3-contour';
import { WORLD_M, type Fit } from '../geo/project';
import { clipPolyline, simplifyXY, type Rect, type XY } from '../geo/clip';
import { TILE, type TerrainField } from './terrain';

const NICE = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];

/** Pick a "nice" interval giving roughly `target` lines across the relief. */
export function autoInterval(minM: number, maxM: number, target = 18): number {
  const raw = (maxM - minM) / target;
  return NICE.find((n) => n >= raw) ?? NICE[NICE.length - 1]!;
}

/** One 3x3 box blur pass; removes the stair-stepping in low-zoom tiles. */
export function blur(data: Float32Array, w: number, h: number, passes = 1): Float32Array {
  let src = data;
  for (let k = 0; k < passes; k++) {
    const dst = new Float32Array(src.length);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let s = 0;
        let c = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx >= 0 && xx < w && yy >= 0 && yy < h) { s += src[yy * w + xx]!; c++; }
          }
        dst[y * w + x] = s / c;
      }
    src = dst;
  }
  return src;
}

export interface ContourLevel { level: number; rings: XY[][] }

const gridCache = new WeakMap<TerrainField, Map<string, ContourLevel[]>>();

/** Contour rings in grid-pixel space (memoized per field + interval). */
export function contourLevels(field: TerrainField, intervalM: number, smooth = 1): ContourLevel[] {
  let perField = gridCache.get(field);
  if (!perField) gridCache.set(field, (perField = new Map()));
  const key = `${intervalM}|${smooth}`;
  const hit = perField.get(key);
  if (hit) return hit;
  const values = blur(field.data, field.w, field.h, smooth);
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const thresholds: number[] = [];
  for (let l = Math.ceil(lo / intervalM) * intervalM; l <= hi; l += intervalM) if (l > 0) thresholds.push(l);
  const gen = d3contours().size([field.w, field.h]).thresholds(thresholds);
  const levels = gen(Array.from(values)).map((c) => ({
    level: c.value,
    rings: c.coordinates.flatMap((poly) => poly.map((ring) => ring as XY[])),
  }));
  perField.set(key, levels);
  return levels;
}

export function fieldRange(field: TerrainField): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of field.data) { if (v < lo) lo = v; if (v > hi) hi = v; }
  return [lo, hi];
}

/** One clipped stretch of a contour line, in poster mm. */
export interface ContourPiece { level: number; heavy: boolean; pts: XY[] }
export interface ContourPaths { regular: string; index: string; pieces: ContourPiece[] }

const f = (n: number) => +n.toFixed(2);
export const toD = (lines: XY[][]) => lines.map((l) => l.map(([x, y], i) => `${i ? 'L' : 'M'}${f(x)} ${f(y)}`).join('')).join('');

let lastKey = '';
let lastOut: ContourPaths = { regular: '', index: '', pieces: [] };

/** Project contours to poster mm, simplify, and clip to the map frame (real geometry, plotter-safe). */
export function contourPaths(
  field: TerrainField, fit: Fit, frame: Rect, intervalM: number, indexEvery: number, smooth = 1,
): ContourPaths {
  const key = [intervalM, indexEvery, smooth, frame.x, frame.y, frame.w, frame.h, fit.metersPerMm, fit.toMm(0, 0)[0], fit.toMm(0, 0)[1], field.px0, field.py0, field.w, field.z].join('|') + (field.data.length);
  if (key === lastKey && lastOut) return lastOut;
  const world = TILE * 2 ** field.z;
  const toMm = (gx: number, gy: number): XY =>
    fit.mercToMm(((field.px0 + gx) / world - 0.5) * WORLD_M, (0.5 - (field.py0 + gy) / world) * WORLD_M);
  const regular: XY[][] = [];
  const index: XY[][] = [];
  const pieces: ContourPiece[] = [];
  for (const { level, rings } of contourLevels(field, intervalM, smooth)) {
    const isIndex = indexEvery > 0 && Math.round(level / intervalM) % indexEvery === 0;
    for (const ring of rings) {
      const mm = simplifyXY(ring.map(([gx, gy]) => toMm(gx, gy)), 0.08);
      for (const piece of clipPolyline(mm, frame)) {
        (isIndex ? index : regular).push(piece);
        pieces.push({ level, heavy: isIndex, pts: piece });
      }
    }
  }
  lastKey = key;
  return (lastOut = { regular: toD(regular), index: toD(index), pieces });
}

const rangeCache = new WeakMap<TerrainField, [number, number]>();

/** The interval in meters the map will use: the user's choice, or an automatic one for this terrain. */
export function contourInterval(userIntervalM: number, field: TerrainField): number {
  if (userIntervalM > 0) return userIntervalM;
  let r = rangeCache.get(field);
  if (!r) rangeCache.set(field, (r = fieldRange(field)));
  return autoInterval(r[0], r[1]);
}
