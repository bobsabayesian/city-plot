import type { Prim } from '../scene/types';
import { placeLandmarks, type LandmarkPlacement, type PlaceInput } from './select';
import type { Pen } from '../scene/pens';
import type { CustomIcon, LabelKind, LandmarkKind } from './types';

const f = (n: number) => +n.toFixed(2);

/** Simple outline glyph per kind, centered on (x, y); strokes only so it plots. A user's own landmark uses its chosen icon. */
export function markerPath(kind: LandmarkKind, x: number, y: number, r: number, icon: CustomIcon = 'pin'): string {
  const circle = (rr: number) => `M${f(x - rr)} ${f(y)}a${f(rr)} ${f(rr)} 0 1 0 ${f(2 * rr)} 0a${f(rr)} ${f(rr)} 0 1 0 ${f(-2 * rr)} 0Z`;
  const poly = (pts: [number, number][]) => pts.map(([px, py], i) => `${i ? 'L' : 'M'}${f(x + px * r)} ${f(y + py * r)}`).join('') + 'Z';
  switch (kind) {
    case 'attraction':
      return circle(r) + circle(r * 0.3);
    case 'museum':
      return `M${f(x - r * 0.8)} ${f(y - r * 0.8)}h${f(r * 1.6)}v${f(r * 1.6)}h${f(-r * 1.6)}Z`;
    case 'historic':
      return poly([[0, -1], [1, 0], [0, 1], [-1, 0]]);
    case 'worship':
      return `M${f(x - r)} ${f(y)}h${f(2 * r)}M${f(x)} ${f(y - r)}v${f(2 * r)}`;
    case 'station':
      return circle(r);
    case 'park':
      return poly([[0, -1], [0.95, 0.7], [-0.95, 0.7]]);
    case 'university':
      return poly([[0, 1], [0.95, -0.7], [-0.95, -0.7]]);
    case 'stadium':
      return `M${f(x - r * 1.2)} ${f(y)}a${f(r * 1.2)} ${f(r * 0.7)} 0 1 0 ${f(r * 2.4)} 0a${f(r * 1.2)} ${f(r * 0.7)} 0 1 0 ${f(-r * 2.4)} 0Z`;
    case 'custom': {
      const R = r * 1.4;
      if (icon === 'home') return poly([[0, -1.1], [1, -0.1], [0.7, -0.1], [0.7, 0.9], [-0.7, 0.9], [-0.7, -0.1], [-1, -0.1]].map(([a, b]) => [a! * 1.4, b! * 1.4] as [number, number]));
      if (icon === 'star') {
        const pts: [number, number][] = Array.from({ length: 10 }, (_, k) => {
          const rad = k % 2 ? 0.45 : 1;
          const ang = -Math.PI / 2 + (k * Math.PI) / 5;
          return [Math.cos(ang) * rad * 1.4, Math.sin(ang) * rad * 1.4];
        });
        return poly(pts);
      }
      if (icon === 'flag') return `M${f(x - R * 0.6)} ${f(y + R)}V${f(y - R)}L${f(x + R)} ${f(y - R * 0.45)}L${f(x - R * 0.6)} ${f(y + R * 0.1)}`;
      return circle(R) + circle(R * 0.35);
    }
    default:
      return '';
  }
}

export interface LandmarkDraw extends PlaceInput {
  /** the pen a label of this kind is drawn with */
  penFor: (kind: LabelKind) => Pen;
  fontFamily: string;
  fontKey: 'sans' | 'serif';
  trackingMm: number;
}

export function landmarkPrims(inp: LandmarkDraw): { prims: Prim[] } & Pick<LandmarkPlacement, 'entries' | 'pool' | 'open' | 'obstacles'> {
  const { labels, entries, pool, open, obstacles } = placeLandmarks(inp);
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
    prims.push({ kind: 'path', mode: 'stroke', color: pen.color, pen: pen.id, widthMm: pen.tipMm, round: true, d: ds.join('') });
  for (const l of labels) {
    const pen = inp.penFor(l.kind);
    prims.push({
      kind: 'text', text: l.text, x: l.x, y: l.y, anchor: l.anchor, sizeMm: inp.sizeMm,
      trackingMm: inp.trackingMm, fontFamily: inp.fontFamily, fontKey: inp.fontKey, color: pen.color, pen: pen.id,
      ...(l.rotate ? { rotate: l.rotate } : {}),
    });
  }
  return { prims, entries, pool, open, obstacles };
}
