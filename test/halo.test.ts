import { describe, expect, it } from 'vitest';
import { cutOutHalos } from '../src/features/halo';
import { placeLandmarks } from '../src/features/select';
import { defaultFeatures, type Landmark } from '../src/features/types';
import { fitBBox } from '../src/geo/project';
import type { XY } from '../src/geo/clip';
import { buildScene } from '../src/scene/buildScene';
import { cityData, cityProject, SEATTLE } from './fixture';

const box = { cx: 50, cy: 50, w: 20, h: 4, ang: 0 };
const len = (ls: XY[][]) => ls.reduce((n, l) => n + l.reduce((m, q, i) => m + (i ? Math.hypot(q[0] - l[i - 1]![0], q[1] - l[i - 1]![1]) : 0), 0), 0);

describe('clearing map lines around a label', () => {
  it('does nothing without halos', () => {
    const lines: XY[][] = [[[0, 0], [100, 100]]];
    expect(cutOutHalos(lines, [])).toBe(lines);
  });
  it('cuts the part of a line inside the box plus the margin, and keeps the rest', () => {
    const line: XY[][] = [[[0, 50], [100, 50]]];
    const out = cutOutHalos(line, [{ box, r: 5 }]);
    expect(out).toHaveLength(2);
    // box is 20 wide (+5 each side) so 30 mm are removed from 100
    expect(len(out)).toBeGreaterThan(69);
    expect(len(out)).toBeLessThan(71);
    expect(out[0]![out[0]!.length - 1]![0]).toBeLessThanOrEqual(35.3);
    expect(out[1]![0]![0]).toBeGreaterThanOrEqual(64.7);
  });
  it('a bigger radius clears more', () => {
    const line: XY[][] = [[[0, 50], [100, 50]]];
    expect(len(cutOutHalos(line, [{ box, r: 12 }]))).toBeLessThan(len(cutOutHalos(line, [{ box, r: 3 }])));
  });
  it('leaves lines that are far away exactly as they were', () => {
    const line: XY[][] = [[[0, 10], [100, 12], [100, 90]]];
    expect(cutOutHalos(line, [{ box, r: 5 }])).toEqual(line);
  });
  it('drops a line completely inside the zone', () => {
    expect(cutOutHalos([[[45, 49], [55, 51]]], [{ box, r: 1 }])).toEqual([]);
  });
});

describe('halos from placed labels', () => {
  const frame = { x: 20, y: 20, w: 300, h: 400 };
  const fit = fitBBox({ minLat: 46, maxLat: 46.2, minLon: -121.4, maxLon: -121 }, frame);
  const th: Landmark = { id: 'th', name: 'Union Station', kind: 'station', lat: 46.1, lon: -121.2 };
  const run = (over = {}, clearMm = 0) => placeLandmarks({
    landmarks: [th], water: [], fit, frame, route: [], settings: { ...defaultFeatures(), clearMm, ...over }, sizeMm: 4, markerR: 2,
  });
  it('none when the radius is 0', () => { expect(run().halos).toEqual([]); });
  it('on by default in the settings, so labels have clear paper', () => { expect(defaultFeatures().clearMm).toBeGreaterThan(0); });
  it('the general radius gives the label and its marker a zone', () => {
    const h = run({}, 6).halos;
    expect(h).toHaveLength(2);
    expect(h.every((z) => z.r === 6)).toBe(true);
  });
  it('a landmark\'s own radius wins, and 0 switches it off for that one', () => {
    expect(run({ overrides: { th: { clearMm: 10 } } }, 6).halos.every((z) => z.r === 10)).toBe(true);
    expect(run({ overrides: { th: { clearMm: 0 } } }, 6).halos).toEqual([]);
  });
});

describe('halos in the map', () => {
  it('map lines are cut away around a label, and not when clearing is off', () => {
    const p = cityProject((q) => { q.features.kinds.station = true; q.features.clearMm = 0; });
    const data = cityData();
    // a station in the middle of the fixture's street grid
    data.landmarks = [{ id: 'n9', name: 'Central Station', kind: 'station', lat: SEATTLE.lat + 0.002, lon: SEATTLE.lon }];
    const minorPieces = (q: typeof p) => (buildScene(q, data).prims.find((x) => x.kind === 'path' && x.part === 'minor') as { d: string } | undefined)?.d.split('M').length ?? 0;
    const off = minorPieces(p);
    p.features.clearMm = 4;
    expect(minorPieces(p)).toBeGreaterThan(off); // lines that ran through the label are now in two pieces
  });
});
