import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  CONCURRENCY, decodeCityTile, loadCityTiles, MAX_TILES, MAX_ZOOM, MIN_ZOOM, pickZoom, resetTileCache, TILEJSON_URL, tilesBBox, tilesFor, transportLayer,
} from '../src/city/tiles';
import { stitchRivers, JOIN_TOLERANCE_DEG } from '../src/features/select';
import { waterLines } from '../src/city/draw';
import { LAYER_KEYS, type LayerKey, type Way } from '../src/city/types';
import { useStore } from '../src/store';
import { defaultProject } from '../src/scene/project';
import { viewOf, buildScene } from '../src/scene/buildScene';
import { cityProject } from './fixture';

const file = (z: number, x: number, y: number) => new Uint8Array(readFileSync(`test/fixtures/tiles/${z}-${x}-${y}.pbf`));
const lonAt = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
const latAt = (y: number, z: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;
const bounds = (z: number, x: number, y: number) => ({ minLat: latAt(y + 1, z), maxLat: latAt(y, z), minLon: lonAt(x, z), maxLon: lonAt(x + 1, z) });
const FIXTURES = [[14, 2624, 5721], [14, 2625, 5721], [14, 2624, 5722]] as const;
const tile = (z = 14, x = 2624, y = 5721) => decodeCityTile(file(z, x, y), z, x, y);
const count = (ws: Way[]) => ws.length;

describe('which tiles cover an area', () => {
  const b = bounds(14, 2624, 5721);
  it('one tile for its own area, and the neighbors when the area crosses an edge', () => {
    const inner = { minLat: b.minLat + 0.001, maxLat: b.maxLat - 0.001, minLon: b.minLon + 0.001, maxLon: b.maxLon - 0.001 };
    expect(tilesFor(inner, 14)).toEqual([{ z: 14, x: 2624, y: 5721 }]);
    expect(tilesFor({ ...inner, maxLon: bounds(14, 2625, 5721).maxLon - 0.001 }, 14)).toHaveLength(2);
  });
  it('the covered box contains the area asked for', () => {
    const area = { minLat: b.minLat + 0.002, maxLat: b.maxLat + 0.002, minLon: b.minLon, maxLon: b.maxLon + 0.003 };
    const c = tilesBBox(tilesFor(area, 14));
    expect(c.minLat).toBeLessThanOrEqual(area.minLat);
    expect(c.maxLat).toBeGreaterThanOrEqual(area.maxLat);
    expect(c.minLon).toBeLessThanOrEqual(area.minLon);
    expect(c.maxLon).toBeGreaterThanOrEqual(area.maxLon);
  });
  it('picks the sharpest zoom within the tile budget', () => {
    expect(pickZoom(b)).toBe(MAX_ZOOM);
    const wide = { minLat: 47.4, maxLat: 47.8, minLon: -122.6, maxLon: -122.0 };
    const z = pickZoom(wide);
    expect(z).toBeLessThan(MAX_ZOOM);
    expect(tilesFor(wide, z).length).toBeLessThanOrEqual(MAX_TILES);
    expect(pickZoom({ minLat: -60, maxLat: 60, minLon: -170, maxLon: 170 })).toBe(MIN_ZOOM);
  });
});

describe('which layer a street belongs to', () => {
  const t = (cls: string, extra: Record<string, unknown> = {}) => transportLayer({ class: cls, ...extra });
  it('roads by importance', () => {
    expect(['motorway', 'trunk', 'primary'].map((c) => t(c))).toEqual(['major', 'major', 'major']);
    expect(['secondary', 'tertiary'].map((c) => t(c))).toEqual(['secondary', 'secondary']);
    expect([t('minor'), t('service')]).toEqual(['minor', 'minor']);
  });
  it('driveways and parking aisles are left out, alleys are not', () => {
    expect(t('service', { service: 'driveway' })).toBeUndefined();
    expect(t('service', { service: 'parking_aisle' })).toBeUndefined();
    expect(t('service', { service: 'alley' })).toBe('minor');
  });
  it('footpaths and tracks are paths; platforms and indoor corridors are not drawn', () => {
    expect([t('path', { subclass: 'footway' }), t('path', { subclass: 'steps' }), t('track')]).toEqual(['paths', 'paths', 'paths']);
    expect([t('path', { subclass: 'platform' }), t('path', { subclass: 'corridor' })]).toEqual([undefined, undefined]);
  });
  it('rail, light rail and trams are railways, unless underground; subway, piers and ferries are not', () => {
    expect([t('rail', { subclass: 'rail' }), t('transit', { subclass: 'light_rail' }), t('transit', { subclass: 'tram' })]).toEqual(['rail', 'rail', 'rail']);
    expect([t('rail', { brunnel: 'tunnel' }), t('transit', { subclass: 'light_rail', brunnel: 'tunnel' }), t('transit', { subclass: 'subway' }), t('pier'), t('ferry')]).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });
  it('roads in tunnels and on bridges are still roads', () => {
    expect(t('motorway', { brunnel: 'tunnel' })).toBe('major');
    expect(t('primary', { brunnel: 'bridge' })).toBe('major');
  });
});

describe('decoding a real downtown Seattle tile', () => {
  const d = tile();
  it('fills every layer', () => {
    for (const k of LAYER_KEYS.filter((k) => k !== 'rail')) expect(count(d.ways[k]), k).toBeGreaterThan(0);
    expect(count(d.ways.buildings)).toBeGreaterThan(300);
    expect(count(d.ways.minor)).toBeGreaterThan(20);
  });
  it('buildings are rings; streets are open lines', () => {
    expect(d.ways.buildings.every((w) => w.closed || w.pts.length >= 4)).toBe(true);
    expect(d.ways.major.every((w) => !w.closed)).toBe(true);
    expect(d.ways.minor.every((w) => !w.closed)).toBe(true);
  });
  it('water has the bay (an outline cut to the tile and a fill-only ring) and the lake names', () => {
    expect(d.ways.water.some((w) => w.sub === 'lake' && w.fill)).toBe(true);
    expect(d.ways.water.some((w) => w.sub === 'lake' && !w.closed)).toBe(true);
    expect(d.waterNames.map((n) => n.name)).toContain('Lake Union');
  });
  it('swimming pools are not water', () => {
    // the tile has 4 pools; only the ocean, the lakes and the pond remain
    expect(d.ways.water.filter((w) => w.sub === 'lake' && w.closed && !w.fill).length).toBeLessThan(8);
  });
  it('every point lies inside the tile (a margin of a few meters at most), so neighbors never double a street', () => {
    const b = bounds(14, 2624, 5721);
    const slack = 2e-4;
    for (const k of LAYER_KEYS) for (const w of d.ways[k]) for (let i = 0; i < w.pts.length; i += 2) {
      expect(w.pts[i]!).toBeGreaterThanOrEqual(b.minLat - slack);
      expect(w.pts[i]!).toBeLessThanOrEqual(b.maxLat + slack);
      expect(w.pts[i + 1]!).toBeGreaterThanOrEqual(b.minLon - slack);
      expect(w.pts[i + 1]!).toBeLessThanOrEqual(b.maxLon + slack);
    }
  });
  it('every way has an id that is unique within the tile, and coordinates are rounded to a meter or so', () => {
    const ids = LAYER_KEYS.flatMap((k) => d.ways[k].map((w) => w.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const w of d.ways.major.slice(0, 20)) for (const v of w.pts) expect(Math.abs(v * 1e5 - Math.round(v * 1e5))).toBeLessThan(1e-6);
  });
  it('a building cut by the edge is open lines plus a fill ring, never a closed outline with a false edge', () => {
    const cut = d.ways.buildings.filter((w) => w.fill);
    expect(cut.length).toBeGreaterThan(0);
    expect(cut.every((w) => w.closed)).toBe(true);
    // the outline pieces of those buildings are open
    expect(d.ways.buildings.some((w) => !w.closed)).toBe(true);
  });
  it('a street that crosses into the next tile continues there: ends meet within a few meters', () => {
    const a = tile(14, 2624, 5721);
    const b = tile(14, 2625, 5721);
    const edge = bounds(14, 2624, 5721).maxLon; // the shared border
    const ends = (t: typeof a) => t.ways.major.concat(t.ways.secondary).flatMap((w) => [[w.pts[0]!, w.pts[1]!], [w.pts[w.pts.length - 2]!, w.pts[w.pts.length - 1]!]]).filter(([, lon]) => Math.abs(lon! - edge) < 1e-5);
    const [ea, eb] = [ends(a), ends(b)];
    expect(ea.length).toBeGreaterThan(0);
    const matched = ea.filter(([la]) => eb.some(([lb]) => Math.abs(lb! - la!) < 4e-5));
    expect(matched.length / ea.length).toBeGreaterThan(0.8);
  });
  it('river pieces from two tiles stitch into one river, though their ends differ by a meter or two', () => {
    const piece = (id: string, a: [number, number], b: [number, number]) => ({ id, kind: 'river' as const, name: 'Test', coords: [a, b] });
    const j = JOIN_TOLERANCE_DEG / 3;
    const out = stitchRivers([piece('1', [1, 1], [1, 2]), piece('2', [1 + j, 2 - j], [1, 3])]);
    expect(out).toHaveLength(1);
    expect(stitchRivers([piece('1', [1, 1], [1, 2]), piece('2', [1, 2 + JOIN_TOLERANCE_DEG * 4], [1, 3])])).toHaveLength(2);
  });
  it('named rivers and lakes become labels', () => {
    const lines = waterLines({ covers: bounds(14, 2624, 5721), ways: [{ id: 'a', closed: false, sub: 'river', name: 'Duwamish', pts: [47.5, -122.3, 47.51, -122.31] }] });
    expect(lines).toMatchObject([{ kind: 'river', name: 'Duwamish' }]);
  });
});

describe('loading tiles for an area', () => {
  const served = new Map(FIXTURES.map(([z, x, y]) => [`https://tiles.test/20261101/${z}/${x}/${y}.pbf`, file(z, x, y)]));
  const mockFetch = (extra: { missing?: number; fail?: boolean } = {}) => {
    let inFlight = 0;
    let peak = 0;
    const calls: string[] = [];
    const f = vi.fn(async (url: string) => {
      calls.push(url);
      if (url === TILEJSON_URL) return { ok: true, status: 200, json: async () => ({ tiles: ['https://tiles.test/20261101/{z}/{x}/{y}.pbf'] }), arrayBuffer: async () => new ArrayBuffer(0) };
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      if (extra.fail) return { ok: false, status: 503, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
      const bytes = served.get(url);
      if (!bytes) return { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
      return { ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer };
    });
    return { f, calls, peak: () => peak };
  };
  const area = (() => { const a = bounds(14, 2624, 5721); const b = bounds(14, 2625, 5722); return { minLat: b.minLat + 0.001, maxLat: a.maxLat - 0.001, minLon: a.minLon + 0.001, maxLon: b.maxLon - 0.001 }; })();
  beforeEach(() => resetTileCache());

  it('fetches the tilejson once, then each tile, and merges them', async () => {
    const m = mockFetch();
    const r = await loadCityTiles(area, { fetch: m.f });
    expect(m.calls.filter((c) => c === TILEJSON_URL)).toHaveLength(1);
    expect(r.tiles).toBe(4); // 2 x 2: one is not served (404) and is just empty
    expect(r.zoom).toBe(14);
    expect(r.complete).toBe(true);
    expect(r.layers.buildings.length).toBeGreaterThan(tile().ways.buildings.length);
    expect(r.covers.minLat).toBeLessThanOrEqual(area.minLat);
    expect(r.covers.maxLon).toBeGreaterThanOrEqual(area.maxLon);
  });
  it('asks for at most four tiles at a time', async () => {
    const m = mockFetch();
    await loadCityTiles({ minLat: 47.55, maxLat: 47.7, minLon: -122.45, maxLon: -122.2 }, { fetch: m.f });
    expect(m.peak()).toBeLessThanOrEqual(CONCURRENCY);
    expect(m.peak()).toBeGreaterThan(1);
  });
  it('does not fetch a tile twice', async () => {
    const m = mockFetch();
    await loadCityTiles(area, { fetch: m.f });
    const first = m.calls.length;
    await loadCityTiles(area, { fetch: m.f });
    expect(m.calls.length).toBe(first);
  });
  it('a failing tile service is an error, so the caller can fall back', async () => {
    await expect(loadCityTiles(area, { fetch: mockFetch({ fail: true }).f })).rejects.toThrow(/failed \(503\)/);
  });
  it('keeps one name per lake across tiles', async () => {
    const r = await loadCityTiles(area, { fetch: mockFetch().f });
    const names = r.waterNames.map((n) => n.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('lake union');
  });
});

describe('the store prefers the tiles and falls back to Overpass', () => {
  const tileFile = (z: string, x: string, y: string) => { try { return file(+z, +x, +y); } catch { return undefined; } };
  const response = (body: unknown, ok = true, status = 200) => ({ ok, status, json: async () => body, arrayBuffer: async () => new ArrayBuffer(0) });
  const view = (() => { const b = bounds(14, 2624, 5721); return { minLat: b.minLat + 0.002, maxLat: b.maxLat - 0.002, minLon: b.minLon + 0.002, maxLon: b.maxLon - 0.002 }; })();
  const settle = async (pred: () => boolean) => { for (let i = 0; i < 200 && !pred(); i++) await new Promise((r) => setTimeout(r, 10)); };
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => { resetTileCache(); useStore.setState({ project: defaultProject(), layers: {}, landmarks: { status: 'idle' } }); useStore.getState().set((p) => { p.features.enabled = false; }); });

  it('one tile fetch fills every layer, and says it came from the tiles', async () => {
    const api = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      if (u.startsWith('/api/')) { api(u); return response({ error: 'no' }, false, 500); }
      if (u === TILEJSON_URL) return response({ tiles: ['https://t.test/{z}/{x}/{y}.pbf'] });
      const m = u.match(/t\.test\/(\d+)\/(\d+)\/(\d+)/);
      const bytes = m && tileFile(m[1]!, m[2]!, m[3]!);
      return bytes ? { ...response({}), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) } : response({}, false, 404);
    }));
    useStore.getState().ensureData(view, 1.5);
    await settle(() => useStore.getState().layers.buildings?.status === 'idle');
    const l = useStore.getState().layers;
    expect(api).not.toHaveBeenCalled();
    expect(l.buildings?.data?.source).toBe('tiles');
    for (const k of LAYER_KEYS) expect(l[k]?.data?.ways.length, k).toBeGreaterThanOrEqual(0);
    expect(l.minor?.data?.ways.length).toBeGreaterThan(0); // not switched on by default? it is, but even disabled ones arrive
    expect(l.water?.data?.waterNames?.map((n) => n.name)).toContain('Lake Union');
  });
  it('layers switched off still arrive, so turning one on needs no new fetch', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      if (u === TILEJSON_URL) return response({ tiles: ['https://t.test/{z}/{x}/{y}.pbf'] });
      const m = u.match(/t\.test\/(\d+)\/(\d+)\/(\d+)/);
      const bytes = m && tileFile(m[1]!, m[2]!, m[3]!);
      return bytes ? { ...response({}), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) } : response({}, false, 404);
    }));
    expect(defaultProject().layers.paths.enabled).toBe(false);
    useStore.getState().ensureData(view, 1.5);
    await settle(() => useStore.getState().layers.buildings?.status === 'idle');
    expect(useStore.getState().layers.paths?.data?.ways.length).toBeGreaterThan(0);
  });
  it('falls back to one Overpass query per layer when the tiles cannot be reached', async () => {
    const api: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      if (u.startsWith('/api/layer')) { api.push(new URL(u, 'http://x').searchParams.get('layer')!); return response({ covers: { minLat: 0, maxLat: 90, minLon: -180, maxLon: 0 }, ways: [{ id: 'w1', closed: false, pts: [1, 1, 2, 2] }] }); }
      throw new TypeError('network down'); // the tile service
    }));
    useStore.getState().ensureData(view, 1.5);
    await settle(() => api.length >= 6 && useStore.getState().layers.major?.status === 'idle');
    expect(api.length).toBeGreaterThanOrEqual(6); // the layers switched on
    expect(useStore.getState().layers.major?.data?.source).toBe('overpass');
    expect(useStore.getState().layers.paths).toBeUndefined(); // switched off: not fetched on the fallback
  });
  it('a map drawn from the tiles has all the layers on the page', () => {
    const d = tile();
    const layers = Object.fromEntries(LAYER_KEYS.map((k) => [k, { covers: bounds(14, 2624, 5721), ways: d.ways[k as LayerKey] }]));
    const p = cityProject((q) => { q.region = { lat: 47.6097, lon: -122.3331, widthKm: 1.2 }; q.features.enabled = false; });
    const prims = buildScene(p, { layers, landmarks: [] }).prims.filter((x) => x.kind === 'path');
    expect(prims.length).toBeGreaterThan(5);
    expect(viewOf(p)).toBeDefined();
  });
});
