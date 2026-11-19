import type { XY } from '../geo/clip';
import type { Halo } from './halo';
import type { Landmark } from './types';

/**
 * A memory route: a line joining some of the user's own landmarks in an order they choose ("where we met, our first
 * flat, where we got married"), drawn dotted over the map with a small arrow on each leg. The stops can be numbered
 * on the map, and listed with a note each in a key under it.
 */
export type RouteStyle = 'dotted' | 'dashed' | 'solid';
export interface RouteSettings {
  enabled: boolean;
  /** ids of the user's landmarks, in route order */
  stops: string[];
  pen: string;
  weightMm: number;
  style: RouteStyle;
  /** a smooth curve through the stops, or straight legs */
  curved: boolean;
  /** follow the streets between stops (found in the map's own street data); a leg it cannot find is drawn as above */
  streets: boolean;
  /** an arrowhead in the middle of each leg */
  arrows: boolean;
  /** put the stop's number in front of its name on the map */
  numbers: boolean;
  /** list the stops, with their notes, under the map */
  key: boolean;
  keySizePt: number;
  /** map lines are cut this many mm either side of the route, so it reads over busy streets */
  clearMm: number;
}

export const defaultRoute = (pen: string): RouteSettings => ({
  enabled: false, stops: [], pen, weightMm: 0.78, style: 'dotted', curved: true, streets: false, arrows: true, numbers: true, key: true, keySizePt: 10, clearMm: 1,
});

/** The stops that still exist, in route order (a landmark that was removed drops out). */
export function routeStops(r: RouteSettings, custom: Landmark[]): Landmark[] {
  const byId = new Map(custom.map((c) => [c.id, c]));
  return r.stops.map((id) => byId.get(id)).filter((c): c is Landmark => !!c);
}

/** Dash pattern for a route line of width w, mm. */
export function routeDash(style: RouteStyle, w: number): number[] | undefined {
  if (style === 'dotted') return [0, Math.max(1.2, w * 3.2)];
  if (style === 'dashed') return [Math.max(1.5, w * 6), Math.max(1, w * 4)];
  return undefined;
}

const SAMPLES_PER_LEG = 24;

/**
 * The route through the points, one polyline per leg. Curved, it is a centripetal Catmull-Rom spline (it passes
 * through every stop, never loops or overshoots wildly); straight, it is the legs themselves.
 */
export function routeLegs(pts: XY[], curved: boolean): XY[][] {
  if (pts.length < 2) return [];
  const legs: XY[][] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const p1 = pts[i]!, p2 = pts[i + 1]!;
    if (!curved) { legs.push([p1, p2]); continue; }
    // the ends are extended in a straight line, so the first and last legs start and end without a kink
    const p0 = pts[i - 1] ?? [2 * p1[0] - p2[0], 2 * p1[1] - p2[1]];
    const p3 = pts[i + 2] ?? [2 * p2[0] - p1[0], 2 * p2[1] - p1[1]];
    legs.push(catmullRom(p0, p1, p2, p3));
  }
  return legs;
}

function catmullRom(p0: XY, p1: XY, p2: XY, p3: XY): XY[] {
  const td = (a: XY, b: XY) => Math.max(1e-6, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])));
  const t0 = 0, t1 = t0 + td(p0, p1), t2 = t1 + td(p1, p2), t3 = t2 + td(p2, p3);
  const lerp = (a: XY, b: XY, ta: number, tb: number, t: number): XY => {
    const k = (t - ta) / (tb - ta);
    return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
  };
  const out: XY[] = [];
  for (let s = 0; s <= SAMPLES_PER_LEG; s++) {
    const t = t1 + ((t2 - t1) * s) / SAMPLES_PER_LEG;
    const a1 = lerp(p0, p1, t0, t1, t), a2 = lerp(p1, p2, t1, t2, t), a3 = lerp(p2, p3, t2, t3, t);
    const b1 = lerp(a1, a2, t0, t2, t), b2 = lerp(a2, a3, t1, t3, t);
    out.push(lerp(b1, b2, t1, t2, t));
  }
  return out;
}

const lengthOf = (l: XY[]) => l.reduce((a, p, i) => (i ? a + Math.hypot(p[0] - l[i - 1]![0], p[1] - l[i - 1]![1]) : 0), 0);

/** The point `at` mm along a polyline, and the direction there. */
export function along(l: XY[], at: number): { p: XY; dir: XY } {
  let left = Math.max(0, at);
  for (let i = 1; i < l.length; i++) {
    const [ax, ay] = l[i - 1]!, [bx, by] = l[i]!;
    const seg = Math.hypot(bx - ax, by - ay);
    if (seg >= left && seg > 0) return { p: [ax + ((bx - ax) * left) / seg, ay + ((by - ay) * left) / seg], dir: [(bx - ax) / seg, (by - ay) / seg] };
    left -= seg;
  }
  const a = l[l.length - 2] ?? l[0]!, b = l[l.length - 1]!;
  const seg = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  return { p: b, dir: [(b[0] - a[0]) / seg, (b[1] - a[1]) / seg] };
}

/** A leg with `gap` mm cut off each end, so the route stops short of the markers instead of running into them. */
export function trimLeg(l: XY[], gap: number): XY[] {
  const len = lengthOf(l);
  if (len <= 2 * gap) return [];
  const out: XY[] = [along(l, gap).p];
  let run = 0;
  for (let i = 1; i < l.length; i++) {
    run += Math.hypot(l[i]![0] - l[i - 1]![0], l[i]![1] - l[i - 1]![1]);
    if (run > gap && run < len - gap) out.push(l[i]!);
  }
  out.push(along(l, len - gap).p);
  return out;
}

/** A small open arrowhead (two strokes) in the middle of a leg, pointing the way the route goes. */
export function legArrow(l: XY[], size: number): string {
  const len = lengthOf(l);
  if (len < size * 4) return '';
  const { p: [x, y], dir: [dx, dy] } = along(l, len / 2);
  const f = (n: number) => +n.toFixed(2);
  // the arrow's tip sits on the line; its wings go back and out at about 30 degrees
  const tip: XY = [x + (dx * size) / 2, y + (dy * size) / 2];
  const back = (side: number): XY => [tip[0] - dx * size + side * -dy * size * 0.55, tip[1] - dy * size + side * dx * size * 0.55];
  const [l1, r1] = [back(1), back(-1)];
  return `M${f(l1[0])} ${f(l1[1])}L${f(tip[0])} ${f(tip[1])}L${f(r1[0])} ${f(r1[1])}`;
}

/** Clear zones along the route, so map lines are cut away either side of it: one thin box per stretch of the line. */
export function routeHalos(legs: XY[][], clearMm: number): Halo[] {
  if (!(clearMm > 0)) return [];
  const out: Halo[] = [];
  for (const l of legs) {
    // stretches of up to ~6 mm keep the boxes close to a curved line
    let start = l[0]!;
    let run = 0;
    for (let i = 1; i < l.length; i++) {
      run += Math.hypot(l[i]![0] - l[i - 1]![0], l[i]![1] - l[i - 1]![1]);
      if (run < 6 && i < l.length - 1) continue;
      const end = l[i]!;
      const w = Math.hypot(end[0] - start[0], end[1] - start[1]);
      out.push({ box: { cx: (start[0] + end[0]) / 2, cy: (start[1] + end[1]) / 2, w, h: 0, ang: Math.atan2(end[1] - start[1], end[0] - start[0]) }, r: clearMm });
      start = end;
      run = 0;
    }
  }
  return out;
}

/** "1. Home" when the stops are numbered. */
export const stopLabel = (n: number, name: string, numbers: boolean) => (numbers ? `${n}. ${name}` : name);
