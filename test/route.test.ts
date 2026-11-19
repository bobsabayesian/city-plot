import { describe, expect, it } from 'vitest';
import { along, legArrow, routeDash, routeLegs, routeStops, trimLeg } from '../src/features/route';
import { buildScene, viewOf } from '../src/scene/buildScene';
import { prepareScene, type FontSet } from '../src/export/outlines';
import { flattenPath } from '../src/export/offset';
import type { XY } from '../src/geo/clip';
import type { Landmark } from '../src/features/types';
import type { PathPrim, TextPrim } from '../src/scene/types';
import { cityData, cityProject, SEATTLE } from './fixture';

const place = (id: string, name: string, dLat: number, dLon: number, note?: string): Landmark =>
  ({ id, name, kind: 'custom', lat: SEATTLE.lat + dLat, lon: SEATTLE.lon + dLon, icon: 'default', ...(note ? { note } : {}) });
const len = (l: XY[]) => l.reduce((a, p, i) => (i ? a + Math.hypot(p[0] - l[i - 1]![0], p[1] - l[i - 1]![1]) : 0), 0);

describe('route geometry', () => {
  const pts: XY[] = [[0, 0], [50, 10], [80, 60]];

  it('stops keep the chosen order, and a removed landmark drops out', () => {
    const custom = [place('custom-1', 'A', 0, 0), place('custom-2', 'B', 0, 0), place('custom-3', 'C', 0, 0)];
    const r = { stops: ['custom-3', 'gone', 'custom-1'] } as Parameters<typeof routeStops>[0];
    expect(routeStops(r, custom).map((s) => s.name)).toEqual(['C', 'A']);
  });

  it('straight legs join the stops; curved legs pass through every stop too', () => {
    expect(routeLegs(pts, false)).toEqual([[[0, 0], [50, 10]], [[50, 10], [80, 60]]]);
    const curved = routeLegs(pts, true);
    expect(curved).toHaveLength(2);
    expect(curved[0]![0]).toEqual([0, 0]);
    for (const [a, b] of [[curved[0]!.at(-1)!, pts[1]!], [curved[1]![0]!, pts[1]!], [curved[1]!.at(-1)!, pts[2]!]] as const) {
      expect(a[0]).toBeCloseTo(b[0], 6);
      expect(a[1]).toBeCloseTo(b[1], 6);
    }
    // and bends: the middle of the first leg is off the straight chord
    const mid = curved[0]![12]!;
    expect(Math.abs(mid[1] - mid[0] * 0.2)).toBeGreaterThan(0.3);
  });

  it('a leg stops short of the markers at both ends', () => {
    const t = trimLeg([[0, 0], [20, 0]], 3);
    expect(t[0]).toEqual([3, 0]);
    expect(t.at(-1)).toEqual([17, 0]);
    expect(trimLeg([[0, 0], [5, 0]], 3)).toEqual([]);
  });

  it('the arrow sits mid-leg and points the way the route goes', () => {
    const a = flattenPath(legArrow([[0, 0], [40, 0]], 4))[0]!.pts;
    const tip = a[1]!;
    expect(tip[0]).toBeGreaterThan(20); // ahead of the middle, pointing to +x
    expect(a[0]![0]).toBeLessThan(tip[0]);
    expect(a[2]![0]).toBeLessThan(tip[0]);
    expect(legArrow([[0, 0], [5, 0]], 4)).toBe(''); // too short a leg for an arrow
  });

  it('along: the point and direction a distance along a line', () => {
    expect(along([[0, 0], [10, 0], [10, 10]], 15)).toEqual({ p: [10, 5], dir: [0, 1] });
  });

  it('dotted and dashed patterns grow with the line', () => {
    expect(routeDash('solid', 0.3)).toBeUndefined();
    expect(routeDash('dotted', 0.3)![0]).toBe(0);
    expect(routeDash('dashed', 1)![0]).toBeGreaterThan(routeDash('dashed', 0.3)![0]!);
  });
});

describe('the route on the map', () => {
  const withRoute = (edit: (p: ReturnType<typeof cityProject>) => void = () => {}) => cityProject((p) => {
    p.custom = [
      place('custom-1', 'Where we met', -0.006, -0.008, 'a rainy Tuesday, 2009'),
      place('custom-2', 'First flat', 0.004, -0.002),
      place('custom-3', 'Wedding', 0.007, 0.008, 'June 2014'),
    ];
    p.route = { ...p.route, enabled: true, stops: ['custom-1', 'custom-2', 'custom-3'] };
    edit(p);
  });
  const prims = (p: ReturnType<typeof cityProject>) => buildScene(p, cityData()).prims;
  const routeOf = (p: ReturnType<typeof cityProject>) => prims(p).filter((x): x is PathPrim => x.kind === 'path' && x.part === 'route');
  const texts = (p: ReturnType<typeof cityProject>) => prims(p).filter((x): x is TextPrim => x.kind === 'text');

  it('is off until switched on, and new projects have none', () => {
    expect(cityProject().route.enabled).toBe(false);
    expect(routeOf(withRoute((p) => { p.route.enabled = false; }))).toHaveLength(0);
  });

  it('draws a dotted line with an arrow on each leg', () => {
    const r = routeOf(withRoute());
    expect(r).toHaveLength(2);
    expect(r[0]!.dash![0]).toBe(0);
    expect(flattenPath(r[1]!.d)).toHaveLength(2);
    expect(routeOf(withRoute((p) => { p.route.arrows = false; }))).toHaveLength(1);
  });

  it('numbers the stops on the map and lists them, with notes, in a key under it', () => {
    const t = texts(withRoute()).map((x) => x.text);
    expect(t).toContain('1. Where we met');
    expect(t).toContain('2. First flat');
    expect(t).toContain('1. Where we met — a rainy Tuesday, 2009');
    expect(t).toContain('2. First flat');
    expect(t).toContain('3. Wedding — June 2014');
    const plain = texts(withRoute((p) => { p.route.numbers = false; p.route.key = false; })).map((x) => x.text);
    expect(plain).toContain('Where we met');
    expect(plain.some((x) => x.includes('—'))).toBe(false);
  });

  it('the key sits under the map, above the title', () => {
    const p = withRoute();
    const frame = viewOf(p)!.frame;
    const all = texts(p);
    const key = all.filter((x) => x.part === 'routeKey');
    const title = all.find((x) => x.part === 'title')!;
    expect(key).toHaveLength(3);
    for (const k of key) { expect(k.y).toBeGreaterThan(frame.y + frame.h); expect(k.y).toBeLessThan(title.y); }
  });

  it('map lines are cut away either side of the route', () => {
    const nearRoute = (clearMm: number) => {
      const p = withRoute((q) => { q.route.clearMm = clearMm; q.route.style = 'solid'; q.route.arrows = false; });
      const all = prims(p);
      const line = flattenPath(all.find((x): x is PathPrim => x.kind === 'path' && x.part === 'route')!.d).flatMap((s) => s.pts);
      const streets = all.filter((x): x is PathPrim => x.kind === 'path' && ['minor', 'secondary', 'major'].includes(x.part ?? ''));
      // street points are 0.25 mm apart only near a clear zone, so sample the street lines finely first
      const pts = streets.flatMap((x) => flattenPath(x.d).flatMap((s) => s.pts.flatMap((q, i) => {
        if (!i) return [q];
        const a = s.pts[i - 1]!, n = Math.ceil(Math.hypot(q[0] - a[0], q[1] - a[1]) / 0.25);
        return Array.from({ length: n }, (_, k): XY => [a[0] + ((q[0] - a[0]) * (k + 1)) / n, a[1] + ((q[1] - a[1]) * (k + 1)) / n]);
      })));
      return pts.filter((pt) => line.some((q) => Math.hypot(q[0] - pt[0], q[1] - pt[1]) < 1.5)).length;
    };
    expect(nearRoute(0)).toBeGreaterThan(0); // the route does cross streets
    expect(nearRoute(2)).toBe(0);
  });

  it('plots heavy dots as small discs: a tap in the middle and a ring round it, inside the dot', () => {
    const fake = { unitsPerEm: 1000, charToGlyph: () => ({ advanceWidth: 500, getPath: () => ({ toPathData: () => 'M0 0L1 1', commands: [] }) }) };
    const p = withRoute((q) => { q.route.arrows = false; q.route.weightMm = 0.78; });
    const out = prepareScene(buildScene(p, cityData()), 'plotter', { sans: fake, serif: fake } as unknown as FontSet, { pens: p.pens });
    const subs = out.prims.filter((x): x is PathPrim => x.kind === 'path' && x.part === 'route').flatMap((x) => flattenPath(x.d));
    const taps = subs.filter((s) => len(s.pts) < 0.1);
    const rings = subs.filter((s) => s.closed);
    expect(taps.length).toBeGreaterThan(20);
    expect(rings).toHaveLength(taps.length);
    for (const r of rings) {
      const xs = r.pts.map((q) => q[0]);
      // the ring's centre line sits half a pen in from the dot's edge
      expect((Math.max(...xs) - Math.min(...xs)) / 2).toBeCloseTo((0.78 - 0.3) / 2, 2);
    }
  });

  it('plots thin dots as pen taps, not a solid line', () => {
    const fake = { unitsPerEm: 1000, charToGlyph: () => ({ advanceWidth: 500, getPath: () => ({ toPathData: () => 'M0 0L1 1', commands: [] }) }) };
    const p = withRoute((q) => { q.route.arrows = false; q.route.weightMm = 0.3; });
    const out = prepareScene(buildScene(p, cityData()), 'plotter', { sans: fake, serif: fake } as unknown as FontSet, { pens: p.pens });
    const route = out.prims.filter((x): x is PathPrim => x.kind === 'path' && x.part === 'route');
    const dots = route.flatMap((x) => flattenPath(x.d));
    expect(dots.length).toBeGreaterThan(20);
    for (const d of dots) expect(len(d.pts)).toBeLessThan(0.1);
  });
});
