import { afterEach, describe, expect, it, vi } from 'vitest';
import { cacheKey, handleApi, normalizeWays, snapBBox, stitch, toLandmark } from '../worker/api';
import { LAYER_MAX_KM, SNAP_DEG } from '../src/city/types';
import { fetchLandmarks, fetchLayer } from '../src/lookup';

const box = (minLat: number, maxLat: number, minLon: number, maxLon: number) => ({ minLat, maxLat, minLon, maxLon });
const qs = (b: ReturnType<typeof box>) => `minLat=${b.minLat}&maxLat=${b.maxLat}&minLon=${b.minLon}&maxLon=${b.maxLon}`;
const key = (q: string, path = '/api/layer') => cacheKey(new Request(`http://x${path}?${q}`)).url;

describe('snapBBox', () => {
  it('rounds outward to the grid, so the box always contains the request', () => {
    const b = box(47.6012, 47.6307, -122.3456, -122.3011);
    const s = snapBBox(b);
    expect(s.minLat).toBeLessThanOrEqual(b.minLat);
    expect(s.maxLat).toBeGreaterThanOrEqual(b.maxLat);
    expect(s.minLon).toBeLessThanOrEqual(b.minLon);
    expect(s.maxLon).toBeGreaterThanOrEqual(b.maxLon);
    for (const v of [s.minLat, s.maxLat, s.minLon, s.maxLon]) expect(Math.abs(v / SNAP_DEG - Math.round(v / SNAP_DEG))).toBeLessThan(1e-6);
  });
  it('grows by less than one grid square in each direction', () => {
    const b = box(47.6012, 47.6307, -122.3456, -122.3011);
    const s = snapBBox(b);
    expect(b.minLat - s.minLat).toBeLessThan(SNAP_DEG);
    expect(s.maxLon - b.maxLon).toBeLessThan(SNAP_DEG);
  });
  it('leaves a box already on the grid alone, however the float lands', () => {
    expect(snapBBox(box(47.6, 47.63, -122.35, -122.3))).toEqual(box(47.6, 47.63, -122.35, -122.3));
  });
  it('is stable on negative longitudes, near the poles and the date line', () => {
    expect(snapBBox(box(-89.999, 89.999, -179.999, 179.999))).toEqual(box(-90, 90, -180, 180));
    expect(snapBBox(box(-33.8691, -33.8512, 151.2001, 151.2203))).toEqual(box(-33.87, -33.85, 151.2, 151.225));
  });
});

describe('cacheKey', () => {
  const a = qs(box(47.6012, 47.6307, -122.3456, -122.3011));
  const b = qs(box(47.6031, 47.6341, -122.3492, -122.3022)); // a slightly different view of the same place
  it('is the same for different views of one place, so they share a cached answer', () => {
    expect(key(`layer=major&${a}`)).toBe(key(`layer=major&${b}`));
  });
  it('differs by place, layer and landmark filter', () => {
    const base = key(`layer=major&${a}`);
    expect(key(`layer=minor&${a}`)).not.toBe(base);
    expect(key(`layer=major&${qs(box(48.6, 48.63, -122.35, -122.3))}`)).not.toBe(base);
    expect(key(a, '/api/landmarks')).not.toBe(key(`${a}&notable=1`, '/api/landmarks'));
  });
  it('treats spelling variants of one search as the same', () => {
    expect(key('q=New%20York', '/api/geocode')).toBe(key('q=new+york', '/api/geocode'));
    expect(key('q=%20New%20%20York%20', '/api/geocode')).toBe(key('q=new york', '/api/geocode'));
    expect(key('q=Boston', '/api/geocode')).not.toBe(key('q=New%20York', '/api/geocode'));
  });
  it('leaves other routes untouched', () => {
    expect(key('lat=1&lon=2', '/api/reverse')).toBe('http://x/api/reverse?lat=1&lon=2');
  });
});

describe('normalizing Overpass answers', () => {
  const geom = (...p: [number, number][]) => p.map(([lat, lon]) => ({ lat, lon }));
  it('a way becomes flat [lat, lon, …] rounded to about a meter', () => {
    const [w] = normalizeWays([{ type: 'way', id: 7, tags: { highway: 'primary' }, geometry: geom([47.123456789, -122.987654321], [47.2, -122.9]) }], 'major');
    expect(w).toEqual({ id: 'w7', closed: false, pts: [47.12346, -122.98765, 47.2, -122.9] });
  });
  it('a way whose end meets its start is a closed ring', () => {
    const [w] = normalizeWays([{ type: 'way', id: 8, tags: { building: 'yes' }, geometry: geom([1, 1], [1, 2], [2, 2], [1, 1]) }], 'buildings');
    expect(w!.closed).toBe(true);
  });
  it('buildings carry no name; water and parks keep theirs, and water says what it is', () => {
    const el = (tags: Record<string, string>) => ({ type: 'way', id: 1, tags: { name: 'X', ...tags }, geometry: geom([1, 1], [1, 2], [2, 2], [1, 1]) });
    expect(normalizeWays([el({ building: 'yes' })], 'buildings')[0]!.name).toBeUndefined();
    expect(normalizeWays([el({ leisure: 'park' })], 'parks')[0]!.name).toBe('X');
    expect(normalizeWays([el({ natural: 'water' })], 'water')[0]).toMatchObject({ name: 'X', sub: 'lake' });
    expect(normalizeWays([el({ waterway: 'riverbank' })], 'water')[0]!.sub).toBe('lake');
    expect(normalizeWays([el({ waterway: 'river' })], 'water')[0]!.sub).toBe('river');
    expect(normalizeWays([el({ natural: 'coastline' })], 'water')[0]!.sub).toBe('coastline');
  });
  it('a way cut by the box (nodes outside arrive as null) becomes separate lines', () => {
    const out = normalizeWays([{ type: 'way', id: 3, tags: { highway: 'primary' }, geometry: [...geom([1, 1], [1, 2]), null, ...geom([2, 1], [2, 2])] }], 'major');
    expect(out.map((w) => w.pts.length)).toEqual([4, 4]);
    expect(new Set(out.map((w) => w.id)).size).toBe(2);
  });
  it('a lake relation is stitched from its outer pieces into one ring', () => {
    const rel = {
      type: 'relation', id: 9, tags: { name: 'Lake', natural: 'water' },
      members: [
        { type: 'way', role: 'outer', geometry: geom([0, 0], [0, 2], [2, 2]) },
        { type: 'way', role: 'outer', geometry: geom([0, 0], [2, 0], [2, 2]) }, // runs the other way round
      ],
    };
    const out = normalizeWays([rel], 'water');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'r9-0', name: 'Lake', closed: true, sub: 'lake' });
  });
  it('stitch joins pieces in either direction and leaves unrelated ones apart', () => {
    const joined = stitch([[[0, 0], [0, 1]], [[0, 2], [0, 1]], [[5, 5], [5, 6]]]);
    expect(joined).toHaveLength(2);
    expect(joined.some((l) => l.length === 3)).toBe(true);
  });
  it('landmarks: kind from tags, position from a node or a way center, notable when linked to Wikidata', () => {
    expect(toLandmark({ type: 'node', id: 1, lat: 1, lon: 2, tags: { name: 'Eiffel Tower', tourism: 'attraction', wikidata: 'Q243' } }))
      .toEqual({ id: 'n1', name: 'Eiffel Tower', kind: 'attraction', lat: 1, lon: 2, notable: true });
    expect(toLandmark({ type: 'way', id: 2, center: { lat: 3, lon: 4 }, tags: { name: 'Louvre', tourism: 'museum' } }))
      .toEqual({ id: 'w2', name: 'Louvre', kind: 'museum', lat: 3, lon: 4 });
    expect(toLandmark({ type: 'node', id: 3, lat: 1, lon: 1, tags: { name: 'Gare', railway: 'station' } })!.kind).toBe('station');
    expect(toLandmark({ type: 'node', id: 4, lat: 1, lon: 1, tags: { name: 'St X', amenity: 'place_of_worship' } })!.kind).toBe('worship');
    expect(toLandmark({ type: 'node', id: 5, lat: 1, lon: 1, tags: { tourism: 'attraction' } })).toBeUndefined(); // no name
    expect(toLandmark({ type: 'node', id: 6, lat: 1, lon: 1, tags: { name: 'Shop', shop: 'bakery' } })).toBeUndefined(); // not a landmark
    expect(toLandmark({ type: 'way', id: 7, tags: { name: 'No center', tourism: 'museum' } })).toBeUndefined();
  });
});

describe('the Worker answers layers and landmarks', () => {
  const store = new Map<string, Response>();
  const stubCache = () => {
    store.clear();
    vi.stubGlobal('caches', {
      default: {
        match: async (r: Request) => store.get(r.url)?.clone(),
        put: async (r: Request, res: Response) => { store.set(r.url, res); },
      },
    });
  };
  const road = { type: 'way', id: 1, tags: { highway: 'primary' }, geometry: [{ lat: 47.61, lon: -122.34 }, { lat: 47.62, lon: -122.33 }] };
  const stubOverpass = (elements: unknown[] = [road]) => {
    const f = vi.fn(async () => new Response(JSON.stringify({ elements })));
    vi.stubGlobal('fetch', f);
    return f;
  };
  const get = (path: string) => handleApi(new Request(`http://x/api/${path}`)) as Promise<Response>;
  afterEach(() => vi.unstubAllGlobals());

  const viewA = qs(box(47.6012, 47.6307, -122.3456, -122.3011));
  const viewB = qs(box(47.6031, 47.6341, -122.3492, -122.3022));

  it('a second, slightly different view is answered from the cache with no Overpass call', async () => {
    stubCache();
    const f = stubOverpass();
    const first: any = await (await get(`layer?layer=major&${viewA}`)).json();
    const calls = f.mock.calls.length;
    expect(calls).toBe(1);
    expect(first.ways).toHaveLength(1);
    const second: any = await (await get(`layer?layer=major&${viewB}`)).json();
    expect(f.mock.calls.length).toBe(calls);
    expect(second).toEqual(first);
  });
  it('a different layer goes to Overpass again', async () => {
    stubCache();
    const f = stubOverpass();
    await get(`layer?layer=major&${viewA}`);
    await get(`layer?layer=minor&${viewA}`);
    expect(f.mock.calls.length).toBe(2);
  });
  it('the response says what area it covers, which contains the request', async () => {
    stubCache();
    stubOverpass();
    const d: any = await (await get(`layer?layer=major&${viewA}`)).json();
    expect(d.covers).toEqual(snapBBox(box(47.6012, 47.6307, -122.3456, -122.3011)));
  });
  it('the query sent to Overpass uses the snapped area and the layer\'s own filter', async () => {
    stubCache();
    const f = stubOverpass();
    await get(`layer?layer=buildings&${viewA}`);
    const body = decodeURIComponent((f.mock.calls[0] as any)[1].body);
    const s = snapBBox(box(47.6012, 47.6307, -122.3456, -122.3011));
    expect(body).toContain(`way["building"](${s.minLat},${s.minLon},${s.maxLat},${s.maxLon})`);
    expect(body).not.toContain('47.6012');
  });
  it('rejects an unknown layer and a missing box', async () => {
    stubCache();
    stubOverpass();
    expect((await get(`layer?layer=nope&${viewA}`)).status).toBe(400);
    expect((await get('layer?layer=major')).status).toBe(400);
  });
  it('rejects an area far wider than the layer allows, and accepts the padded views the client asks for', async () => {
    stubCache();
    stubOverpass();
    const wide = (km: number) => qs(box(47.6, 47.6 + km / 110.57, -122.4, -122.4 + km / (111.32 * Math.cos((47.6 * Math.PI) / 180))));
    expect((await get(`layer?layer=buildings&${wide(LAYER_MAX_KM.buildings * 3)}`)).status).toBe(400);
    expect((await get(`layer?layer=buildings&${wide(LAYER_MAX_KM.buildings * 1.3)}`)).status).toBe(200);
  });
  it('an answer that hit the size limit is flagged and is not cached for long', async () => {
    stubCache();
    stubOverpass(Array.from({ length: 5000 }, (_, i) => ({ ...road, id: i })));
    const r = await get(`layer?layer=major&${viewA}`);
    expect(((await r.json()) as any).truncated).toBe(true);
    expect(r.headers.get('cache-control')).toContain('max-age=60');
  });
  it('landmarks come back with their kind and position', async () => {
    stubCache();
    stubOverpass([{ type: 'node', id: 5, lat: 47.62, lon: -122.349, tags: { name: 'Space Needle', tourism: 'attraction', wikidata: 'Q1' } }]);
    const d: any = await (await get(`landmarks?${viewA}`)).json();
    expect(d.landmarks).toEqual([{ id: 'n5', name: 'Space Needle', kind: 'attraction', lat: 47.62, lon: -122.349, notable: true }]);
  });
  it('wide views ask for notable landmarks only', async () => {
    stubCache();
    const f = stubOverpass([]);
    await get(`landmarks?${viewA}&notable=1`);
    expect(decodeURIComponent((f.mock.calls[0] as any)[1].body)).toContain('["wikidata"]');
    await get(`landmarks?${qs(box(47.5, 47.51, -122.3, -122.29))}`);
    expect(decodeURIComponent((f.mock.calls[1] as any)[1].body)).not.toContain('["wikidata"]');
  });
});

describe('the client asks for what the server expects', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('layer requests carry the layer and the box', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ covers: box(1, 2, 3, 4), ways: [] })));
    vi.stubGlobal('fetch', f);
    await fetchLayer('water', box(47.6, 47.63, -122.35, -122.3));
    const url = new URL((f.mock.calls[0] as any)[0], 'http://x');
    expect(url.pathname).toBe('/api/layer');
    expect(Object.fromEntries(url.searchParams)).toEqual({ layer: 'water', minLat: '47.6', maxLat: '47.63', minLon: '-122.35', maxLon: '-122.3' });
  });
  it('landmark requests say whether only notable ones are wanted, and remember it', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ covers: box(1, 2, 3, 4), landmarks: [] })));
    vi.stubGlobal('fetch', f);
    const d = await fetchLandmarks(box(47.6, 47.63, -122.35, -122.3), true);
    expect(new URL((f.mock.calls[0] as any)[0], 'http://x').searchParams.get('notable')).toBe('1');
    expect(d.notableOnly).toBe(true);
  });
  it('an error from the server becomes the error message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'area too large for buildings' }), { status: 400 })));
    await expect(fetchLayer('buildings', box(1, 2, 3, 4))).rejects.toThrow('area too large for buildings');
  });
});

describe('saving exports to the bucket', () => {
  const SESSION = 'a1b2c3d4-0000-4000-8000-123456789abc';
  const bucket = () => {
    const put = vi.fn(async () => undefined);
    return { put, env: { FILES: { put } } };
  };
  const post = (qs: string, body: BodyInit | null, env: any) => handleApi(new Request(`http://x/api/export?${qs}`, { method: 'POST', body }), env) as Promise<Response>;

  it('writes the file under city-plot/<session>/ with its content type', async () => {
    const { put, env } = bucket();
    const res = await post(`name=city-plot-seattle.svg&session=${SESSION}`, '<svg/>', env);
    const { key } = (await res.json()) as { key: string };
    expect(res.status).toBe(200);
    expect(key).toMatch(new RegExp(`^city-plot/${SESSION}/\\d{4}-.*-city-plot-seattle\\.svg$`));
    expect(put).toHaveBeenCalledWith(key, expect.anything(), { httpMetadata: { contentType: 'image/svg+xml' } });
  });
  it('accepts PNG and the project JSON, and refuses other types and unsafe names', async () => {
    const { put, env } = bucket();
    expect((await post(`name=a.png&session=${SESSION}`, 'x', env)).status).toBe(200);
    expect((await post(`name=a.json&session=${SESSION}`, '{}', env)).status).toBe(200);
    for (const name of ['a.html', '../a.svg', 'a/b.svg', '.svg', '']) expect((await post(`name=${encodeURIComponent(name)}&session=${SESSION}`, 'x', env)).status, name).toBe(400);
    expect(put).toHaveBeenCalledTimes(2);
  });
  it('refuses a missing or unsafe session id, so nobody can write outside their folder', async () => {
    const { put, env } = bucket();
    for (const session of ['', 'short', '../../etc/passwd-0000', 'has space in it', 'UPPER-CASE-IS-FINE-TOO/../x']) {
      expect((await post(`name=a.svg&session=${encodeURIComponent(session)}`, 'x', env)).status, session).toBe(400);
    }
    expect((await post('name=a.svg', 'x', env)).status).toBe(400);
    expect(put).not.toHaveBeenCalled();
  });
  it('refuses an empty body, and says so plainly when no bucket is connected (local dev)', async () => {
    const { env } = bucket();
    expect((await post(`name=a.svg&session=${SESSION}`, null, env)).status).toBe(413);
    expect((await post(`name=a.svg&session=${SESSION}`, 'x', {})).status).toBe(501);
  });
  it('reports a failed write instead of throwing', async () => {
    const res = await post(`name=a.svg&session=${SESSION}`, 'x', { FILES: { put: async () => { throw new Error('r2 down'); } } });
    expect(res.status).toBe(500);
  });
});
