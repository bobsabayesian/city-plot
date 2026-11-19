import type { PathPrim } from './types';
import type { HatchDensity } from './types';

/**
 * Scale bars for the map info row: a bar of round length in metres or miles, split into four, alternately filled
 * (hatched, for a plotter); and an "on foot" bar, the distance walked in a round number of minutes.
 * They are drawn true to the map: 1 mm of bar is exactly as much ground as 1 mm of map.
 */

/** Walking pace for the "on foot" bar: 5 km/h, a usual city walking speed. */
export const WALK_M_PER_MIN = 5000 / 60;

/** The longest round distance (metres) whose bar fits in `maxMm`, with how to write it. */
export function niceDistance(maxMm: number, mmPerM: number, imperial: boolean): { m: number; label: string } | undefined {
  const fits = (m: number) => m * mmPerM <= maxMm;
  if (imperial) {
    const FT = 0.3048, MI = 1609.344;
    // feet for short bars, then miles: the steps people read off a map
    const steps: [number, string][] = [
      [50 * FT, '50 ft'], [100 * FT, '100 ft'], [200 * FT, '200 ft'], [250 * FT, '250 ft'], [500 * FT, '500 ft'], [1000 * FT, '1000 ft'],
      [0.25 * MI, '0.25 mi'], [0.5 * MI, '0.5 mi'], [1 * MI, '1 mi'], [2 * MI, '2 mi'], [5 * MI, '5 mi'], [10 * MI, '10 mi'], [20 * MI, '20 mi'], [50 * MI, '50 mi'],
    ];
    const best = steps.filter(([m]) => fits(m)).at(-1);
    return best ? { m: best[0], label: best[1] } : undefined;
  }
  let best: number | undefined;
  for (let e = 0; e <= 5; e++) for (const k of [1, 2, 5]) if (fits(k * 10 ** e)) best = k * 10 ** e;
  if (best === undefined) return undefined;
  return { m: best, label: best >= 1000 ? `${best / 1000} km` : `${best} m` };
}

/** The longest round number of minutes on foot whose bar fits in `maxMm`. */
export function niceWalk(maxMm: number, mmPerM: number): { m: number; label: string } | undefined {
  const mins = [1, 2, 5, 10, 15, 20, 30, 45, 60, 90, 120].filter((n) => n * WALK_M_PER_MIN * mmPerM <= maxMm).at(-1);
  if (!mins) return undefined;
  return { m: mins * WALK_M_PER_MIN, label: mins >= 60 && mins % 60 === 0 ? `${mins / 60} h` : `${mins} min` };
}

const f = (n: number) => +n.toFixed(3);
const rect = (x: number, y: number, w: number, h: number) => `M${f(x)} ${f(y)}H${f(x + w)}V${f(y + h)}H${f(x)}Z`;

/**
 * A bar `lengthMm` long and `heightMm` tall with its top-left at (x, y): an outline split into `parts`, every other
 * part filled. Returns the outline (strokes) and the filled parts (a fill, hatched on a plotter).
 */
export function barPrims(x: number, y: number, lengthMm: number, heightMm: number, parts: number, color: string, pen: string | undefined, weightMm: number, hatch: HatchDensity = 'solid'): PathPrim[] {
  const w = lengthMm / parts;
  let outline = rect(x, y, lengthMm, heightMm);
  for (let i = 1; i < parts; i++) outline += `M${f(x + i * w)} ${f(y)}V${f(y + heightMm)}`;
  let filled = '';
  for (let i = 0; i < parts; i += 2) filled += rect(x + i * w, y, w, heightMm);
  return [
    { kind: 'path', d: filled, color, pen, mode: 'fill', hatch },
    { kind: 'path', d: outline, color, pen, mode: 'stroke', widthMm: weightMm },
  ];
}

/** Rough width of a line of text, mm, for laying out bars beside their labels (font metrics are not known here). */
export const textWidthMm = (s: string, sizeMm: number, trackingMm: number, serif = false) => s.length * (sizeMm * (serif ? 0.5 : 0.56) + trackingMm);
