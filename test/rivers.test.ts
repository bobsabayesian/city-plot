import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'opentype.js';
import { bestStretch, placeLandmarks, riverStretches, stitchRivers, type PlaceInput } from '../src/features/select';
import { defaultFeatures, type WaterLine } from '../src/features/types';
import { fitBBox } from '../src/geo/project';
import type { XY } from '../src/geo/clip';
import { buildScene } from '../src/scene/buildScene';
import { defaultProject } from '../src/scene/project';
import { sampleTrack } from '../src/sample';
import { sceneToSvg } from '../src/export/svg';
import { prepareScene, textToPath, type FontSet } from '../src/export/outlines';
import type { TextPrim } from '../src/scene/types';

const B = { minLat: 46, maxLat: 46.2, minLon: -121.4, maxLon: -121 };
const frame = { x: 20, y: 20, w: 300, h: 400 };
const fit = fitBBox(B, frame);
const river = (id: string, name: string | undefined, coords: [number, number][]): WaterLine => ({ id, kind: 'river', name, coords });
const settings = () => ({ ...defaultFeatures(), waterLabels: true });
const input = (water: WaterLine[], over: Partial<PlaceInput> = {}): PlaceInput => ({
  landmarks: [], water, fit, frame, route: [], settings: settings(), sizeMm: 4, markerR: 2, ...over,
});
/** A west-east river along one latitude, from lonA to lonB. */
const flat = (id: string, name: string, lat: number, lonA: number, lonB: number) => river(id, name, [[lat, lonA], [lat, lonB]]);

describe('stitchRivers', () => {
  it('joins pieces that share an end point, whichever way they run', () => {
    const chains = stitchRivers([
      river('w1', 'Big River', [[46.1, -121.3], [46.1, -121.2]]),
      river('w2', 'Big River', [[46.1, -121.1], [46.1, -121.2]]), // runs the other way
      river('w3', 'Big River', [[46.1, -121.1], [46.1, -121.0]]),
    ]);
    expect(chains).toHaveLength(1);
    expect(chains[0]!.coords).toHaveLength(4);
    const lons = chains[0]!.coords.map((c) => c[1]);
    expect(lons).toEqual([...lons].sort((a, b) => a - b).length === 4 && lons[0]! < lons[3]! ? lons : [...lons].reverse());
    expect(Math.min(...lons)).toBe(-121.3);
    expect(Math.max(...lons)).toBe(-121.0);
  });
  it('keeps different names apart, and unconnected pieces as separate stretches', () => {
    const chains = stitchRivers([
      river('w1', 'A Creek', [[46.1, -121.3], [46.1, -121.2]]),
      river('w2', 'B Creek', [[46.1, -121.3], [46.1, -121.2]]),
      river('w3', 'A Creek', [[46.15, -121.3], [46.15, -121.2]]),
    ]);
    expect(chains.map((c) => c.name).sort()).toEqual(['A Creek', 'A Creek', 'B Creek']);
    expect(new Set(chains.map((c) => c.id)).size).toBe(3);
  });
  it('ignores lakes and unnamed rivers, and matches names case-insensitively', () => {
    const chains = stitchRivers([
      { id: 'w1', kind: 'lake', name: 'Lake', coords: [[1, 1], [2, 2]] },
      river('w2', undefined, [[1, 1], [2, 2]]),
      river('w3', 'Sky River', [[46.1, -121.3], [46.1, -121.2]]),
      river('w4', 'SKY RIVER', [[46.1, -121.2], [46.1, -121.1]]),
    ]);
    expect(chains).toHaveLength(1);
    expect(chains[0]!.coords).toHaveLength(3);
  });
});

describe('bestStretch', () => {
  const bounds = { x: 0, y: 0, w: 300, h: 300 };
  it('runs along a straight river, centered, level', () => {
    const r = bestStretch([[20, 100], [220, 100]], 40, 4, bounds)!;
    expect(r.angle).toBeCloseTo(0, 5);
    expect(r.x).toBeCloseTo(120, 0);
    expect(r.y).toBeCloseTo(100, 5);
    expect(r.visible).toBeCloseTo(200, 5);
  });
  it('gives up when the river is too short for the text', () => {
    expect(bestStretch([[20, 100], [50, 100]], 40, 4, bounds)).toBeUndefined();
  });
  it('keeps text upright whichever way the river is drawn', () => {
    for (const line of [[[220, 100], [20, 100]], [[200, 250], [50, 50]], [[50, 50], [200, 250]], [[100, 20], [100, 250]]] as XY[][]) {
      const r = bestStretch(line, 40, 4, bounds)!;
      expect(Math.cos(r.angle)).toBeGreaterThanOrEqual(0);
    }
    expect(bestStretch([[220, 100], [20, 100]], 40, 4, bounds)!.angle).toBeCloseTo(0, 5);
  });
  it('follows the slope of a diagonal river', () => {
    const r = bestStretch([[50, 250], [250, 50]], 40, 4, bounds)!;
    expect((r.angle * 180) / Math.PI).toBeCloseTo(-45, 3); // rising to the right on screen
  });
  it('prefers the straight stretch over a hairpin', () => {
    const line: XY[] = [[20, 100], [150, 100], [152, 90], [148, 80], [152, 70], [148, 60]];
    const r = bestStretch(line, 40, 4, bounds)!;
    expect(r.x).toBeLessThan(140);
    expect(Math.abs(r.angle)).toBeLessThan(0.05);
  });
  it('only uses the part of the river inside the bounds', () => {
    const r = bestStretch([[-200, 100], [100, 100]], 40, 4, bounds)!;
    expect(r.visible).toBeCloseTo(100, 5);
    expect(r.x).toBeGreaterThanOrEqual(0);
  });
});

describe('separate quotas for points and water names', () => {
  const peaks = Array.from({ length: 12 }, (_, i) => ({ id: `n${i}`, name: `Peak ${i}`, kind: 'peak' as const, lat: 46.03 + i * 0.012, lon: -121.33 + (i % 3) * 0.1, ele: 2000 + i }));
  const rivers = [
    flat('w1', 'Alpha River', 46.05, -121.35, -121.05),
    flat('w2', 'Bravo River', 46.12, -121.35, -121.05),
    flat('w3', 'Charlie River', 46.19 - 0.005, -121.35, -121.05),
  ];
  const run = (maxLabels: number, maxWaterLabels: number) => {
    const s = settings();
    s.maxLabels = maxLabels;
    s.maxWaterLabels = maxWaterLabels;
    const { labels } = placeLandmarks(input(rivers, { landmarks: peaks, settings: s }));
    return { points: labels.filter((l) => l.kind === 'peak').length, water: labels.filter((l) => l.kind === 'river').length };
  };
  it('a crowd of peaks cannot push every river name out', () => {
    const r = run(8, 2);
    expect(r.points).toBeGreaterThan(0);
    expect(r.points).toBeLessThanOrEqual(8);
    expect(r.water).toBe(2);
  });
  it('each quota is respected on its own', () => {
    expect(run(3, 3).points).toBeLessThanOrEqual(3);
    expect(run(8, 1).water).toBe(1);
  });
  it('zero turns one group off without affecting the other', () => {
    expect(run(8, 0).water).toBe(0);
    expect(run(8, 0).points).toBeGreaterThan(0);
    expect(run(0, 3)).toMatchObject({ points: 0 });
    expect(run(0, 3).water).toBeGreaterThan(0);
  });
  it('defaults: 8 point labels, 4 water names', () => {
    expect(defaultFeatures()).toMatchObject({ maxLabels: 8, maxWaterLabels: 4 });
  });
});

describe('river labels: other stretches', () => {
  it('move to a clear stretch when the route crosses the best one', () => {
    const [rx, ry] = fit.toMm(46.1, -121.2);
    const route: XY[] = [[rx - 10, ry - 40], [rx + 10, ry + 40]]; // crosses the middle of the river
    const l = placeLandmarks(input([flat('w1', 'Cowlitz River', 46.1, -121.35, -121.05)], { route })).labels[0]!;
    expect(l).toBeDefined();
    expect(Math.abs(l.x - rx)).toBeGreaterThan(15); // away from the crossing
  });
  it('riverStretches returns spaced-out options, best first', () => {
    const r = riverStretches([[10, 100], [290, 100]], 40, 4, { x: 0, y: 0, w: 300, h: 300 });
    expect(r.stretches.length).toBeGreaterThan(2);
    expect(Math.abs(r.stretches[0]!.x - 150)).toBeLessThan(Math.abs(r.stretches[2]!.x - 150) + 1e-6);
    for (let i = 1; i < r.stretches.length; i++)
      expect(Math.min(...r.stretches.slice(0, i).map((o) => Math.abs(o.x - r.stretches[i]!.x)))).toBeGreaterThanOrEqual(40 - 1e-6);
  });
});

describe('river labels', () => {
  const y0 = fit.toMm(46.1, -121.2)[1];
  it('are off unless "water labels" is on', () => {
    const s = defaultFeatures();
    expect(placeLandmarks(input([flat('w1', 'Cowlitz River', 46.1, -121.35, -121.05)], { settings: s })).labels).toHaveLength(0);
    expect(placeLandmarks(input([flat('w1', 'Cowlitz River', 46.1, -121.35, -121.05)])).labels).toHaveLength(1);
  });
  it('write the name along the river, just above it, without a marker', () => {
    const { labels, entries } = placeLandmarks(input([flat('w1', 'Cowlitz River', 46.1, -121.35, -121.05)]));
    const l = labels[0]!;
    expect(l).toMatchObject({ kind: 'river', text: 'Cowlitz River', anchor: 'middle' });
    expect(l.marker).toBeUndefined();
    expect(l.rotate ?? 0).toBeCloseTo(0, 5);
    expect(l.y).toBeLessThan(y0); // baseline above the line (y grows downward)
    expect(l.y).toBeGreaterThan(y0 - 6);
    expect(entries[0]).toMatchObject({ kind: 'river', placed: true, name: 'Cowlitz River' });
  });
  it('tilt with a diagonal river', () => {
    const w = river('w1', 'Diagonal Creek', [[46.02, -121.35], [46.18, -121.05]]);
    const l = placeLandmarks(input([w])).labels[0]!;
    expect(Math.abs(l.rotate!)).toBeGreaterThan(20);
    expect(Math.abs(l.rotate!)).toBeLessThanOrEqual(90);
  });
  it('label a river split into several pieces only once', () => {
    const { labels } = placeLandmarks(input([
      flat('w1', 'Split River', 46.1, -121.35, -121.25),
      flat('w2', 'Split River', 46.1, -121.25, -121.15),
      flat('w3', 'Split River', 46.1, -121.15, -121.05),
    ]));
    expect(labels).toHaveLength(1);
  });
  it('are skipped when the river is too short for its name, or off the map', () => {
    expect(placeLandmarks(input([flat('w1', 'A Very Long River Name Indeed', 46.1, -121.2, -121.19)])).labels).toHaveLength(0);
    expect(placeLandmarks(input([flat('w1', 'Far River', 47, -121.3, -121.1)])).labels).toHaveLength(0);
  });
  it('move below the river when the route runs just above it', () => {
    const [rx, ry] = fit.toMm(46.1, -121.2);
    const route: XY[] = [[rx - 150, ry - 4], [rx + 150, ry - 4]]; // hugging the river, on top
    const l = placeLandmarks(input([flat('w1', 'Cowlitz River', 46.1, -121.35, -121.05)], { route })).labels[0]!;
    expect(l.y).toBeGreaterThan(ry); // dropped to the other side
  });
  it('are not written over a route that runs on both sides of the whole river', () => {
    const [rx, ry] = fit.toMm(46.1, -121.2);
    const route: XY[] = [[rx - 150, ry - 4], [rx + 150, ry - 4], [rx + 150, ry + 3], [rx - 150, ry + 3]];
    expect(placeLandmarks(input([flat('w1', 'Cowlitz River', 46.1, -121.35, -121.05)], { route })).labels).toHaveLength(0);
  });
  it('can be hidden or renamed per river', () => {
    const w = [flat('w1', 'Cowlitz River', 46.1, -121.35, -121.05)];
    const s = settings();
    s.overrides['riv-cowlitz river'] = { name: 'Cowlitz' };
    expect(placeLandmarks(input(w, { settings: s })).labels[0]!.text).toBe('Cowlitz');
    s.overrides['riv-cowlitz river'] = { hidden: true };
    const r = placeLandmarks(input(w, { settings: s }));
    expect(r.labels).toHaveLength(0);
    expect(r.entries[0]).toMatchObject({ hidden: true, placed: false });
  });
  it('two rivers on top of each other do not get overlapping names', () => {
    const { labels } = placeLandmarks(input([
      flat('w1', 'Alpha River', 46.1, -121.35, -121.05),
      flat('w2', 'Bravo River', 46.1, -121.35, -121.05),
    ]));
    if (labels.length === 2) expect(Math.abs(labels[0]!.y - labels[1]!.y)).toBeGreaterThan(3);
    expect(labels.length).toBeGreaterThanOrEqual(1);
  });
});

describe('tilted text in exports', () => {
  const load = (path: string) => { const b = readFileSync(path); return parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
  const fonts = {
    sans: load('node_modules/@fontsource/inter/files/inter-latin-400-normal.woff'),
    serif: load('node_modules/@fontsource/source-serif-4/files/source-serif-4-latin-400-normal.woff'),
  } as unknown as FontSet;
  const t: TextPrim = { kind: 'text', text: 'River', x: 100, y: 100, anchor: 'middle', sizeMm: 10, trackingMm: 0.5, fontFamily: 'x', fontKey: 'sans', color: '#000' };
  const pts = (d: string): XY[] => { const n = d.match(/-?\d+(\.\d+)?/g)!.map(Number); const out: XY[] = []; for (let i = 0; i + 1 < n.length; i += 2) out.push([n[i]!, n[i + 1]!]); return out; };
  const extent = (d: string) => { const p = pts(d); const xs = p.map((q) => q[0]); const ys = p.map((q) => q[1]); return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), cx: (Math.max(...xs) + Math.min(...xs)) / 2, cy: (Math.max(...ys) + Math.min(...ys)) / 2 }; };

  it('SVG live text gets a rotate transform about its anchor; level text gets none', () => {
    const base = { widthMm: 200, heightMm: 200, paper: '#fff' };
    expect(sceneToSvg({ ...base, prims: [{ ...t, rotate: -30 }] })).toContain('transform="rotate(-30 100 100)"');
    expect(sceneToSvg({ ...base, prims: [t] })).not.toContain('transform');
  });
  it('outlined text turns about the anchor point', () => {
    const level = extent(textToPath(t, fonts));
    const up = extent(textToPath({ ...t, rotate: 90 }, fonts));
    expect(level.w).toBeGreaterThan(level.h);
    expect(up.h).toBeGreaterThan(up.w); // now vertical
    expect(up.h).toBeCloseTo(level.w, 0); // same length, just turned
    expect(up.cy).toBeCloseTo(100, 0); // still centered on the anchor along the text (text-anchor middle)
    expect(textToPath({ ...t, rotate: 0 }, fonts)).toBe(textToPath(t, fonts));
  });
  it('180 degrees mirrors the outline through the anchor', () => {
    const level = extent(textToPath(t, fonts));
    const flipped = extent(textToPath({ ...t, rotate: 180 }, fonts));
    expect(flipped.w).toBeCloseTo(level.w, 2);
    expect(flipped.cy - 100).toBeCloseTo(-(level.cy - 100), 1);
  });
  it('river names survive print and plotter export as outlines', () => {
    const p = { ...defaultProject(), points: sampleTrack() };
    p.features.waterLabels = true;
    const osm = {
      landmarks: [],
      water: [river('w1', 'Nisqually River', [[46.79, -121.74], [46.83, -121.66]])],
      covers: B,
    };
    const scene = buildScene(p, undefined, osm);
    const named = scene.prims.find((x) => x.kind === 'text' && x.text === 'Nisqually River') as TextPrim;
    expect(named.rotate).toBeDefined();
    for (const mode of ['print', 'plotter'] as const) {
      const out = prepareScene(scene, mode, fonts);
      expect(out.prims.some((x) => x.kind === 'text')).toBe(false);
    }
  });
});

describe('water settings in the scene', () => {
  const osm = { landmarks: [], water: [flat('w1', 'Nisqually River', 46.805, -121.78, -121.62)], covers: B };
  const run = (f: (p: ReturnType<typeof defaultProject>) => void) => {
    const p = { ...defaultProject(), points: sampleTrack() };
    f(p);
    const prims = buildScene(p, undefined, osm).prims;
    return {
      outline: prims.some((x) => x.kind === 'path' && x.widthMm === p.features.waterWeightMm),
      label: prims.some((x) => x.kind === 'text' && x.text === 'Nisqually River'),
    };
  };
  it('default: outlines drawn, names not', () => expect(run(() => {})).toEqual({ outline: true, label: false }));
  it('labels without outlines', () => expect(run((p) => { p.features.water = false; p.features.waterLabels = true; })).toEqual({ outline: false, label: true }));
  it('both', () => expect(run((p) => { p.features.waterLabels = true; })).toEqual({ outline: true, label: true }));
  it('neither', () => expect(run((p) => { p.features.water = false; })).toEqual({ outline: false, label: false }));
});
