import { afterEach, describe, expect, it, vi } from 'vitest';
import { cacheKey, handleApi, MAX_REQUEST_SPAN, SNAP_GRIDS, snapBBox } from '../worker/api';
import { fetchFeatures } from '../src/lookup';

const box = (minLat: number, maxLat: number, minLon: number, maxLon: number) => ({ minLat, maxLat, minLon, maxLon });
const onGrid = (v: number, g: number) => Math.abs(v / g - Math.round(v / g)) < 1e-6;

describe('snapBBox', () => {
  it('always contains the original area', () => {
    for (const b of [box(46.8, 46.85, -121.8, -121.74), box(46.71, 46.88, -121.9, -121.7), box(10.01, 10.3, 20.01, 20.4), box(-33.9, -33.8, 151.1, 151.25)]) {
      const s = snapBBox(b);
      expect(s.minLat).toBeLessThanOrEqual(b.minLat);
      expect(s.maxLat).toBeGreaterThanOrEqual(b.maxLat);
      expect(s.minLon).toBeLessThanOrEqual(b.minLon);
      expect(s.maxLon).toBeGreaterThanOrEqual(b.maxLon);
    }
  });
  it('lands on grid lines, using the smallest grid at least as big as the request', () => {
    const small = snapBBox(box(46.81, 46.84, -121.79, -121.76)); // 0.03 -> 0.05 grid
    for (const v of [small.minLat, small.maxLat, small.minLon, small.maxLon]) expect(onGrid(v, 0.05)).toBe(true);
    const mid = snapBBox(box(46.7, 46.85, -121.9, -121.76)); // 0.15 -> 0.175 grid
    for (const v of [mid.minLat, mid.maxLat, mid.minLon, mid.maxLon]) expect(onGrid(v, 0.175)).toBe(true);
    const wide = snapBBox(box(46.2, 46.6, -121.9, -121.5)); // 0.4 -> 0.5 grid
    for (const v of [wide.minLat, wide.maxLat, wide.minLon, wide.maxLon]) expect(onGrid(v, 0.5)).toBe(true);
  });
  it('never grows past two grid squares in a direction', () => {
    for (let i = 0; i < 200; i++) {
      const span = 0.01 + Math.random() * (MAX_REQUEST_SPAN - 0.01);
      const lat = 40 + Math.random() * 10;
      const lon = -120 + Math.random() * 10;
      const s = snapBBox(box(lat, lat + span, lon, lon + span));
      const g = SNAP_GRIDS.find((x) => x >= span)!;
      expect(s.maxLat - s.minLat).toBeLessThanOrEqual(2 * g + 1e-6);
      expect(s.maxLon - s.minLon).toBeLessThanOrEqual(2 * g + 1e-6);
    }
  });
  it('different views of the same place give the same block', () => {
    const a = snapBBox(box(46.801, 46.842, -121.791, -121.762));
    const b = snapBBox(box(46.805, 46.838, -121.788, -121.766)); // a little zoomed in and shifted
    expect(a).toEqual(b);
  });
  it('an area already on the grid does not grow an extra square', () => {
    expect(snapBBox(box(46.1, 46.2, -121.3, -121.2))).toEqual(box(46.1, 46.2, -121.3, -121.2));
    expect(snapBBox(box(46.05, 46.1, -121.35, -121.3))).toEqual(box(46.05, 46.1, -121.35, -121.3));
  });
  it('crossing a grid line takes two squares', () => {
    const s = snapBBox(box(46.09, 46.11, -121.29, -121.27)); // spans the 46.10 line, 0.05 grid
    expect(s.maxLat - s.minLat).toBeCloseTo(0.1, 6);
  });
  it('is stable on negative longitudes and near the poles', () => {
    expect(snapBBox(box(-0.01, 0.01, -0.01, 0.01))).toEqual(box(-0.05, 0.05, -0.05, 0.05));
    expect(snapBBox(box(89.99, 90, 0, 0.01)).maxLat).toBeLessThanOrEqual(90);
  });
});

describe('cacheKey', () => {
  const key = (qs: string, path = '/api/features') => cacheKey(new Request(`http://x${path}?${qs}`)).url;
  const area = 'minLat=46.801&maxLat=46.842&minLon=-121.791&maxLon=-121.762';
  const area2 = 'minLat=46.805&maxLat=46.838&minLon=-121.788&maxLon=-121.766';

  it('is the same for different views of one place, so they share a cached answer', () => {
    expect(key(`${area}&kinds=peak,hut&lakes=1&rivers=1`)).toBe(key(`${area2}&kinds=peak,hut&lakes=1&rivers=1`));
  });
  it('ignores the order of kinds', () => {
    expect(key(`${area}&kinds=peak,hut`)).toBe(key(`${area}&kinds=hut,peak`));
  });
  it('differs by place, kinds and water settings', () => {
    const base = key(`${area}&kinds=peak&lakes=1&rivers=1`);
    expect(key('minLat=47.5&maxLat=47.54&minLon=-121.791&maxLon=-121.762&kinds=peak&lakes=1&rivers=1')).not.toBe(base);
    expect(key(`${area}&kinds=peak,hut&lakes=1&rivers=1`)).not.toBe(base);
    expect(key(`${area}&kinds=peak&lakes=0&rivers=1`)).not.toBe(base);
    expect(key(`${area}&kinds=peak&lakes=1&rivers=0`)).not.toBe(base);
  });
  it('treats missing params as "everything" (older clients)', () => {
    expect(key(area)).toContain('kinds=*');
    expect(key(area)).toBe(key(`${area}&lakes=1&rivers=1`)); // explicit defaults match the missing ones
  });
  it('treats spelling variants of one search as the same', () => {
    expect(key('q=Mount%20Rainier', '/api/geocode')).toBe(key('q=mount+rainier', '/api/geocode'));
    expect(key('q=%20Mount%20%20Rainier%20', '/api/geocode')).toBe(key('q=mount rainier', '/api/geocode'));
    expect(key('q=Mount%20Hood', '/api/geocode')).not.toBe(key('q=Mount%20Rainier', '/api/geocode'));
  });
  it('leaves other routes untouched', () => {
    expect(key('lat=1&lon=2', '/api/reverse')).toBe('http://x/api/reverse?lat=1&lon=2');
  });
});

describe('the Worker cache is shared across views', () => {
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
  const peak = { type: 'node', id: 1, lat: 46.82, lon: -121.77, tags: { name: 'A', natural: 'peak' } };
  const stubOverpass = () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ elements: [peak] })));
    vi.stubGlobal('fetch', f);
    return f;
  };
  const get = (qs: string) => handleApi(new Request(`http://x/api/features?${qs}`)) as Promise<Response>;
  afterEach(() => vi.unstubAllGlobals());

  const viewA = 'minLat=46.801&maxLat=46.842&minLon=-121.791&maxLon=-121.762&kinds=peak&lakes=0&rivers=0';
  const viewB = 'minLat=46.805&maxLat=46.838&minLon=-121.788&maxLon=-121.766&kinds=peak&lakes=0&rivers=0';

  it('a second, slightly different view is answered from the cache with no Overpass call', async () => {
    stubCache();
    const f = stubOverpass();
    const first: any = await (await get(viewA)).json();
    const calls = f.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    const second: any = await (await get(viewB)).json();
    expect(f.mock.calls.length).toBe(calls); // nothing new fetched
    expect(second).toEqual(first);
  });
  it('a different place goes to Overpass again', async () => {
    stubCache();
    const f = stubOverpass();
    await get(viewA);
    const calls = f.mock.calls.length;
    await get('minLat=47.5&maxLat=47.54&minLon=-121.791&maxLon=-121.762&kinds=peak&lakes=0&rivers=0');
    expect(f.mock.calls.length).toBeGreaterThan(calls);
  });
  it('different settings for the same place are cached separately', async () => {
    stubCache();
    const f = stubOverpass();
    await get(viewA);
    const calls = f.mock.calls.length;
    await get(viewA.replace('lakes=0&rivers=0', 'lakes=1&rivers=1'));
    expect(f.mock.calls.length).toBeGreaterThan(calls);
  });
  it('the response says what area it really covers, which contains the request', async () => {
    stubCache();
    stubOverpass();
    const d: any = await (await get(viewA)).json();
    expect(d.covers).toEqual(snapBBox(box(46.801, 46.842, -121.791, -121.762)));
    expect(d.covers.minLat).toBeLessThanOrEqual(46.801);
    expect(d.covers.maxLat).toBeGreaterThanOrEqual(46.842);
  });
  it('the query sent to Overpass uses the snapped area, not the raw one', async () => {
    stubCache();
    const f = stubOverpass();
    await get(viewA);
    const body = decodeURIComponent((f.mock.calls[0] as any)[1].body);
    const s = snapBBox(box(46.801, 46.842, -121.791, -121.762));
    expect(body).toContain(`(${s.minLat},${s.minLon},${s.maxLat},${s.maxLon})`);
    expect(body).not.toContain('46.801');
  });
  it('rejects a request wider than the limit', async () => {
    stubCache();
    stubOverpass();
    const r = await get('minLat=46&maxLat=46.6&minLon=-121.8&maxLon=-121.2&kinds=peak');
    expect(r.status).toBe(400);
  });
  it('water is still fetched at the largest size that fits its limit, and skipped just above it', async () => {
    stubCache();
    let f = stubOverpass();
    const ok: any = await (await get('minLat=46.01&maxLat=46.16&minLon=-121.4&maxLon=-121.25&kinds=peak&lakes=1&rivers=1')).json(); // 0.15 -> 0.175 grid
    expect(ok.partial).toEqual([]);
    expect(f.mock.calls.length).toBe(2); // points + water
    vi.unstubAllGlobals();
    stubCache();
    f = stubOverpass();
    const big: any = await (await get('minLat=46.01&maxLat=46.21&minLon=-121.4&maxLon=-121.2&kinds=peak&lakes=1&rivers=1')).json(); // 0.2 -> 0.5 grid
    expect(big.partial).toEqual(['water']);
    expect(f.mock.calls.length).toBe(1);
  });
});

describe('the editor trusts the covered area the server reports', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('keeps the server-reported covers, not the requested area', async () => {
    const covers = box(46.75, 46.9, -121.85, -121.7);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ landmarks: [], water: [], partial: [], covers }))));
    const osm = await fetchFeatures(box(46.8, 46.84, -121.8, -121.76), { kinds: ['peak'], lakes: false, rivers: false });
    expect(osm.covers).toEqual(covers);
  });
  it('falls back to the requested area for an older server', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ landmarks: [], water: [] }))));
    const asked = box(46.8, 46.84, -121.8, -121.76);
    expect((await fetchFeatures(asked, { kinds: ['peak'], lakes: false, rivers: false })).covers).toEqual(asked);
  });
});
