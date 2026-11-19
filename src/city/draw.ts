import { clipPolygon, clipPolygonConvex, clipPolyline, clipPolylineConvex, pointInRing, simplifyXY, type Rect, type XY } from '../geo/clip';
import type { BBox, Fit } from '../geo/project';
import { effectiveWidth } from '../export/offset';
import { inkWidth, type Pen } from '../scene/pens';
import type { HatchDensity, PathPrim } from '../scene/types';
import type { WaterLine } from '../features/types';
import { cutOutHalos, cutRingOutOfHalos, type Halo } from '../features/halo';
import { clipWaterlines, waterlinesFor } from './waterlines';
import { heightDensity, isAreaLayer, type LayerData, type LayerKey, type LayerStyle, type StrokeStyle, type Way } from './types';

const f = (n: number) => +n.toFixed(2);
const sub = (pts: XY[], close: boolean) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${f(x)} ${f(y)}`).join('') + (close ? 'Z' : '');

/** How strongly a filled area shows in print and PNG; a plotter draws hatch lines instead (see export/hatch). */
export const FILL_OPACITY: Record<HatchDensity, number> = { light: 0.18, medium: 0.38, solid: 0.75 };

export function dashFor(style: StrokeStyle, w: number): { dash?: number[]; round?: boolean } {
  if (style === 'dashed') return { dash: [w * 5, w * 3] };
  if (style === 'dotted') return { dash: [0, w * 2.5], round: true };
  return {};
}

/** Way points as poster mm. */
function toMm(w: Way, fit: Fit): XY[] {
  const out: XY[] = [];
  for (let i = 0; i + 1 < w.pts.length; i += 2) out.push(fit.toMm(w.pts[i]!, w.pts[i + 1]!));
  return out;
}

const bounds = (pts: XY[]) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return { x0, y0, x1, y1 };
};
const touches = (b: ReturnType<typeof bounds>, r: Rect) => b.x1 >= r.x && b.x0 <= r.x + r.w && b.y1 >= r.y && b.y0 <= r.y + r.h;

/** Rings smaller than this (mm on paper) are specks nobody can see. */
const MIN_RING_MM = 0.2;
const SIMPLIFY_MM = 0.04;

/**
 * A river's center line inside a river or lake outline is redundant: the two banks already show the water.
 * Lines with their middle point inside a filled-in water polygon are dropped.
 */
function withoutCoveredLines(lines: { sub?: string; pts: XY[] }[], rings: XY[][]): typeof lines {
  const boxes = rings.map(bounds);
  return lines.filter((l) => {
    if (l.sub !== 'river' && l.sub !== 'canal') return true;
    const [x, y] = l.pts[Math.floor(l.pts.length / 2)]!;
    return !rings.some((r, i) => x >= boxes[i]!.x0 && x <= boxes[i]!.x1 && y >= boxes[i]!.y0 && y <= boxes[i]!.y1 && pointInRing(x, y, r));
  });
}

/**
 * One map layer as drawing primitives: its lines (and ring outlines) as one stroked path in the layer's pen, and,
 * for area layers with a fill, the inside of the rings as one filled path. Everything is clipped to the frame.
 * The line is as thick as the pen's whole passes make it (see `effectiveWidth`), so the preview shows what plots.
 */
/** A shape the map is cut to (a coaster): a convex polygon inside the frame, and a rectangle known to be inside it. */
export interface MapClip { poly: XY[]; safe: Rect }

/** `moving`: the view is being dragged or zoomed, so slow extras (waterlines) wait until it rests. */
export function layerPrims(key: LayerKey, style: LayerStyle, pen: Pen, data: LayerData, fit: Fit, frame: Rect, clip?: MapClip, halos: Halo[] = [], moving = false): PathPrim[] {
  const prims: PathPrim[] = [];
  const lines: { sub?: string; pts: XY[] }[] = [];
  const rings: XY[][] = [];
  /** rings that are only filled: an area cut by a map tile's edge, whose outline is drawn as open lines */
  const fillOnly: XY[][] = [];
  /** each ring's way, for hatching by height */
  const heightOf = new Map<XY[], number | undefined>();
  for (const w of data.ways) {
    const mm = toMm(w, fit);
    if (mm.length < 2) continue;
    const b = bounds(mm);
    if (!touches(b, frame)) continue;
    if (w.closed) {
      if (Math.max(b.x1 - b.x0, b.y1 - b.y0) < MIN_RING_MM) continue;
      (w.fill ? fillOnly : rings).push(mm);
      heightOf.set(mm, w.h);
    } else lines.push({ sub: w.sub, pts: mm });
  }

  const kept = key === 'water' ? withoutCoveredLines(lines, [...rings, ...fillOnly]) : lines;
  const d: string[] = [];
  const stroke = (pts: XY[]) => {
    const simple = simplifyXY(pts, SIMPLIFY_MM);
    // lines are cut away around placed labels, so a name has clear paper to be read on
    for (const piece of cutOutHalos(clip ? clipPolylineConvex(simple, clip.poly, clip.safe) : clipPolyline(simple, frame), halos)) {
      const first = piece[0]!;
      const last = piece[piece.length - 1]!;
      d.push(sub(piece, piece.length > 3 && first[0] === last[0] && first[1] === last[1]));
    }
  };
  for (const l of kept) stroke(l.pts);
  for (const r of rings) stroke(r);
  const width = effectiveWidth(style.weightMm, inkWidth(pen));
  if (d.length) {
    prims.push({ kind: 'path', part: key, d: d.join(''), color: pen.color, pen: pen.id, mode: 'stroke', widthMm: width, round: true, ...dashFor(style.style, width) });
  }

  if (key === 'water' && style.waterlines && style.waterlines.count > 0) {
    // one pass of the pen: they are meant to be fine lines, whatever the shore's own thickness
    const traced = waterlinesFor(data, fit, frame, style.waterlines, moving);
    const lines = traced ? cutOutHalos(clipWaterlines(traced, frame, clip), halos) : [];
    if (lines.length) prims.push({ kind: 'path', part: key, d: lines.map((l) => sub(l, false)).join(''), color: pen.color, pen: pen.id, mode: 'stroke', widthMm: effectiveWidth(0, inkWidth(pen)), round: true });
  }

  if (isAreaLayer(key) && style.fill !== 'off' && (rings.length || fillOnly.length)) {
    const shape = (r: XY[]) => [clip ? clipPolygonConvex(simplifyXY(r, SIMPLIFY_MM), clip.poly) : clipPolygon(simplifyXY(r, SIMPLIFY_MM), frame)]
      .filter((q) => q.length >= 3)
      .flatMap((q) => cutRingOutOfHalos(q, halos))
      .map((q) => sub(q, true));
    // one fill per density: everything alike, or by each building's height
    const groups = new Map<HatchDensity, string[]>();
    for (const r of [...rings, ...fillOnly]) {
      const density = style.fill === 'height' ? (key === 'buildings' ? heightDensity(heightOf.get(r)) : 'light') : style.fill;
      if (!density) continue;
      (groups.get(density) ?? groups.set(density, []).get(density)!).push(...shape(r));
    }
    // lightest first, so denser hatching is drawn over it
    for (const density of (['solid', 'medium', 'light'] as HatchDensity[]).filter((x) => groups.get(x)?.length)) {
      prims.unshift({ kind: 'path', part: key, d: groups.get(density)!.join(''), color: pen.color, pen: pen.id, mode: 'fill', opacity: FILL_OPACITY[density], hatch: density });
    }
  }
  return prims;
}

/** Lakes and rivers with names, for writing their names on the map. */
export function waterLines(data: LayerData | undefined): WaterLine[] {
  const out: WaterLine[] = [];
  for (const w of data?.ways ?? []) {
    if (!w.name) continue;
    const kind = w.closed && w.sub === 'lake' ? 'lake' : !w.closed && (w.sub === 'river' || w.sub === 'canal') ? 'river' : undefined;
    if (!kind) continue;
    const coords: [number, number][] = [];
    for (let i = 0; i + 1 < w.pts.length; i += 2) coords.push([w.pts[i]!, w.pts[i + 1]!]);
    out.push({ id: w.id, kind, name: w.name, coords });
  }
  return out;
}

/** Does data fetched for `covers` include everything in `view`? */
export const covered = (covers: BBox | undefined, view: BBox) =>
  !!covers && view.minLat >= covers.minLat && view.maxLat <= covers.maxLat && view.minLon >= covers.minLon && view.maxLon <= covers.maxLon;

/** The same box grown by `frac` of its size on every side. */
export function padBBox(b: BBox, frac: number): BBox {
  const dLat = (b.maxLat - b.minLat) * frac;
  const dLon = (b.maxLon - b.minLon) * frac;
  return { minLat: Math.max(-85, b.minLat - dLat), maxLat: Math.min(85, b.maxLat + dLat), minLon: b.minLon - dLon, maxLon: b.maxLon + dLon };
}
