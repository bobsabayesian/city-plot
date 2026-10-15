import { clipPolyline, type Rect, type XY } from '../geo/clip';
import type { Fit } from '../geo/project';
import type { FeatureSettings, LabelKind, Landmark, Side, WaterLine } from './types';

export interface LandmarkEntry {
  id: string;
  name: string;
  kind: LabelKind;
  hidden: boolean;
  /** chosen from the list, so drawn even if its kind is switched off */
  pinned: boolean;
  /** false when it was a candidate but no label position fit */
  placed: boolean;
}

export interface PlacedLabel {
  id: string;
  kind: LabelKind;
  /** marker center, poster mm; undefined for lakes and rivers (label only) */
  marker?: XY;
  text: string;
  x: number;
  y: number;
  anchor: 'start' | 'middle' | 'end';
  /** degrees clockwise about (x, y); set for river names that follow their river */
  rotate?: number;
}

export interface PlaceInput {
  landmarks: Landmark[];
  water: WaterLine[];
  fit: Fit;
  frame: Rect;
  /** where label text may go; defaults to the frame. Routes often touch the frame edge, so callers allow some margin. */
  labelBounds?: Rect;
  /** route polyline in poster mm (empty if none) */
  route: XY[];
  settings: FeatureSettings;
  sizeMm: number;
  markerR: number;
}

/** An oriented rectangle: center, size, and turn in radians (clockwise on screen). */
export interface Box { cx: number; cy: number; w: number; h: number; ang: number }
interface Candidate {
  id: string; name: string; kind: LabelKind; x: number; y: number; score: number; marker: boolean; ele?: number;
  /** its kind is switched on (otherwise it is only available from the list) */
  enabled: boolean;
  /** river names: unit direction of the stretch the label follows, in radians, kept upright */
  angle?: number;
  /** river names: other places along the river to try if the best one is taken */
  alts?: Stretch[];
}

const KIND_WEIGHT: Record<LabelKind, number> = {
  waypoint: 100, trailhead: 1.2, hut: 1.1, peak: 1, pass: 1, lake: 0.6, viewpoint: 0.7, river: 0.7,
};
const MAX_CANDIDATES = 80;
const MAX_LISTED = 30;
const MIN_LAKE_AREA_MM2 = 6;
/** average glyph width as a fraction of font size, used because text is measured before fonts load */
export const CHAR_W = 0.56;

export const boxAt = (x0: number, y0: number, x1: number, y1: number): Box => ({ cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0, ang: 0 });

function corners(b: Box): XY[] {
  const c = Math.cos(b.ang);
  const s = Math.sin(b.ang);
  return ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as XY[]).map(([ux, uy]) => {
    const x = (ux * b.w) / 2;
    const y = (uy * b.h) / 2;
    return [b.cx + x * c - y * s, b.cy + x * s + y * c];
  });
}

/** Separating-axis test for two oriented rectangles. */
export function overlap(a: Box, b: Box): boolean {
  const axes: XY[] = [[Math.cos(a.ang), Math.sin(a.ang)], [-Math.sin(a.ang), Math.cos(a.ang)], [Math.cos(b.ang), Math.sin(b.ang)], [-Math.sin(b.ang), Math.cos(b.ang)]];
  const ca = corners(a);
  const cb = corners(b);
  for (const [ax, ay] of axes) {
    const pa = ca.map(([x, y]) => x * ax + y * ay);
    const pb = cb.map(([x, y]) => x * ax + y * ay);
    if (Math.max(...pa) <= Math.min(...pb) || Math.max(...pb) <= Math.min(...pa)) return false;
  }
  return true;
}

function distToSegment(p: XY, a: XY, b: XY): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

export function distToPolyline(p: XY, line: XY[]): number {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) best = Math.min(best, distToSegment(p, line[i - 1]!, line[i]!));
  return best;
}

function ringArea(r: XY[]): number {
  let a = 0;
  for (let i = 1; i < r.length; i++) a += r[i - 1]![0] * r[i]![1] - r[i]![0] * r[i - 1]![1];
  return Math.abs(a) / 2;
}

const sideOrder = (side: Side): Exclude<Side, 'auto'>[] =>
  side === 'auto' ? ['right', 'left', 'above', 'below'] : [side];

export const insideBounds = (b: Box, r: Rect) =>
  corners(b).every(([x, y]) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);

/** Does the route pass through the box? Turns the route into the box's own frame, then clips against an upright rectangle. */
export function routeHits(route: XY[], b: Box): boolean {
  if (route.length < 2) return false;
  const c = Math.cos(-b.ang);
  const s = Math.sin(-b.ang);
  const local = route.map(([x, y]): XY => [(x - b.cx) * c - (y - b.cy) * s, (x - b.cx) * s + (y - b.cy) * c]);
  const rect = { x: -b.w / 2, y: -b.h / 2, w: b.w, h: b.h };
  for (let i = 1; i < local.length; i++) {
    const a = local[i - 1]!;
    const d = local[i]!;
    if (Math.max(a[0], d[0]) < rect.x || Math.min(a[0], d[0]) > rect.x + rect.w) continue;
    if (Math.max(a[1], d[1]) < rect.y || Math.min(a[1], d[1]) > rect.y + rect.h) continue;
    if (clipPolyline([a, d], rect).length > 0) return true;
  }
  return false;
}

/** Length of route (mm) that lies inside the box: how badly a label would cross it. */
export function routeLengthIn(route: XY[], b: Box): number {
  if (route.length < 2) return 0;
  const c = Math.cos(-b.ang);
  const s = Math.sin(-b.ang);
  const local = route.map(([x, y]): XY => [(x - b.cx) * c - (y - b.cy) * s, (x - b.cx) * s + (y - b.cy) * c]);
  const rect = { x: -b.w / 2, y: -b.h / 2, w: b.w, h: b.h };
  let total = 0;
  for (let i = 1; i < local.length; i++)
    for (const piece of clipPolyline([local[i - 1]!, local[i]!], rect))
      for (let k = 1; k < piece.length; k++) total += Math.hypot(piece[k]![0] - piece[k - 1]![0], piece[k]![1] - piece[k - 1]![1]);
  return total;
}

/**
 * OpenStreetMap splits a long river into many ways. Join pieces of the same name that share an end point so a
 * river is labeled once, and along its longest clear stretch.
 */
export function stitchRivers(water: WaterLine[]): { id: string; name: string; coords: [number, number][] }[] {
  const byName = new Map<string, { name: string; chains: [number, number][][] }>();
  const key = (p: [number, number]) => `${p[0]},${p[1]}`;
  for (const w of water) {
    if (w.kind !== 'river' || !w.name?.trim() || w.coords.length < 2) continue;
    const g = byName.get(w.name.toLowerCase()) ?? { name: w.name, chains: [] };
    byName.set(w.name.toLowerCase(), g);
    let piece = [...w.coords];
    // keep merging this piece with any chain it touches
    for (let merged = true; merged; ) {
      merged = false;
      for (let i = 0; i < g.chains.length; i++) {
        const c = g.chains[i]!;
        const [cs, ce] = [key(c[0]!), key(c[c.length - 1]!)];
        const [ps, pe] = [key(piece[0]!), key(piece[piece.length - 1]!)];
        let joined: [number, number][] | undefined;
        if (ce === ps) joined = [...c, ...piece.slice(1)];
        else if (pe === cs) joined = [...piece, ...c.slice(1)];
        else if (ce === pe) joined = [...c, ...[...piece].reverse().slice(1)];
        else if (cs === ps) joined = [...[...c].reverse(), ...piece.slice(1)];
        if (joined) {
          g.chains.splice(i, 1);
          piece = joined;
          merged = true;
          break;
        }
      }
    }
    g.chains.push(piece);
  }
  return [...byName.entries()].flatMap(([k, g]) => g.chains.map((coords, i) => ({ id: i ? `riv-${k}-${i}` : `riv-${k}`, name: g.name, coords })));
}

export interface Stretch { x: number; y: number; angle: number }

/**
 * Stretches of a river, `w` mm long and inside `bounds`, to write its name along: straightest and most
 * central first, at least a label-length apart. Also returns how much of the river is visible in all.
 */
export function riverStretches(line: XY[], w: number, size: number, bounds: Rect, max = 6): { stretches: Stretch[]; visible: number } {
  let visible = 0;
  const found: (Stretch & { cost: number })[] = [];
  for (const piece of clipPolyline(line, bounds)) {
    const cum = [0];
    for (let i = 1; i < piece.length; i++) cum.push(cum[i - 1]! + Math.hypot(piece[i]![0] - piece[i - 1]![0], piece[i]![1] - piece[i - 1]![1]));
    const L = cum[cum.length - 1]!;
    visible += L;
    if (L < w * 1.05) continue;
    const at = (d: number): XY => {
      let i = 1;
      while (i < cum.length - 1 && cum[i]! < d) i++;
      const t = (d - cum[i - 1]!) / Math.max(cum[i]! - cum[i - 1]!, 1e-9);
      return [piece[i - 1]![0] + (piece[i]![0] - piece[i - 1]![0]) * t, piece[i - 1]![1] + (piece[i]![1] - piece[i - 1]![1]) * t];
    };
    const step = Math.max(w * 0.2, size * 0.5);
    for (let a = 0; a + w <= L + 1e-6; a += step) {
      const p0 = at(a);
      const p1 = at(a + w);
      if (Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) < 0.9 * w) continue; // too curvy for the text to follow
      let turning = 0;
      let prev = Math.atan2(at(a + 0.001)[1] - p0[1], at(a + 0.001)[0] - p0[0]);
      for (let i = 1; i < piece.length - 1; i++) {
        if (cum[i]! <= a || cum[i]! >= a + w) continue;
        const h = Math.atan2(piece[i + 1]![1] - piece[i]![1], piece[i + 1]![0] - piece[i]![0]);
        turning += Math.abs(Math.atan2(Math.sin(h - prev), Math.cos(h - prev)));
        prev = h;
      }
      const mid = at(a + w / 2);
      let angle = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
      if (Math.cos(angle) < 0) angle += angle > 0 ? -Math.PI : Math.PI; // keep text upright
      found.push({ x: mid[0], y: mid[1], angle, cost: turning + (Math.abs(a + w / 2 - L / 2) / L) * 0.3 });
    }
  }
  found.sort((p, q) => p.cost - q.cost);
  const stretches: Stretch[] = [];
  for (const f of found) {
    if (stretches.length >= max) break;
    if (stretches.every((o) => Math.hypot(o.x - f.x, o.y - f.y) >= w)) stretches.push({ x: f.x, y: f.y, angle: f.angle });
  }
  return { stretches, visible };
}

/** The single best stretch plus how much of the river is visible, or undefined if none fits. */
export function bestStretch(line: XY[], w: number, size: number, bounds: Rect): (Stretch & { visible: number }) | undefined {
  const r = riverStretches(line, w, size, bounds, 1);
  return r.stretches[0] && { ...r.stretches[0], visible: r.visible };
}

export type LabelGroup = 'point' | 'water';
const groupOf = (k: LabelKind): LabelGroup => (k === 'river' || k === 'lake' ? 'water' : 'point');

/** Something nearby that is not drawn right now but could be added from the list. */
export interface PoolItem {
  id: string;
  name: string;
  kind: LabelKind;
  group: LabelGroup;
  ele?: number;
  /** why it is not drawn */
  reason: 'kind off' | 'hidden' | 'no room' | 'not chosen';
}

export interface LandmarkPlacement {
  entries: LandmarkEntry[];
  labels: PlacedLabel[];
  /** candidates that could fill an open slot, best first (includes kinds that are switched off) */
  pool: PoolItem[];
  /** free label slots per group: the limit minus what is drawn */
  open: Record<LabelGroup, number>;
  /** space the drawn labels and markers take, so other things (contour numbers) can stay clear of them */
  obstacles: Box[];
}

const MAX_POOL = 60;

/**
 * Pick the most important landmarks, then give each a label position that avoids the route and other labels.
 *
 * Slots: each group (point labels, water names) has a limit. Labels the user pinned from the list go first,
 * then candidates of switched-on kinds in rank order. A label the user hid keeps holding its slot, so the
 * slot stays open for the user to fill from the list instead of being refilled automatically. A label that
 * simply has no room does not hold a slot, so the next candidate gets a try.
 */
export function placeLandmarks(inp: PlaceInput): LandmarkPlacement {
  const { settings: s, fit, frame, route, sizeMm, markerR } = inp;
  const inFrame = ([x, y]: XY) => x >= frame.x && x <= frame.x + frame.w && y >= frame.y && y <= frame.y + frame.h;

  const eleVals = inp.landmarks.filter((l) => l.kind === 'peak' && l.ele !== undefined).map((l) => l.ele!);
  const eMin = Math.min(...eleVals);
  const eSpan = Math.max(Math.max(...eleVals) - eMin, 1);
  const proximityScale = 0.1 * Math.min(frame.w, frame.h);

  const cands: Candidate[] = [];
  const addCand = (c: Omit<Candidate, 'score'> & { base: number }) => {
    if (!inFrame([c.x, c.y])) return;
    const d = route.length > 1 ? distToPolyline([c.x, c.y], route) : Infinity;
    const near = d === Infinity ? 0 : 1.5 / (1 + d / proximityScale);
    cands.push({ ...c, score: c.base * (1 + near) });
  };

  // Every kind becomes a candidate, switched on or not, so the list can offer them.
  for (const l of inp.landmarks) {
    if (!l.name.trim()) continue;
    const [x, y] = fit.toMm(l.lat, l.lon);
    const eleBonus = l.kind === 'peak' && l.ele !== undefined && eleVals.length > 1 ? 2 * ((l.ele - eMin) / eSpan) : 0;
    addCand({ id: l.id, name: l.name, kind: l.kind, x, y, marker: true, ele: l.ele, enabled: s.kinds[l.kind], base: KIND_WEIGHT[l.kind] + eleBonus });
  }

  const lb = inp.labelBounds ?? frame;
  if (s.waterLabels) {
    for (const w of inp.water) {
      if (w.kind !== 'lake' || !w.name?.trim() || w.coords.length < 4) continue;
      const mm = w.coords.map(([la, lo]) => fit.toMm(la, lo));
      const area = ringArea(mm);
      if (area < MIN_LAKE_AREA_MM2) continue;
      const cx = mm.reduce((a, p) => a + p[0], 0) / mm.length;
      const cy = mm.reduce((a, p) => a + p[1], 0) / mm.length;
      addCand({ id: w.id, name: w.name, kind: 'lake', x: cx, y: cy, marker: false, enabled: true, base: KIND_WEIGHT.lake + Math.min(2, area / (frame.w * frame.h * 0.02)) });
    }
    const diag = Math.hypot(frame.w, frame.h);
    for (const r of stitchRivers(inp.water)) {
      const ov = s.overrides[r.id];
      const name = (ov?.name ?? r.name).trim() || r.name;
      const found = riverStretches(r.coords.map(([la, lo]) => fit.toMm(la, lo)), name.length * sizeMm * CHAR_W, sizeMm, frame);
      const first = found.stretches[0];
      if (!first) continue;
      addCand({
        id: r.id, name: r.name, kind: 'river', x: first.x, y: first.y, angle: first.angle, alts: found.stretches, marker: false, enabled: true,
        base: KIND_WEIGHT.river + Math.min(1.5, found.visible / (diag * 0.5)),
      });
    }
  }

  cands.sort((a, b) => b.score - a.score);
  // Same name + kind twice (OSM splits features): keep the strongest.
  const seen = new Set<string>();
  const unique = cands.filter((c) => {
    const k = `${c.kind}|${c.name.toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, MAX_CANDIDATES);

  // Markers of the candidates most likely to be drawn are reserved up front, so a label placed early
  // can't end up on top of a marker that is placed later.
  const likely = unique.filter((c) => c.marker && !s.overrides[c.id]?.hidden && (c.enabled || s.overrides[c.id]?.pinned));
  const taken: Box[] = likely
    .slice(0, s.maxLabels + 4)
    .map((c) => boxAt(c.x - markerR, c.y - markerR, c.x + markerR, c.y + markerR));
  const entries: LandmarkEntry[] = [];
  const labels: PlacedLabel[] = [];
  const gap = markerR * 0.7;
  const budget = { point: s.maxLabels, water: s.maxWaterLabels };
  // Per group: labels the user pinned (P), auto labels drawn (A), and auto labels the user hid (V).
  // Hidden labels hold their slot open, and pinned labels are what fill it, so promotion of further
  // candidates stops once A + max(V, P) reaches the limit; the total drawn (A + P) never exceeds it.
  const P = { point: 0, water: 0 };
  const A = { point: 0, water: 0 };
  const V = { point: 0, water: 0 };
  const full = (g: LabelGroup) => A[g] + Math.max(V[g], P[g]) >= budget[g];
  const status = new Map<string, PoolItem['reason'] | 'drawn'>();

  /** Find a spot for `c` and record the label. Returns whether it fit. */
  const place = (c: Candidate, name: string, ov: NonNullable<PlaceInput['settings']['overrides'][string]>): boolean => {
    const w = name.length * sizeMm * CHAR_W;

    if (c.kind === 'river') {
      // Write the name along the river, just above it; try below, then other stretches, if taken.
      const h = sizeMm * 0.95;
      const lineGap = sizeMm * 0.25;
      for (const st of c.alts ?? []) {
        const nx = Math.sin(st.angle);
        const ny = -Math.cos(st.angle);
        for (const side of [1, -1]) {
          const off = lineGap + h / 2;
          const center: XY = [st.x + side * nx * off, st.y + side * ny * off];
          const box: Box = { cx: center[0], cy: center[1], w, h, ang: st.angle };
          // text stays upright either way: its baseline is 0.35 * size below the box center along the text's own up
          const baseline: XY = [center[0] - nx * sizeMm * 0.35, center[1] - ny * sizeMm * 0.35];
          if (insideBounds(box, lb) && !routeHits(route, box) && !taken.some((t) => overlap(t, box))) {
            taken.push(box);
            labels.push({ id: c.id, kind: 'river', text: name, x: baseline[0], y: baseline[1], anchor: 'middle', rotate: (st.angle * 180) / Math.PI });
            return true;
          }
        }
      }
      return false;
    }

    const r = c.marker ? markerR : 0;
    const markerBox = boxAt(c.x - r, c.y - r, c.x + r, c.y + r);
    const forced = ov.side && ov.side !== 'auto';
    const sides = c.marker ? sideOrder(ov.side ?? 'auto') : (['middle'] as const);

    // A feature that sits on the route (a trailhead is where the route starts) can't avoid it on every side,
    // and one the user chose from the list should be drawn regardless. For those, if no side is clear,
    // take the side that crosses the route least instead of giving up.
    const onRoute = c.marker && route.length > 1 && distToPolyline([c.x, c.y], route) < markerR * 2 + sizeMm;
    const relax = !!ov.pinned || onRoute;
    const fallbacks: { label: PlacedLabel; box: Box; crossing: number }[] = [];

    for (const side of sides) {
      let label: PlacedLabel;
      let box: Box;
      const base = { id: c.id, kind: c.kind, marker: c.marker ? ([c.x, c.y] as XY) : undefined, text: name };
      if (side === 'right') {
        const x = c.x + r + gap;
        label = { ...base, x, y: c.y + sizeMm * 0.35, anchor: 'start' };
        box = boxAt(x, c.y - sizeMm * 0.55, x + w, c.y + sizeMm * 0.45);
      } else if (side === 'left') {
        const x = c.x - r - gap;
        label = { ...base, x, y: c.y + sizeMm * 0.35, anchor: 'end' };
        box = boxAt(x - w, c.y - sizeMm * 0.55, x, c.y + sizeMm * 0.45);
      } else if (side === 'above') {
        const y = c.y - r - gap;
        label = { ...base, x: c.x, y, anchor: 'middle' };
        box = boxAt(c.x - w / 2, y - sizeMm * 0.85, c.x + w / 2, y + sizeMm * 0.15);
      } else if (side === 'below') {
        const y = c.y + r + gap + sizeMm * 0.8;
        label = { ...base, x: c.x, y, anchor: 'middle' };
        box = boxAt(c.x - w / 2, y - sizeMm * 0.85, c.x + w / 2, y + sizeMm * 0.15);
      } else {
        label = { ...base, x: c.x, y: c.y + sizeMm * 0.35, anchor: 'middle' };
        box = boxAt(c.x - w / 2, c.y - sizeMm * 0.55, c.x + w / 2, c.y + sizeMm * 0.45);
      }
      const inside = insideBounds(box, lb);
      const labelsFree = !taken.some((t) => overlap(t, box)) && !(c.marker && side !== 'middle' && overlap(box, markerBox));
      const crossesRoute = routeHits(route, box);
      if ((inside && labelsFree && !crossesRoute) || forced) {
        taken.push(box);
        if (c.marker) taken.push(markerBox);
        labels.push(label);
        return true;
      }
      if (inside && labelsFree) fallbacks.push({ label, box, crossing: routeLengthIn(route, box) });
    }

    if (relax && fallbacks.length) {
      const best = fallbacks.reduce((p, q) => (q.crossing < p.crossing ? q : p));
      taken.push(best.box);
      if (c.marker) taken.push(markerBox);
      labels.push(best.label);
      return true;
    }
    return false;
  };

  const consider = (c: Candidate, pinned: boolean) => {
    const group = groupOf(c.kind);
    const ov = s.overrides[c.id] ?? {};
    const name = (ov.name ?? c.name).trim() || c.name;
    const entry: LandmarkEntry = { id: c.id, name, kind: c.kind, hidden: !!ov.hidden, pinned: !!ov.pinned, placed: false };
    if (entry.hidden) {
      entries.push(entry);
      status.set(c.id, 'hidden');
      if (!pinned) V[group]++; // a hidden auto label keeps its slot open; a removed pin gives its slot back
      return;
    }
    if (pinned ? P[group] >= budget[group] : full(group)) return;
    entries.push(entry);
    if (place(c, name, ov)) {
      entry.placed = true;
      (pinned ? P : A)[group]++;
      status.set(c.id, 'drawn');
    } else {
      status.set(c.id, 'no room');
    }
  };

  // 1. what the user chose from the list, then 2. ranked candidates of switched-on kinds
  for (const c of unique) if (s.overrides[c.id]?.pinned) consider(c, true);
  for (const c of unique) {
    if (entries.length >= MAX_LISTED) break;
    if (s.overrides[c.id]?.pinned || !c.enabled) continue;
    if (full('point') && full('water')) break;
    consider(c, false);
  }
  const drawn = { point: A.point + P.point, water: A.water + P.water };

  const pool: PoolItem[] = unique
    .filter((c) => status.get(c.id) !== 'drawn')
    .map((c): PoolItem => ({
      id: c.id, name: (s.overrides[c.id]?.name ?? c.name).trim() || c.name, kind: c.kind, group: groupOf(c.kind), ele: c.ele,
      reason: status.get(c.id) === 'hidden' ? 'hidden' : status.get(c.id) === 'no room' ? 'no room' : c.enabled ? 'not chosen' : 'kind off',
    }))
    .slice(0, MAX_POOL);

  return {
    entries, labels, pool,
    open: { point: Math.max(0, budget.point - drawn.point), water: Math.max(0, budget.water - drawn.water) },
    obstacles: taken,
  };
}
