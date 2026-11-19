import type { Prim } from '../scene/types';
import { placeLandmarks, type LandmarkPlacement, type PlaceInput } from './select';
import { inkWidth, type Pen } from '../scene/pens';
import type { Icon, LabelKind, LandmarkKind } from './types';

const f = (n: number) => +n.toFixed(2);

/**
 * Simple outline glyph centered on (x, y); strokes only so it plots. `default` is the kind's own shape; a user's own
 * landmark (kind `custom`) is drawn a little bigger, as a bullseye unless it has an icon.
 */
export function markerPath(kind: LandmarkKind, x: number, y: number, r: number, icon: Icon = 'default'): string {
  const circle = (rr: number) => `M${f(x - rr)} ${f(y)}a${f(rr)} ${f(rr)} 0 1 0 ${f(2 * rr)} 0a${f(rr)} ${f(rr)} 0 1 0 ${f(-2 * rr)} 0Z`;
  const poly = (pts: [number, number][], k = 1) => pts.map(([px, py], i) => `${i ? 'L' : 'M'}${f(x + px * r * k)} ${f(y + py * r * k)}`).join('') + 'Z';
  const star = (k = 1) => poly(Array.from({ length: 10 }, (_, i): [number, number] => {
    const a = (i * Math.PI) / 5 - Math.PI / 2;
    const rr = i % 2 ? 0.45 : 1.05;
    return [Math.cos(a) * rr, Math.sin(a) * rr];
  }), k);
  const own = kind === 'custom';
  const R = own ? r * 1.4 : r;
  const bullseye = circle(R) + circle(R * (own ? 0.35 : 0.5));
  switch (icon === ('pin' as Icon) ? 'dot' : icon) {
    case 'none': return '';
    case 'crosshair': return circle(R * 0.62) + `M${f(x - R * 1.25)} ${f(y)}h${f(R * 2.5)}M${f(x)} ${f(y - R * 1.25)}v${f(R * 2.5)}`;
    case 'circle': return circle(R);
    case 'dot': return bullseye;
    case 'triangle': return poly([[0, -1], [0.95, 0.7], [-0.95, 0.7]], R / r);
    case 'diamond': return poly([[0, -1], [1, 0], [0, 1], [-1, 0]], R / r);
    case 'square': return `M${f(x - R * 0.8)} ${f(y - R * 0.8)}h${f(R * 1.6)}v${f(R * 1.6)}h${f(-R * 1.6)}Z`;
    case 'star': return star(R / r);
    case 'home': return poly([[0, -1.1], [1, -0.1], [0.7, -0.1], [0.7, 0.9], [-0.7, 0.9], [-0.7, -0.1], [-1, -0.1]], (R / r) * (own ? 1 : 1));
    case 'flag': return `M${f(x - R * 0.6)} ${f(y + R)}V${f(y - R)}L${f(x + R)} ${f(y - R * 0.45)}L${f(x - R * 0.6)} ${f(y + R * 0.1)}`;
    default: break;
  }
  switch (kind) {
    case 'attraction': return circle(r) + circle(r * 0.3);
    case 'museum': return `M${f(x - r * 0.8)} ${f(y - r * 0.8)}h${f(r * 1.6)}v${f(r * 1.6)}h${f(-r * 1.6)}Z`;
    case 'historic': return poly([[0, -1], [1, 0], [0, 1], [-1, 0]]);
    case 'worship': return `M${f(x - r)} ${f(y)}h${f(2 * r)}M${f(x)} ${f(y - r)}v${f(2 * r)}`;
    case 'station': return circle(r);
    case 'park': return poly([[0, -1], [0.95, 0.7], [-0.95, 0.7]]);
    case 'university': return poly([[0, 1], [0.95, -0.7], [-0.95, -0.7]]);
    case 'stadium': return `M${f(x - r * 1.2)} ${f(y)}a${f(r * 1.2)} ${f(r * 0.7)} 0 1 0 ${f(r * 2.4)} 0a${f(r * 1.2)} ${f(r * 0.7)} 0 1 0 ${f(-r * 2.4)} 0Z`;
    case 'custom': return bullseye;
    default: return '';
  }
}

export interface LandmarkDraw extends PlaceInput {
  /** the pen a label of this kind is drawn with */
  penFor: (kind: LabelKind) => Pen;
  fontFamily: string;
  fontKey: 'sans' | 'serif';
  trackingMm: number;
}

export function landmarkPrims(inp: LandmarkDraw): { prims: Prim[] } & Pick<LandmarkPlacement, 'entries' | 'pool' | 'open' | 'obstacles' | 'halos'> {
  const { labels, entries, pool, open, obstacles, halos } = placeLandmarks(inp);
  const prims: Prim[] = [];
  // markers are grouped by pen so each pen gets one path; labels carry their own pen
  const markers = labels.filter((l) => l.marker);
  const byPen = new Map<string, { pen: Pen; ds: string[] }>();
  for (const l of markers) {
    const pen = inp.penFor(l.kind);
    const g = byPen.get(pen.id) ?? { pen, ds: [] };
    g.ds.push(markerPath(l.kind as LandmarkKind, l.marker![0], l.marker![1], inp.markerR, l.icon));
    byPen.set(pen.id, g);
  }
  for (const { pen, ds } of byPen.values())
    prims.push({ kind: 'path', mode: 'stroke', part: 'landmarks', color: pen.color, pen: pen.id, widthMm: inkWidth(pen), round: true, d: ds.join('') });
  for (const l of labels) {
    if (!l.text) continue; // a marker with no name
    const pen = inp.penFor(l.kind);
    const size = l.sizeMm ?? inp.sizeMm;
    prims.push({
      kind: 'text', text: l.text, x: l.x, y: l.y, anchor: l.anchor, sizeMm: size,
      trackingMm: inp.trackingMm * (size / inp.sizeMm), fontFamily: inp.fontFamily, fontKey: inp.fontKey, color: pen.color, pen: pen.id,
      ...(l.rotate ? { rotate: l.rotate } : {}),
      ref: l.id,
      part: 'landmarks',
    });
  }
  return { prims, entries, pool, open, obstacles, halos };
}
