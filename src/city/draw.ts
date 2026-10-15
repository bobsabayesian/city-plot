import { clipPolygon, clipPolyline, pointInRing, simplifyXY, type Rect, type XY } from '../geo/clip';
import type { BBox, Fit } from '../geo/project';
import { effectiveWidth } from '../export/offset';
import type { Pen } from '../scene/pens';
import type { HatchDensity, PathPrim } from '../scene/types';
import type { WaterLine } from '../features/types';
import { isAreaLayer, type LayerData, type LayerKey, type LayerStyle, type StrokeStyle, type Way } from './types';

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
export function layerPrims(key: LayerKey, style: LayerStyle, pen: Pen, data: LayerData, fit: Fit, frame: Rect): PathPrim[] {
  const prims: PathPrim[] = [];
  const lines: { sub?: string; pts: XY[] }[] = [];
  const rings: XY[][] = [];
  for (const w of data.ways) {
    const mm = toMm(w, fit);
    if (mm.length < 2) continue;
    const b = bounds(mm);
    if (!touches(b, frame)) continue;
    if (w.closed) {
      if (Math.max(b.x1 - b.x0, b.y1 - b.y0) < MIN_RING_MM) continue;
      rings.push(mm);
    } else lines.push({ sub: w.sub, pts: mm });
  }

  const kept = key === 'water' ? withoutCoveredLines(lines, rings) : lines;
  const d: string[] = [];
  const stroke = (pts: XY[]) => {
    for (const piece of clipPolyline(simplifyXY(pts, SIMPLIFY_MM), frame)) {
      const first = piece[0]!;
      const last = piece[piece.length - 1]!;
      d.push(sub(piece, piece.length > 3 && first[0] === last[0] && first[1] === last[1]));
    }
  };
  for (const l of kept) stroke(l.pts);
  for (const r of rings) stroke(r);
  const width = effectiveWidth(style.weightMm, pen.tipMm);
  if (d.length) {
    prims.push({ kind: 'path', d: d.join(''), color: pen.color, pen: pen.id, mode: 'stroke', widthMm: width, round: true, ...dashFor(style.style, width) });
  }

  if (isAreaLayer(key) && style.fill !== 'off' && rings.length) {
    const fill = rings.map((r) => clipPolygon(simplifyXY(r, SIMPLIFY_MM), frame)).filter((r) => r.length >= 3).map((r) => sub(r, true));
    if (fill.length) prims.unshift({ kind: 'path', d: fill.join(''), color: pen.color, pen: pen.id, mode: 'fill', opacity: FILL_OPACITY[style.fill], hatch: style.fill });
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
