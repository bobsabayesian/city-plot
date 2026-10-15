import { describe, expect, it } from 'vitest';
import { placeLandmarks, routeLengthIn, type PlaceInput } from '../src/features/select';
import { defaultFeatures, type Landmark } from '../src/features/types';
import { fitBBox } from '../src/geo/project';
import type { XY } from '../src/geo/clip';

const B = { minLat: 46, maxLat: 46.2, minLon: -121.4, maxLon: -121 };
const frame = { x: 20, y: 20, w: 300, h: 400 };
const fit = fitBBox(B, frame);
const [mx, my] = fit.toMm(46.1, -121.2);
const trailhead: Landmark = { id: 'th', name: 'Bright Angel Trailhead', kind: 'trailhead', lat: 46.1, lon: -121.2 };
const input = (landmarks: Landmark[], route: XY[], over: Partial<PlaceInput> = {}): PlaceInput => ({
  landmarks, water: [], fit, frame, route, settings: defaultFeatures(), sizeMm: 4, markerR: 2, ...over,
});

/** A dense zigzag covering a block around the marker, so every side of a label is crossed. */
const zigzag = (cx: number, cy: number, half = 40, rows = 24): XY[] => {
  const pts: XY[] = [];
  for (let i = 0; i <= rows; i++) {
    const y = cy - 12 + (i * 24) / rows;
    pts.push(i % 2 ? [cx + half, y] : [cx - half, y], i % 2 ? [cx - half, y] : [cx + half, y]);
  }
  return pts;
};
/** A closed loop around the marker, 12 mm out: the marker is not on the route, but every label side crosses it. */
const loop = (cx: number, cy: number, r = 12): XY[] => [[cx - r, cy - r], [cx + r, cy - r], [cx + r, cy + r], [cx - r, cy + r], [cx - r, cy - r]];

describe('routeLengthIn', () => {
  const box = { cx: 50, cy: 50, w: 30, h: 4, ang: 0 };
  it('is the length of route inside the box', () => {
    expect(routeLengthIn([[0, 50], [100, 50]], box)).toBeCloseTo(30, 6);
    expect(routeLengthIn([[50, 0], [50, 100]], box)).toBeCloseTo(4, 6);
  });
  it('is zero for a route that misses the box, or no route', () => {
    expect(routeLengthIn([[0, 10], [100, 10]], box)).toBe(0);
    expect(routeLengthIn([], box)).toBe(0);
  });
  it('works for a turned box', () => {
    expect(routeLengthIn([[50, 0], [50, 100]], { ...box, ang: Math.PI / 2 })).toBeCloseTo(30, 6); // its long side now runs up and down
  });
  it('adds up several crossings', () => {
    expect(routeLengthIn([[0, 49], [100, 49], [100, 51], [0, 51]], box)).toBeCloseTo(60, 6);
  });
});

describe('a feature on the route still gets a label', () => {
  it('auto placement finds a side even when the route is on every side (the trailhead case)', () => {
    const r = placeLandmarks(input([trailhead], zigzag(mx, my)));
    expect(r.labels).toHaveLength(1);
    expect(r.entries[0]).toMatchObject({ id: 'th', placed: true });
    expect(r.pool.some((p) => p.id === 'th')).toBe(false); // not stuck in the list as "no room"
  });
  it('a route that just passes through the marker (the common trailhead) is fine', () => {
    const route: XY[] = [[mx - 60, my], [mx + 60, my]];
    const r = placeLandmarks(input([trailhead], route));
    expect(r.labels).toHaveLength(1);
    expect(r.entries[0]!.placed).toBe(true);
  });
  it('still prefers a clear side when there is one', () => {
    const route: XY[] = [[mx - 60, my], [mx + 60, my]]; // above and below are free
    const l = placeLandmarks(input([trailhead], route)).labels[0]!;
    // not drawn on top of the line: the label sits above or below the marker, not beside it
    expect(l.anchor).toBe('middle');
  });
  it('takes the side that crosses the route least', () => {
    // three long lines block above, level and below; extra wiggles make the right side much worse than the left
    const route: XY[] = [
      [mx - 60, my - 5], [mx + 60, my - 5], [mx + 60, my],
      [mx + 40, my], [mx + 34, my + 1.9], [mx + 28, my - 1.9], [mx + 22, my + 1.9], [mx + 16, my - 1.9], [mx + 10, my + 1.9], [mx + 4, my],
      [mx - 60, my], [mx - 60, my + 5], [mx + 60, my + 5],
    ];
    const w = 'Bright Angel Trailhead'.length * 4 * 0.56;
    const right = { cx: mx + 3.4 + w / 2, cy: my - 0.05 * 4, w, h: 4, ang: 0 };
    const left = { cx: mx - 3.4 - w / 2, cy: my - 0.05 * 4, w, h: 4, ang: 0 };
    expect(routeLengthIn(route, right)).toBeGreaterThan(routeLengthIn(route, left)); // sanity: the route really is worse on the right
    const l = placeLandmarks(input([trailhead], route)).labels[0]!;
    expect(l.anchor).toBe('end'); // left
  });
});

describe('a feature that is not on the route keeps its strict placement', () => {
  it('stays "no room" when the route boxes it in from a distance', () => {
    const r = placeLandmarks(input([trailhead], loop(mx, my)));
    expect(r.labels).toHaveLength(0);
    expect(r.entries[0]).toMatchObject({ placed: false });
    expect(r.pool.find((p) => p.id === 'th')).toMatchObject({ reason: 'no room' });
  });
  it('but one the user picked from the list is drawn anyway', () => {
    const s = defaultFeatures();
    s.overrides['th'] = { pinned: true };
    const r = placeLandmarks(input([trailhead], loop(mx, my), { settings: s }));
    expect(r.labels).toHaveLength(1);
    expect(r.entries[0]).toMatchObject({ placed: true, pinned: true });
  });
  it('even a pinned label never goes on top of another label', () => {
    const other: Landmark = { id: 'o', name: 'Neighbor Peak With A Long Name', kind: 'peak', lat: 46.1, lon: -121.2001, ele: 3000 };
    const s = defaultFeatures();
    s.overrides['th'] = { pinned: true };
    const labels = placeLandmarks(input([trailhead, other], zigzag(mx, my), { settings: s })).labels;
    const box = (l: (typeof labels)[number]) => {
      const w = l.text.length * 4 * 0.56;
      const x0 = l.anchor === 'start' ? l.x : l.anchor === 'end' ? l.x - w : l.x - w / 2;
      return { x0, x1: x0 + w, y0: l.y - 3.2, y1: l.y + 0.8 };
    };
    for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
      const a = box(labels[i]!);
      const b = box(labels[j]!);
      expect(a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0).toBe(false);
    }
  });
});

describe('a forced side is still honored exactly', () => {
  it('draws on the chosen side even across the route', () => {
    const s = defaultFeatures();
    s.overrides['th'] = { side: 'right' };
    const l = placeLandmarks(input([trailhead], zigzag(mx, my), { settings: s })).labels[0]!;
    expect(l.anchor).toBe('start');
  });
});
