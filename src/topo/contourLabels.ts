import { clipPolyline, type Rect, type XY } from '../geo/clip';
import { CHAR_W, overlap, riverStretches, routeHits, type Box } from '../features/select';
import { toD, type ContourPiece } from './contours';

const PT = 25.4 / 72;

export type Density = 'sparse' | 'normal' | 'dense';
/** Minimum distance between two numbers on the same contour level, as a fraction of the map's short side. */
export const DENSITY_SPACING: Record<Density, number> = { sparse: 0.6, normal: 0.35, dense: 0.2 };
const MAX_LABELS = 300;

export interface ContourLabel {
  level: number;
  text: string;
  /** center of the number on its line, poster mm */
  x: number;
  y: number;
  /** radians, kept upright */
  angle: number;
  /** which piece (index into the pieces array) and how far along it, for cutting the gap */
  piece: number;
  arc: number;
  /** text width, mm */
  w: number;
}

export interface LabelOptions {
  /** spacing between heavy lines is intervalM * indexEvery; used to number the heavy lines */
  intervalM: number;
  indexEvery: number;
  every: number;
  density: Density;
  gap: boolean;
  sizePt: number;
  format: (levelM: number) => string;
  frame: Rect;
  /** things a number must stay clear of: landmark labels and markers, north arrow, corner profile */
  obstacles: Box[];
  route: XY[];
}

/** Elevation text for a contour level, in the poster's units. */
export function formatLevel(levelM: number, units: 'imperial' | 'metric'): string {
  return Math.round(units === 'imperial' ? levelM * 3.280839895 : levelM).toLocaleString('en-US');
}

const cumLengths = (pts: XY[]) => {
  const c = [0];
  for (let i = 1; i < pts.length; i++) c.push(c[i - 1]! + Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]));
  return c;
};

/** How far along `pts` the point nearest to `p` is. */
export function arcOfNearest(pts: XY[], p: XY): number {
  const cum = cumLengths(pts);
  let best = Infinity;
  let arc = 0;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1]!;
    const [bx, by] = pts[i]!;
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2));
    const d = Math.hypot(p[0] - (ax + t * dx), p[1] - (ay + t * dy));
    if (d < best) {
      best = d;
      arc = cum[i - 1]! + t * Math.sqrt(l2);
    }
  }
  return arc;
}

/** Remove the given [from, to] arc-length intervals from a polyline; returns what is left (0 or more fragments). */
export function cutIntervals(pts: XY[], intervals: [number, number][]): XY[][] {
  if (!intervals.length) return [pts];
  const cum = cumLengths(pts);
  const total = cum[cum.length - 1]!;
  const merged: [number, number][] = [];
  for (const [a, b] of [...intervals].sort((p, q) => p[0] - q[0])) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  const at = (d: number): XY => {
    let i = 1;
    while (i < cum.length - 1 && cum[i]! < d) i++;
    const t = (d - cum[i - 1]!) / Math.max(cum[i]! - cum[i - 1]!, 1e-9);
    return [pts[i - 1]![0] + (pts[i]![0] - pts[i - 1]![0]) * t, pts[i - 1]![1] + (pts[i]![1] - pts[i - 1]![1]) * t];
  };
  const out: XY[][] = [];
  let from = 0;
  const keep = (a: number, b: number) => {
    if (b - a < 0.05) return;
    const frag: XY[] = [at(a)];
    for (let i = 1; i < pts.length - 1; i++) if (cum[i]! > a && cum[i]! < b) frag.push(pts[i]!);
    frag.push(at(b));
    out.push(frag);
  };
  for (const [a, b] of merged) {
    keep(from, Math.max(from, Math.min(a, total)));
    from = Math.max(from, Math.min(b, total));
  }
  keep(from, total);
  return out;
}

/** A coarse grid of contour segments, so "is another line in the way?" does not scan every segment. */
class SegmentGrid {
  private cells = new Map<string, { piece: number; a: XY; b: XY; arcA: number; arcB: number }[]>();
  constructor(pieces: ContourPiece[], private cell = 8) {
    pieces.forEach((pc, piece) => {
      const cum = cumLengths(pc.pts);
      for (let i = 1; i < pc.pts.length; i++) {
        const a = pc.pts[i - 1]!;
        const b = pc.pts[i]!;
        const seg = { piece, a, b, arcA: cum[i - 1]!, arcB: cum[i]! };
        const [x0, x1] = [Math.floor(Math.min(a[0], b[0]) / cell), Math.floor(Math.max(a[0], b[0]) / cell)];
        const [y0, y1] = [Math.floor(Math.min(a[1], b[1]) / cell), Math.floor(Math.max(a[1], b[1]) / cell)];
        for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
          const k = `${x},${y}`;
          const list = this.cells.get(k);
          if (list) list.push(seg);
          else this.cells.set(k, [seg]);
        }
      }
    });
  }
  /** Segments whose cells touch the box's bounding rectangle. */
  near(box: Box): Set<{ piece: number; a: XY; b: XY; arcA: number; arcB: number }> {
    const c = Math.cos(box.ang);
    const s = Math.sin(box.ang);
    const hw = (Math.abs(c) * box.w + Math.abs(s) * box.h) / 2;
    const hh = (Math.abs(s) * box.w + Math.abs(c) * box.h) / 2;
    const out = new Set<{ piece: number; a: XY; b: XY; arcA: number; arcB: number }>();
    for (let x = Math.floor((box.cx - hw) / this.cell); x <= Math.floor((box.cx + hw) / this.cell); x++)
      for (let y = Math.floor((box.cy - hh) / this.cell); y <= Math.floor((box.cy + hh) / this.cell); y++)
        for (const seg of this.cells.get(`${x},${y}`) ?? []) out.add(seg);
    return out;
  }
}

/**
 * Choose where to write elevation numbers along the heavy contour lines. A number goes on a straight,
 * uncrowded stretch, tilted along the line, and is skipped where another contour, the route, a landmark
 * label, or the map edge is in the way. Numbers on the same level keep a minimum distance apart.
 */
export function placeContourLabels(pieces: ContourPiece[], o: LabelOptions): ContourLabel[] {
  const size = o.sizePt * PT;
  const h = size * 1.15;
  const spacing = Math.min(o.frame.w, o.frame.h) * DENSITY_SPACING[o.density];
  const inner: Rect = { x: o.frame.x + h, y: o.frame.y + h, w: o.frame.w - 2 * h, h: o.frame.h - 2 * h };
  const grid = new SegmentGrid(pieces);
  const placed: ContourLabel[] = [];
  const boxes: Box[] = [...o.obstacles];
  const perLevel = new Map<number, ContourLabel[]>();

  const heavyStep = o.intervalM * o.indexEvery;
  const wanted = (level: number) => Math.round(level / heavyStep) % Math.max(1, o.every) === 0;
  const order = pieces
    .map((pc, i) => ({ pc, i }))
    .filter(({ pc }) => pc.heavy && wanted(pc.level))
    .sort((a, b) => a.pc.level - b.pc.level);

  for (const { pc, i } of order) {
    const text = o.format(pc.level);
    const w = text.length * size * CHAR_W + size * 0.4;
    const half = w / 2 + size * 0.5; // the part of the line cut away when there is a gap
    if (cumLengths(pc.pts).at(-1)! < w * 1.3) continue;
    for (const st of riverStretches(pc.pts, w, size, inner, 80).stretches) {
      if (placed.length >= MAX_LABELS) return placed;
      const here = perLevel.get(pc.level) ?? [];
      if (here.some((l) => Math.hypot(l.x - st.x, l.y - st.y) < spacing)) continue;

      // the number's footprint: centered on the line with a gap, or just above it
      const nx = Math.sin(st.angle);
      const ny = -Math.cos(st.angle);
      const lift = o.gap ? 0 : h / 2 + size * 0.2;
      const box: Box = { cx: st.x + nx * lift, cy: st.y + ny * lift, w, h, ang: st.angle };
      if (boxes.some((b) => overlap(b, box)) || routeHits(o.route, box)) continue;

      // another contour in the way? (this line itself is allowed within the stretch being written on)
      const arc = arcOfNearest(pc.pts, [st.x, st.y]);
      const c = Math.cos(-box.ang);
      const s = Math.sin(-box.ang);
      const rect = { x: -w / 2, y: -h / 2, w, h };
      let blocked = false;
      for (const seg of grid.near(box)) {
        if (seg.piece === i && seg.arcB >= arc - half - 1 && seg.arcA <= arc + half + 1) continue;
        const a: XY = [(seg.a[0] - box.cx) * c - (seg.a[1] - box.cy) * s, (seg.a[0] - box.cx) * s + (seg.a[1] - box.cy) * c];
        const b: XY = [(seg.b[0] - box.cx) * c - (seg.b[1] - box.cy) * s, (seg.b[0] - box.cx) * s + (seg.b[1] - box.cy) * c];
        if (clipPolyline([a, b], rect).length > 0) { blocked = true; break; }
      }
      if (blocked) continue;

      const label: ContourLabel = { level: pc.level, text, x: st.x, y: st.y, angle: st.angle, piece: i, arc, w };
      placed.push(label);
      here.push(label);
      perLevel.set(pc.level, here);
      boxes.push(box);
    }
  }
  return placed;
}

/** SVG path data for the regular and heavy lines, with a gap cut out of a heavy line behind each of its numbers. */
export function pathsWithGaps(pieces: ContourPiece[], labels: ContourLabel[], sizePt: number): { regular: string; index: string } {
  const size = sizePt * PT;
  const cuts = new Map<number, [number, number][]>();
  for (const l of labels) {
    const half = l.w / 2 + size * 0.5;
    const list = cuts.get(l.piece) ?? [];
    list.push([l.arc - half, l.arc + half]);
    cuts.set(l.piece, list);
  }
  const regular: XY[][] = [];
  const index: XY[][] = [];
  pieces.forEach((pc, i) => {
    const frags = cuts.has(i) ? cutIntervals(pc.pts, cuts.get(i)!) : [pc.pts];
    (pc.heavy ? index : regular).push(...frags);
  });
  return { regular: toD(regular), index: toD(index) };
}
