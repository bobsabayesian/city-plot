import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { traceWaterlines, waterlineLevels } from '../src/city/waterlines';
import { decodeCityTile, tilesBBox } from '../src/city/tiles';
import type { LayerData, Way } from '../src/city/types';
import type { Fit } from '../src/geo/project';
import type { XY } from '../src/geo/clip';
import { buildScene, viewOf } from '../src/scene/buildScene';
import type { PathPrim } from '../src/scene/types';
import { cityData, cityProject } from './fixture';

/** 1 degree = 1 mm, north up: "lat" is -y and "lon" is x, so test shapes can be written in mm. */
const fit: Fit = { toMm: (lat, lon) => [lon, -lat], fromMm: (x, y) => [-y, x], mercToMm: (x, y) => [x, y], metersPerMm: 1 };
const ring = (pts: XY[], extra: Partial<Way> = {}): Way => ({ id: Math.random().toString(), closed: true, pts: [...pts, pts[0]!].flatMap(([x, y]) => [-y, x]), ...extra });
const rect = (x0: number, y0: number, x1: number, y1: number): XY[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const data = (...ways: Way[]): LayerData => ({ covers: { minLat: -200, maxLat: 100, minLon: -100, maxLon: 200 }, ways });
const frame = { x: 0, y: 0, w: 100, h: 100 };
const closed = (l: XY[]) => l.length > 3 && Math.hypot(l[0]![0] - l.at(-1)![0], l[0]![1] - l.at(-1)![1]) < 1e-6;
/** distance from a point inside a rectangle to its edge */
const inset = ([x, y]: XY, [x0, y0, x1, y1]: number[]) => Math.min(x - x0!, x1! - x, y - y0!, y1! - y);

describe('waterline spacing', () => {
  it('starts one gap out and widens each gap by the spread', () => {
    expect(waterlineLevels({ count: 3, gapMm: 1, widen: 0.5 })).toEqual([1, 2.5, 4.75]);
    expect(waterlineLevels({ count: 4, gapMm: 2, widen: 0 })).toEqual([2, 4, 6, 8]);
  });
  it('none when the count is 0', () => {
    expect(waterlineLevels({ count: 0, gapMm: 1, widen: 0 })).toEqual([]);
  });
});

describe('tracing waterlines', () => {
  const lake = [20, 20, 70, 60];
  const [x0, y0, x1, y1] = lake as [number, number, number, number];

  it('a lake gets one closed line per level, each that far from the shore', () => {
    const lines = traceWaterlines(data(ring(rect(x0, y0, x1, y1))), fit, frame, { count: 3, gapMm: 2, widen: 0 });
    expect(lines).toHaveLength(3);
    for (const l of lines) expect(closed(l)).toBe(true);
    const levels = lines.map((l) => l.map((p) => inset(p, lake)));
    for (const ds of levels) {
      const mid = ds.slice().sort((a, b) => a - b)[Math.floor(ds.length / 2)]!;
      expect([2, 4, 6].some((L) => Math.abs(mid - L) < 0.15)).toBe(true);
      // along the straight shores the line stays within a fraction of a pen width of its level
      for (const d of ds) expect(Math.abs(d - mid)).toBeLessThan(0.35);
    }
  });

  it('stays out of the water outside the lake: nothing on land', () => {
    const lines = traceWaterlines(data(ring(rect(x0, y0, x1, y1))), fit, frame, { count: 4, gapMm: 1.5, widen: 0.3 });
    for (const l of lines) for (const p of l) expect(inset(p, lake)).toBeGreaterThan(1);
  });

  it('an island (a ring wound the other way) gets its own lines', () => {
    const island = rect(40, 35, 50, 45).reverse();
    const lines = traceWaterlines(data(ring(rect(x0, y0, x1, y1)), ring(island)), fit, frame, { count: 2, gapMm: 2, widen: 0 });
    expect(lines).toHaveLength(4);
    const aroundIsland = lines.filter((l) => l.every(([x, y]) => x > 30 && x < 60 && y > 25 && y < 55));
    expect(aroundIsland).toHaveLength(2);
  });

  it('a lake cut in two by a map tile edge has no lines along the cut', () => {
    const halves = [ring(rect(x0, y0, 45, y1), { fill: true }), ring(rect(45, y0, x1, y1), { fill: true })];
    const lines = traceWaterlines(data(...halves), fit, frame, { count: 3, gapMm: 2, widen: 0 });
    expect(lines).toHaveLength(3);
    for (const l of lines) for (const [x] of l) if (Math.abs(x - 45) < 1) throw new Error('line along the seam');
  });

  it('the edge of the fetched data is not a shore', () => {
    // the water fills everything that was fetched; the frame reaches past it
    const d: LayerData = { covers: { minLat: -60, maxLat: -10, minLon: 10, maxLon: 60 }, ways: [ring(rect(10, 10, 60, 60))] };
    expect(traceWaterlines(d, fit, frame, { count: 3, gapMm: 2, widen: 0 })).toEqual([]);
  });

  it('nothing without water areas', () => {
    expect(traceWaterlines(data(), fit, frame, { count: 3, gapMm: 2, widen: 0 })).toEqual([]);
  });
});

describe('waterlines on the map', () => {
  const waterStroke = (count: number) => buildScene(cityProject((p) => { p.layers.water.waterlines = { count, gapMm: 1, widen: 0.2 }; }), cityData())
    .prims.filter((x): x is PathPrim => x.kind === 'path' && x.part === 'water' && x.mode === 'stroke');

  it('are drawn in the water pen, one pass wide, only when switched on', () => {
    expect(waterStroke(0)).toHaveLength(1); // just the shore
    const on = waterStroke(4);
    expect(on).toHaveLength(2);
    expect(on[1]!.pen).toBe(on[0]!.pen);
    expect(on[1]!.widthMm).toBe(0.3);
    expect(on[1]!.d.length).toBeGreaterThan(100);
  });

  it('new projects start without them', () => {
    expect(cityProject().layers.water.waterlines?.count).toBe(0);
  });

  it('real tiles: Elliott Bay off downtown Seattle traces quickly and stays in the frame', () => {
    const tiles = [[14, 2624, 5721], [14, 2625, 5721], [14, 2624, 5722]] as const;
    const ways = tiles.flatMap(([z, x, y]) => decodeCityTile(new Uint8Array(readFileSync(`test/fixtures/tiles/${z}-${x}-${y}.pbf`)), z, x, y).ways.water);
    const covers = tilesBBox(tiles.map(([z, x, y]) => ({ z, x, y })));
    const p = cityProject((q) => { q.region = { lat: 47.605, lon: -122.345, widthKm: 2 }; });
    const view = viewOf(p)!;
    const t = performance.now();
    const lines = traceWaterlines({ covers, ways }, view.fit, view.frame, { count: 8, gapMm: 1.2, widen: 0.25 });
    const ms = performance.now() - t;
    expect(lines.length).toBeGreaterThan(5);
    expect(ms).toBeLessThan(3000);
  });
});

describe('waterlines and the fetched area', () => {
  it('stop where the fetched data stops, rather than running on into the unknown', () => {
    // a lake whose west shore is the edge of the data: land is known only east of x = 30
    const d: LayerData = { covers: { minLat: -100, maxLat: 0, minLon: 30, maxLon: 100 }, ways: [ring(rect(30, 20, 70, 60))] };
    const lines = traceWaterlines(d, fit, frame, { count: 3, gapMm: 2, widen: 0 });
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) for (const [x] of l) expect(x).toBeGreaterThanOrEqual(30 - 1e-6);
  });
});
