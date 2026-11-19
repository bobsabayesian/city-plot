import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { decodeCityTile } from '../src/city/tiles';
import { heightDensity, type LayerData, type Way } from '../src/city/types';
import { buildScene } from '../src/scene/buildScene';
import type { PathPrim } from '../src/scene/types';
import { cityData, cityProject, SEATTLE } from './fixture';

const block = (id: string, dLat: number, h?: number): Way => {
  const [la, lo] = [SEATTLE.lat + dLat, SEATTLE.lon];
  return { id, closed: true, pts: [la, lo, la, lo + 0.0005, la + 0.0003, lo + 0.0005, la + 0.0003, lo, la, lo], ...(h !== undefined ? { h } : {}) };
};

describe('hatching buildings by height', () => {
  it('bands: outline under 15 m, then light, medium, and solid from 120 m; unknown heights are light', () => {
    expect(heightDensity(8)).toBeUndefined();
    expect(heightDensity(20)).toBe('light');
    expect(heightDensity(60)).toBe('medium');
    expect(heightDensity(200)).toBe('solid');
    expect(heightDensity(undefined)).toBe('light');
  });

  it('the map tiles give each building its height', () => {
    const t = decodeCityTile(new Uint8Array(readFileSync('test/fixtures/tiles/14-2624-5721.pbf')), 14, 2624, 5721);
    const hs = t.ways.buildings.map((w) => w.h).filter((h): h is number => h !== undefined);
    expect(hs.length).toBeGreaterThan(t.ways.buildings.length * 0.9);
    expect(Math.max(...hs)).toBeGreaterThan(150); // downtown Seattle's towers
  });

  it('draws one fill per band, lightest first, and leaves low buildings as outlines', () => {
    const data = cityData();
    data.layers.buildings = { covers: data.layers.major!.covers, ways: [block('low', 0, 6), block('mid', 0.001, 30), block('tall', 0.002, 80), block('tower', 0.003, 200)] } as LayerData;
    const p = cityProject((q) => { q.layers.buildings.fill = 'height'; });
    const fills = buildScene(p, data).prims.filter((x): x is PathPrim => x.kind === 'path' && x.part === 'buildings' && x.mode === 'fill');
    expect(fills.map((f) => f.hatch)).toEqual(['light', 'medium', 'solid']);
    for (const f of fills) expect(f.d.split('M').length - 1).toBe(1); // one building each
    const outline = buildScene(p, data).prims.find((x): x is PathPrim => x.kind === 'path' && x.part === 'buildings' && x.mode === 'stroke')!;
    expect(outline.d.split('M').length - 1).toBe(4); // all four outlined, the low one too
  });

  it('a single density still hatches every building alike', () => {
    const data = cityData();
    data.layers.buildings = { covers: data.layers.major!.covers, ways: [block('low', 0, 6), block('tower', 0.003, 200)] } as LayerData;
    const fills = buildScene(cityProject((q) => { q.layers.buildings.fill = 'medium'; }), data).prims.filter((x): x is PathPrim => x.kind === 'path' && x.part === 'buildings' && x.mode === 'fill');
    expect(fills).toHaveLength(1);
    expect(fills[0]!.hatch).toBe('medium');
  });
});
