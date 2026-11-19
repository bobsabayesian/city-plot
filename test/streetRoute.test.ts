import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildGraph, MAX_SNAP_M, streetPath } from '../src/features/streetRoute';
import { decodeCityTile } from '../src/city/tiles';
import type { LayerData, Way } from '../src/city/types';
import { buildScene } from '../src/scene/buildScene';
import { flattenPath } from '../src/export/offset';
import type { PathPrim } from '../src/scene/types';
import { cityProject, SEATTLE } from './fixture';

// a street grid near Seattle, 0.001° apart (about 111 m north-south, 75 m east-west)
const D = 0.001;
const at = (i: number, j: number): [number, number] => [SEATTLE.lat + i * D, SEATTLE.lon + j * D];
const line = (id: string, ...pts: [number, number][]): Way => ({ id, closed: false, pts: pts.flat() });
const layer = (...ways: Way[]): LayerData => ({ covers: { minLat: 47, maxLat: 48, minLon: -123, maxLon: -122 }, ways });
const metres = (path: [number, number][]) => path.reduce((s, p, i) => {
  if (!i) return 0;
  const q = path[i - 1]!;
  return s + Math.hypot((p[0] - q[0]) * 111_320, (p[1] - q[1]) * 111_320 * Math.cos((p[0] * Math.PI) / 180));
}, 0);
/** a 4 x 4 grid of minor streets */
const grid = () => {
  const ways: Way[] = [];
  for (let i = 0; i < 4; i++) ways.push(line(`r${i}`, at(i, 0), at(i, 1), at(i, 2), at(i, 3)));
  for (let j = 0; j < 4; j++) ways.push(line(`c${j}`, at(0, j), at(1, j), at(2, j), at(3, j)));
  return ways;
};

describe('walking along the streets', () => {
  it('goes round the blocks: corner to corner is the walk along the grid, not the diagonal', () => {
    const g = buildGraph({ minor: layer(...grid()) })!;
    const path = streetPath(g, { lat: at(0, 0)[0], lon: at(0, 0)[1] }, { lat: at(3, 3)[0], lon: at(3, 3)[1] })!;
    const walked = metres(path);
    const blocks = 3 * D * 111_320 + 3 * D * 111_320 * Math.cos((SEATTLE.lat * Math.PI) / 180);
    expect(walked).toBeCloseTo(blocks, -1);
    // every point of the walk is on the grid
    for (const [la, lo] of path) {
      const onRow = Math.abs((la - SEATTLE.lat) / D - Math.round((la - SEATTLE.lat) / D)) < 1e-6;
      const onCol = Math.abs((lo - SEATTLE.lon) / D - Math.round((lo - SEATTLE.lon) / D)) < 1e-6;
      expect(onRow || onCol).toBe(true);
    }
  });

  it('starts and ends at the stops themselves, stepping on and off the nearest street', () => {
    const g = buildGraph({ minor: layer(...grid()) })!;
    const from = { lat: at(0, 0)[0] + 0.0001, lon: at(0, 0)[1] + 0.0001 };
    const path = streetPath(g, from, { lat: at(2, 2)[0], lon: at(2, 2)[1] })!;
    expect(path[0]).toEqual([from.lat, from.lon]);
    expect(path.at(-1)).toEqual(at(2, 2));
  });

  it('a street cut at a map tile edge still joins up (its ends a fraction of a metre apart)', () => {
    const cut = [line('a', at(0, 0), [at(0, 1)[0], at(0, 1)[1] + 0.000004]), line('b', at(0, 1), at(0, 2))];
    const g = buildGraph({ minor: layer(...cut) })!;
    expect(streetPath(g, { lat: at(0, 0)[0], lon: at(0, 0)[1] }, { lat: at(0, 2)[0], lon: at(0, 2)[1] })).toBeDefined();
  });

  it('no walk between streets that do not meet, or to a stop far from any street', () => {
    const g = buildGraph({ minor: layer(line('a', at(0, 0), at(0, 1)), line('b', at(3, 0), at(3, 1))) })!;
    expect(streetPath(g, { lat: at(0, 0)[0], lon: at(0, 0)[1] }, { lat: at(3, 0)[0], lon: at(3, 0)[1] })).toBeUndefined();
    const far = { lat: at(0, 0)[0] + (MAX_SNAP_M * 2) / 111_320, lon: at(0, 0)[1] };
    expect(streetPath(g, far, { lat: at(0, 1)[0], lon: at(0, 1)[1] })).toBeUndefined();
  });

  it('prefers side streets to a main road when the difference is small', () => {
    // two ways from A to B: a main road straight along, and side streets one block round (20% longer)
    const main = line('m', at(0, 0), at(0, 4));
    const side = [line('s1', at(0, 0), [at(0, 0)[0] + D * 0.3, at(0, 0)[1]]), line('s2', [at(0, 0)[0] + D * 0.3, at(0, 0)[1]], [at(0, 4)[0] + D * 0.3, at(0, 4)[1]]), line('s3', [at(0, 4)[0] + D * 0.3, at(0, 4)[1]], at(0, 4))];
    const g = buildGraph({ major: layer(main), minor: layer(...side) })!;
    const path = streetPath(g, { lat: at(0, 0)[0], lon: at(0, 0)[1] }, { lat: at(0, 4)[0], lon: at(0, 4)[1] })!;
    expect(path.some(([la]) => la > at(0, 0)[0] + D * 0.2)).toBe(true);
  });

  it('real streets: Pike Place Market to Pioneer Square through downtown Seattle', () => {
    const tiles = [[14, 2624, 5721], [14, 2625, 5721], [14, 2624, 5722]] as const;
    const dec = tiles.map(([z, x, y]) => decodeCityTile(new Uint8Array(readFileSync(`test/fixtures/tiles/${z}-${x}-${y}.pbf`)), z, x, y));
    const layers = Object.fromEntries((['paths', 'minor', 'secondary', 'major'] as const).map((k) => [k, layer(...dec.flatMap((d) => d.ways[k]))]));
    const t = performance.now();
    const g = buildGraph(layers)!;
    const pike = { lat: 47.6094, lon: -122.3417 }, pioneer = { lat: 47.6015, lon: -122.3343 };
    const path = streetPath(g, pike, pioneer)!;
    expect(performance.now() - t).toBeLessThan(2000);
    const straight = metres([[pike.lat, pike.lon], [pioneer.lat, pioneer.lon]]);
    expect(metres(path)).toBeGreaterThan(straight);
    expect(metres(path)).toBeLessThan(straight * 1.6);
  });
});

describe('the route on the map, along the streets', () => {
  const project = (extra: Partial<{ far: boolean }> = {}) => cityProject((q) => {
    q.custom = [
      { id: 'custom-1', name: 'A', kind: 'custom', lat: at(0, 0)[0], lon: at(0, 0)[1] },
      { id: 'custom-2', name: 'B', kind: 'custom', lat: at(3, 3)[0], lon: at(3, 3)[1] },
      ...(extra.far ? [{ id: 'custom-3', name: 'C', kind: 'custom' as const, lat: at(3, 3)[0] + 0.01, lon: at(3, 3)[1] }] : []),
    ];
    q.route = { ...q.route, enabled: true, stops: q.custom.map((c) => c.id), streets: true, style: 'solid', arrows: false, clearMm: 0 };
  });
  const data = { layers: { minor: layer(...grid()) }, landmarks: [] };
  const toSeg = (q: [number, number], a: [number, number], b: [number, number]) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / l2)) : 0;
    return Math.hypot(q[0] - a[0] - t * dx, q[1] - a[1] - t * dy);
  };

  it('every corner of the route lies on a street drawn on the map', () => {
    const prims = buildScene(project(), data).prims;
    const route = prims.find((x): x is PathPrim => x.kind === 'path' && x.part === 'route')!;
    const streets = prims.filter((x): x is PathPrim => x.kind === 'path' && x.part === 'minor').flatMap((x) => flattenPath(x.d).map((s) => s.pts));
    const corners = flattenPath(route.d).flatMap((s) => s.pts);
    expect(corners.length).toBeGreaterThan(3);
    for (const q of corners) {
      const d = Math.min(...streets.flatMap((l) => l.slice(1).map((b, i) => toSeg(q, l[i]!, b))));
      expect(d).toBeLessThan(0.1);
    }
  });

  it('a leg it cannot find along the streets keeps its curve, and says so', async () => {
    const { composeScene } = await import('../src/scene/buildScene');
    expect(composeScene(project(), data).routeMisses).toBe(0);
    expect(composeScene(project({ far: true }), data).routeMisses).toBe(1);
  });
});
