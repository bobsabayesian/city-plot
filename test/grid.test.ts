import { describe, expect, it } from 'vitest';
import { autoSpacingKm, fromUtm, toUtm, utmBand, utmZone } from '../src/scene/grid';
import { buildScene, viewOf } from '../src/scene/buildScene';
import { applyLook, lookById } from '../src/scene/looks';
import { flattenPath } from '../src/export/offset';
import { useStore } from '../src/store';
import type { PathPrim, TextPrim } from '../src/scene/types';
import { cityData, cityProject } from './fixture';

describe('UTM', () => {
  it('zones and bands', () => {
    expect(utmZone(-122.33)).toBe(10); // Seattle
    expect(utmZone(2.35)).toBe(31); // Paris
    expect(utmZone(180)).toBe(60);
    expect(utmBand(47.6)).toBe('T');
    expect(utmBand(-33.9)).toBe('H'); // Sydney
  });

  it('known values: the central meridian is 500 km east; 45°N on it is 4,982,950 m north', () => {
    const [e0, n0] = toUtm(0, -123, 10);
    expect(e0).toBeCloseTo(500000, 3);
    expect(n0).toBeCloseTo(0, 3);
    const [e, n] = toUtm(45, -123, 10);
    expect(e).toBeCloseTo(500000, 3);
    expect(n).toBeCloseTo(4982950.4, 0);
    // the southern hemisphere counts north from 10,000 km at the equator
    expect(toUtm(-45, -123, 10)[1]).toBeCloseTo(1e7 - 4982950.4, 0);
  });

  it('a degree of longitude at the equator, off the central meridian, is about 111 km times the 0.9996 scale', () => {
    const [e] = toUtm(0, -122, 10);
    expect(e - 500000).toBeGreaterThan(111_000);
    expect(e - 500000).toBeLessThan(111_400);
  });

  it('converts back to the same place', () => {
    for (const [lat, lon] of [[47.6062, -122.3321], [-33.87, 151.21], [51.5, -0.12]] as const) {
      const z = utmZone(lon);
      const [e, n] = toUtm(lat, lon, z);
      const [la, lo] = fromUtm(e, n, z, lat < 0, [lat + 0.05, lon - 0.05]);
      expect(la).toBeCloseTo(lat, 8);
      expect(lo).toBeCloseTo(lon, 8);
    }
  });

  it('grid spacing keeps lines at least 15 mm apart', () => {
    expect(autoSpacingKm(25000)).toBe(1); // 40 mm
    expect(autoSpacingKm(50000)).toBe(1); // 20 mm
    expect(autoSpacingKm(100000)).toBe(2);
    expect(autoSpacingKm(250000)).toBe(5);
  });
});

describe('a fixed map scale', () => {
  it('draws the map at exactly that scale, and keeps it when the page changes', () => {
    for (const sizeId of ['18x24', 'a3', '8x10']) {
      const p = cityProject((q) => { q.sizeId = sizeId; q.region!.scale = 25000; });
      expect(viewOf(p)!.scale).toBe(25000);
    }
    const free = cityProject((q) => { q.sizeId = 'a3'; });
    expect(viewOf(free)!.scale).not.toBe(25000);
  });

  it('1:50,000 covers twice the ground of 1:25,000 on the same page', () => {
    const w = (s: number) => viewOf(cityProject((q) => { q.region!.scale = s; }))!.widthKm;
    expect(w(50000) / w(25000)).toBeCloseTo(2, 6);
    // 1 mm of paper is 25 m of ground
    const v = viewOf(cityProject((q) => { q.region!.scale = 25000; }))!;
    expect(v.widthKm).toBeCloseTo((v.frame.w * 25) / 1000, 6);
  });

  it('zooming by hand lets go of the scale; moving the map keeps it', () => {
    useStore.setState({ project: cityProject((q) => { q.region!.scale = 50000; }) });
    useStore.getState().setRegion({ lat: 47.61, lon: -122.33 });
    expect(useStore.getState().project.region!.scale).toBe(50000);
    useStore.getState().setRegion({ widthKm: 3 });
    expect(useStore.getState().project.region!.scale).toBeUndefined();
    useStore.getState().setRegion({ scale: 25000, widthKm: 5 });
    expect(useStore.getState().project.region!.scale).toBe(25000);
    useStore.getState().setRegion({ scale: undefined, widthKm: 5 });
    expect('scale' in useStore.getState().project.region!).toBe(false);
  });
});

describe('the grid on the map', () => {
  const military = (edit: (p: ReturnType<typeof cityProject>) => void = () => {}) => {
    const p = cityProject((q) => { q.region!.scale = 25000; edit(q); });
    applyLook(p, lookById('military')!);
    return p;
  };

  it('off by default; the Military look turns it on, other looks off', () => {
    expect(cityProject().grid.enabled).toBe(false);
    expect(military().grid.enabled).toBe(true);
    const p = military();
    applyLook(p, lookById('classic')!);
    expect(p.grid.enabled).toBe(false);
  });

  it('draws 1 km squares: 40 mm apart at 1:25,000, with two-digit numbers in the margin outside the map', () => {
    // no landmark labels, so the grid lines run uncut from edge to edge
    const p = military((q) => { q.features.enabled = false; });
    const prims = buildScene(p, cityData()).prims;
    const frame = viewOf(p)!.frame;
    const lines = flattenPath(prims.find((x): x is PathPrim => x.kind === 'path' && x.part === 'grid')!.d);
    // north-south lines (eastings) are nearly vertical: grid north is about half a degree off true north in Seattle
    // (0.67° east of the zone's central meridian), so they lean a few mm over the map; their x positions step by 40 mm
    const lean = (s: { pts: [number, number][] }) => Math.abs(s.pts[0]![0] - s.pts.at(-1)![0]) / Math.abs(s.pts[0]![1] - s.pts.at(-1)![1]);
    expect(lines.some((s) => lean(s) > 0.004 && lean(s) < 0.02)).toBe(true);
    const xs = lines.filter((s) => lean(s) < 0.02 && Math.abs(s.pts[0]![1] - s.pts.at(-1)![1]) > frame.h * 0.9)
      .map((s) => s.pts[Math.floor(s.pts.length / 2)]![0]).sort((a, b) => a - b);
    expect(xs.length).toBeGreaterThan(4);
    for (let i = 1; i < xs.length; i++) expect(xs[i]! - xs[i - 1]!).toBeCloseTo(40, 0);
    const labels = prims.filter((x): x is TextPrim => x.kind === 'text' && x.part === 'grid');
    expect(labels.length).toBeGreaterThan(10);
    for (const l of labels) {
      expect(l.text).toMatch(/^\d\d$/);
      const outside = l.x < frame.x || l.x > frame.x + frame.w || l.y < frame.y || l.y > frame.y + frame.h;
      expect(outside).toBe(true);
    }
  });

  it('the numbers are the kilometres of the UTM grid (Seattle is about 550 km east, 5,272 km north)', () => {
    const p = military();
    const texts = buildScene(p, cityData()).prims.filter((x): x is TextPrim => x.kind === 'text' && x.part === 'grid').map((x) => +x.text);
    expect(texts.some((n) => n >= 45 && n <= 55)).toBe(true); // eastings 545-555 km
    expect(texts.some((n) => n >= 68 && n <= 76)).toBe(true); // northings 5268-5276 km
  });

  it('no numbers on a coaster, whose round edge has no margin', () => {
    // the coaster is chosen first, as in the app, so its small margins apply
    const p = military((q) => { q.sizeId = 'coaster-circle'; });
    const prims = buildScene(p, cityData()).prims;
    expect(prims.some((x) => x.kind === 'path' && x.part === 'grid')).toBe(true);
    expect(prims.some((x) => x.kind === 'text' && x.part === 'grid')).toBe(false);
  });
});

describe('grid numbers go on the right edges', () => {
  it('upright lines are numbered top and bottom, level ones at the sides, even when a line leans out through a side', async () => {
    const { gridGeometry } = await import('../src/scene/grid');
    const frame = { x: 0, y: 0, w: 100, h: 100 };
    const lines = [
      { axis: 'e' as const, km: 552, pts: [[95, -10], [105, 110]] as [number, number][] }, // leans out through the right edge
      { axis: 'n' as const, km: 5271, pts: [[-10, 50], [110, 51]] as [number, number][] },
    ];
    const { labels } = gridGeometry(lines, frame, undefined, 1, 2.5);
    expect(labels.filter((l) => l.text === '52').map((l) => l.edge)).toEqual(['top']);
    expect(labels.filter((l) => l.text === '71').map((l) => l.edge).sort()).toEqual(['left', 'right']);
  });
});
