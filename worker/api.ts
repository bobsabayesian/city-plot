/** Shared by the Cloudflare Worker (production) and the Vite dev server (local). */
const UA = 'hike-plot/0.1 (https://hike.bobsabayesian.io)';
const NOMINATIM = 'https://nominatim.openstreetmap.org';
/**
 * Tried in order. The main server sometimes refuses requests from Cloudflare's network (HTTP 521), so the
 * list leads with independent operators. Mirrors that timed out on every probe were left out.
 */
export const OVERPASS_HOSTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.openstreetmap.fr/api/interpreter',
  'https://z.overpass-api.de/api/interpreter',
];

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600, s-maxage=86400' },
  });

/** Overpass elements -> the landmarks and water lines the client draws. */
export function normalizeFeatures(elements: any[]) {
  const landmarks: any[] = [];
  const water: any[] = [];
  for (const el of elements) {
    const t = el.tags ?? {};
    if (!t.name) continue;
    if (el.type === 'node') {
      const kind =
        t.natural === 'peak' ? 'peak'
        : t.natural === 'saddle' || t.mountain_pass === 'yes' ? 'pass'
        : t.tourism === 'alpine_hut' || t.tourism === 'wilderness_hut' ? 'hut'
        : t.tourism === 'viewpoint' ? 'viewpoint'
        : t.highway === 'trailhead' ? 'trailhead'
        : undefined;
      if (!kind) continue;
      const ele = Number.parseFloat(String(t.ele ?? ''));
      landmarks.push({ id: `n${el.id}`, name: t.name, kind, lat: el.lat, lon: el.lon, ...(Number.isFinite(ele) ? { ele } : {}) });
    } else if (el.type === 'way' && Array.isArray(el.geometry) && el.geometry.length > 1) {
      const kind = t.natural === 'water' ? 'lake' : t.waterway === 'river' || t.waterway === 'stream' ? 'river' : undefined;
      if (!kind) continue;
      water.push({ id: `w${el.id}`, kind, name: t.name, coords: el.geometry.map((g: any) => [g.lat, g.lon]) });
    }
  }
  return { landmarks, water };
}

/** Overpass tag filters per point kind (each is combined with a name filter). */
const NODE_CLAUSES: Record<string, string[]> = {
  peak: ['["natural"="peak"]'],
  pass: ['["natural"="saddle"]', '["mountain_pass"="yes"]'],
  hut: ['["tourism"~"^(alpine_hut|wilderness_hut)$"]'],
  viewpoint: ['["tourism"="viewpoint"]'],
  trailhead: ['["highway"="trailhead"]'],
};

export interface Box { minLat: number; maxLat: number; minLon: number; maxLon: number }

/**
 * Grid sizes (degrees) a request is snapped outward to. The smallest grid at least as big as the request is
 * used, so any view of the same place maps to the same few squares and shares one cached answer. Blocks are at
 * most two squares wide, and the 0.175 grid keeps blocks within the water-query limit.
 */
export const SNAP_GRIDS = [0.05, 0.1, 0.175, 0.5];
export const MAX_REQUEST_SPAN = 0.5;
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

export function snapBBox(b: Box): Box {
  const span = Math.max(b.maxLat - b.minLat, b.maxLon - b.minLon);
  const g = SNAP_GRIDS.find((x) => x >= span - 1e-9) ?? SNAP_GRIDS[SNAP_GRIDS.length - 1]!; // tolerance: 46.2 - 46.1 is not exactly 0.1
  return {
    minLat: r4(Math.max(-90, Math.floor(b.minLat / g + 1e-9) * g)),
    maxLat: r4(Math.min(90, Math.ceil(b.maxLat / g - 1e-9) * g)),
    minLon: r4(Math.max(-180, Math.floor(b.minLon / g + 1e-9) * g)),
    maxLon: r4(Math.min(180, Math.ceil(b.maxLon / g - 1e-9) * g)),
  };
}

/**
 * The request that identifies an answer in the cache. Different views of one place, and different spellings of
 * one search, become the same key, so they share a cached response.
 */
export function cacheKey(req: Request): Request {
  const url = new URL(req.url);
  if (url.pathname === '/api/features') {
    const [s, n, w, e] = ['minLat', 'maxLat', 'minLon', 'maxLon'].map((k) => num(url.searchParams.get(k)));
    if ([s, n, w, e].every((v) => v !== undefined)) {
      const b = snapBBox({ minLat: s!, maxLat: n!, minLon: w!, maxLon: e! });
      const key = new URL(url.origin + url.pathname);
      key.searchParams.set('bbox', `${b.minLat},${b.minLon},${b.maxLat},${b.maxLon}`);
      const kinds = url.searchParams.get('kinds');
      key.searchParams.set('kinds', kinds === null ? '*' : kinds.split(',').filter(Boolean).sort().join(','));
      for (const f of ['lakes', 'rivers']) key.searchParams.set(f, url.searchParams.has(f) ? url.searchParams.get(f)! : '1');
      return new Request(key.toString());
    }
  }
  if (url.pathname === '/api/geocode') {
    const q = url.searchParams.get('q')?.trim().toLowerCase().replace(/\s+/g, ' ');
    if (q) {
      const key = new URL(url.origin + url.pathname);
      key.searchParams.set('q', q);
      return new Request(key.toString());
    }
  }
  return req;
}

/** Water queries get slow and flaky past this span (degrees); skip them rather than fail. */
const WATER_MAX_SPAN = 0.35;

export interface Attempt { host: string; result: string; ms: number }

/** Every server failed; carries what each one said so the caller can report it. */
export class OverpassError extends Error {
  constructor(public attempts: Attempt[]) {
    super(`overpass unavailable: ${summarize(attempts)}`);
  }
}

export const summarize = (a: Attempt[]) => a.map((x) => `${x.host} ${x.result}`).join(', ') || 'no attempt made';

/**
 * POST an Overpass query, falling through the mirror list on any failure: HTTP errors, timeouts, non-JSON
 * bodies, or a 200 that only carries a "runtime error" remark (Overpass does this when it runs out of time).
 */
async function overpass(query: string, budgetMs = 22000): Promise<any[]> {
  const start = Date.now();
  const attempts: Attempt[] = [];
  for (const url of OVERPASS_HOSTS) {
    const left = budgetMs - (Date.now() - start);
    if (left < 1500) break;
    const host = new URL(url).hostname;
    const t = Date.now();
    const note = (result: string) => attempts.push({ host, result, ms: Date.now() - t });
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(Math.min(9000, left)),
      });
      if (!r.ok) { note(String(r.status)); continue; }
      const d = (await r.json()) as { elements?: any[]; remark?: string };
      if (!d.elements?.length && d.remark) { note(`remark: ${d.remark.slice(0, 60)}`); continue; }
      return d.elements ?? [];
    } catch (e) {
      note(e instanceof Error && e.name === 'TimeoutError' ? 'timeout' : e instanceof Error ? e.message.slice(0, 60) : 'error');
    }
  }
  throw new OverpassError(attempts);
}

/** Ask each Overpass server a trivial question, so you can see from the deployed site which ones answer. */
async function health() {
  const probe = async (url: string) => {
    const t = Date.now();
    const host = new URL(url).hostname;
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent('[out:json][timeout:5];node(1);out;')}`,
        signal: AbortSignal.timeout(7000),
      });
      return { host, ok: r.ok, status: r.status, ms: Date.now() - t };
    } catch (e) {
      return { host, ok: false, error: e instanceof Error ? e.name === 'TimeoutError' ? 'timeout' : e.message : 'error', ms: Date.now() - t };
    }
  };
  const res = json({ checkedAt: new Date().toISOString(), hosts: await Promise.all(OVERPASS_HOSTS.map(probe)) });
  res.headers.set('cache-control', 'no-store');
  return res;
}

/** Nominatim search hits -> what the client lists: name, region, OSM type and extent. */
export function normalizeGeocode(hits: any[]) {
  return hits
    .filter((h) => Array.isArray(h.boundingbox) && h.boundingbox.length === 4)
    .map((h) => {
      const [s, n, w, e] = h.boundingbox.map(Number) as number[];
      const parts = String(h.display_name).split(', ');
      return {
        name: h.name || parts[0],
        location: parts.slice(1, 3).join(', '),
        kind: String(h.type ?? h.category ?? '').replace(/_/g, ' '),
        lat: +h.lat,
        lon: +h.lon,
        bbox: { minLat: s, maxLat: n, minLon: w, maxLon: e },
      };
    });
}

const num = (v: string | null) => (v !== null && v.trim() !== '' && Number.isFinite(+v) ? +v : undefined);

export async function handleApi(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith('/api/')) return null;
  if (req.method !== 'GET') return json({ error: 'method not allowed' }, 405);

  const cache = url.pathname === '/api/health' ? undefined : (globalThis as { caches?: { default?: Cache } }).caches?.default;
  const key = cache ? cacheKey(req) : req;
  const hit = await cache?.match(key);
  if (hit) return hit;

  let res: Response;
  try {
    res = await route(url);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'upstream failure' }, 502);
  }
  if (res.ok) await cache?.put(key, res.clone());
  return res;
}

async function route(url: URL): Promise<Response> {
  switch (url.pathname) {
    case '/api/geocode': {
      const q = url.searchParams.get('q')?.trim();
      if (!q || q.length > 200) return json({ error: 'missing q' }, 400);
      const r = await fetch(`${NOMINATIM}/search?format=jsonv2&limit=6&q=${encodeURIComponent(q)}`, { headers: { 'user-agent': UA } });
      if (!r.ok) return json({ error: 'geocoder unavailable' }, 502);
      const results = normalizeGeocode((await r.json()) as any[]);
      return results.length ? json({ results }) : json({ error: 'not found' }, 404);
    }
    case '/api/reverse': {
      const lat = num(url.searchParams.get('lat'));
      const lon = num(url.searchParams.get('lon'));
      if (lat === undefined || lon === undefined) return json({ error: 'missing lat/lon' }, 400);
      const r = await fetch(`${NOMINATIM}/reverse?format=jsonv2&zoom=10&lat=${lat}&lon=${lon}`, { headers: { 'user-agent': UA } });
      if (!r.ok) return json({ error: 'geocoder unavailable' }, 502);
      const d = (await r.json()) as any;
      const a = d.address ?? {};
      const place = a.county ?? a.city ?? a.town ?? a.state_district ?? a.municipality;
      const region = a.state ?? a.country;
      return json({ location: [place, region].filter(Boolean).join(', ') });
    }
    case '/api/health':
      return health();
    case '/api/peaks': {
      const [s, n, w, e] = ['minLat', 'maxLat', 'minLon', 'maxLon'].map((k) => num(url.searchParams.get(k)));
      if ([s, n, w, e].some((v) => v === undefined)) return json({ error: 'missing bbox' }, 400);
      if ((n! - s!) > 1 || (e! - w!) > 1) return json({ error: 'bbox too large' }, 400);
      const query = `[out:json][timeout:15];node["natural"="peak"]["name"](${s},${w},${n},${e});out body 100;`;
      const elements = await overpass(query);
      return json({
        peaks: elements.map((x: any) => ({ name: x.tags.name, lat: x.lat, lon: x.lon, ele: num(x.tags.ele ?? null) })),
      });
    }
    case '/api/features': {
      const [s, n, w, e] = ['minLat', 'maxLat', 'minLon', 'maxLon'].map((k) => num(url.searchParams.get(k)));
      if ([s, n, w, e].some((v) => v === undefined)) return json({ error: 'missing bbox' }, 400);
      if ((n! - s!) > MAX_REQUEST_SPAN || (e! - w!) > MAX_REQUEST_SPAN) return json({ error: 'area too large for landmarks' }, 400);
      // Snap outward to a fixed grid so every view of this place is the same query (and the same cached answer).
      const covers = snapBBox({ minLat: s!, maxLat: n!, minLon: w!, maxLon: e! });
      const bb = `(${covers.minLat},${covers.minLon},${covers.maxLat},${covers.maxLon})`;
      // Ask only for what the client shows: fewer clauses means a cheaper query on a busy public server.
      // With no params at all (older clients) everything is requested.
      const kindsParam = url.searchParams.get('kinds');
      const kinds = kindsParam === null ? Object.keys(NODE_CLAUSES) : kindsParam.split(',').filter((k) => k in NODE_CLAUSES);
      const flag = (k: string) => (url.searchParams.has(k) ? url.searchParams.get(k) === '1' : true);
      const wantLakes = flag('lakes');
      const wantRivers = flag('rivers');
      const nodeQuery = `[out:json][timeout:20];
(${kinds.flatMap((k) => NODE_CLAUSES[k]!).map((c) => `node${c}["name"]${bb};`).join('')});out body 300;`;
      const waterQuery = `[out:json][timeout:20];
(${wantLakes ? `way["natural"="water"]["name"]${bb};` : ''}${wantRivers ? `way["waterway"="river"]["name"]${bb};` : ''});out geom 150;`;
      // Point features are cheap and reliable; ways with geometry are what the public Overpass servers
      // time out on. Fetch them separately so a water failure never costs the landmarks.
      const waterTooBig = covers.maxLat - covers.minLat > WATER_MAX_SPAN + 1e-9 || covers.maxLon - covers.minLon > WATER_MAX_SPAN + 1e-9;
      const [nodes, water] = await Promise.allSettled([
        kinds.length ? overpass(nodeQuery) : Promise.resolve([]),
        !wantLakes && !wantRivers ? Promise.resolve([]) : waterTooBig ? Promise.reject(new Error('area too large for water')) : overpass(waterQuery),
      ]);
      const why = (r: PromiseSettledResult<unknown>, part: string) =>
        r.status === 'rejected' ? `${part}: ${r.reason instanceof Error ? r.reason.message.replace('overpass unavailable: ', '') : 'failed'}` : '';
      if (nodes.status === 'rejected' && water.status === 'rejected')
        return json({ error: `overpass unavailable. ${why(nodes, 'landmarks')}; ${why(water, 'water')}` }, 502);
      const partial = [nodes.status === 'rejected' ? 'landmarks' : '', water.status === 'rejected' ? 'water' : ''].filter(Boolean);
      const out = normalizeFeatures([
        ...(nodes.status === 'fulfilled' ? nodes.value : []),
        ...(water.status === 'fulfilled' ? water.value : []),
      ]);
      const reason = [why(nodes, 'landmarks'), why(water, 'water')].filter(Boolean).join('; ');
      const res = json({ ...out, covers, partial, ...(reason ? { reason } : {}) });
      // Don't let a degraded answer sit in the cache for a day.
      if (partial.length) res.headers.set('cache-control', 'public, max-age=60, s-maxage=60');
      return res;
    }
    default:
      return json({ error: 'not found' }, 404);
  }
}
