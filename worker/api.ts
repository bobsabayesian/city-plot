/** Shared by the Cloudflare Worker (production) and the Vite dev server (local). */
import { LANDMARKS_MAX_KM, LAYER_KEYS, LAYER_MAX_KM, SNAP_DEG, type LayerKey, type Way } from '../src/city/types';
import type { Landmark, LandmarkKind } from '../src/features/types';

const UA = 'city-plot/0.1 (pen plotter map posters)';
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

const r5 = (v: number) => Math.round(v * 1e5) / 1e5;

type Pt = [number, number];
/** A way's geometry as [lat, lon] points. Nodes outside an `out geom(bbox)` area arrive as null and break the line. */
const geometryPieces = (geometry: ({ lat: number; lon: number } | null)[] | undefined): Pt[][] => {
  const pieces: Pt[][] = [];
  let cur: Pt[] = [];
  for (const g of geometry ?? []) {
    if (g && Number.isFinite(g.lat) && Number.isFinite(g.lon)) cur.push([r5(g.lat), r5(g.lon)]);
    else { if (cur.length > 1) pieces.push(cur); cur = []; }
  }
  if (cur.length > 1) pieces.push(cur);
  return pieces;
};

const same = (a: Pt, b: Pt) => a[0] === b[0] && a[1] === b[1];
const flat = (pts: Pt[]) => pts.flatMap(([la, lo]) => [la, lo]);

/** Join line pieces that share an end point into longer lines (and closed rings where they meet up). */
export function stitch(pieces: Pt[][]): Pt[][] {
  const todo = pieces.map((p) => [...p]);
  const done: Pt[][] = [];
  while (todo.length) {
    let cur = todo.pop()!;
    for (let grew = true; grew && !same(cur[0]!, cur[cur.length - 1]!); ) {
      grew = false;
      for (let i = 0; i < todo.length; i++) {
        const o = todo[i]!;
        const [cs, ce] = [cur[0]!, cur[cur.length - 1]!];
        const [os, oe] = [o[0]!, o[o.length - 1]!];
        let joined: Pt[] | undefined;
        if (same(ce, os)) joined = [...cur, ...o.slice(1)];
        else if (same(ce, oe)) joined = [...cur, ...[...o].reverse().slice(1)];
        else if (same(cs, oe)) joined = [...o, ...cur.slice(1)];
        else if (same(cs, os)) joined = [...[...o].reverse(), ...cur.slice(1)];
        if (joined) { cur = joined; todo.splice(i, 1); grew = true; break; }
      }
    }
    done.push(cur);
  }
  return done;
}

const waterSub = (t: Record<string, string>) =>
  t.natural === 'coastline' ? 'coastline' : t.natural === 'water' || t.waterway === 'riverbank' || t.natural === 'bay' ? 'lake' : t.waterway;

/**
 * Overpass ways (and multipolygon relations, for the layers whose areas are often relations) -> the flat way
 * lists the client draws. Coordinates are rounded to 1e-5 degrees (about a meter), which keeps big answers small.
 */
export function normalizeWays(elements: any[], layer: LayerKey): Way[] {
  const out: Way[] = [];
  for (const el of elements) {
    const t: Record<string, string> = el.tags ?? {};
    const sub = layer === 'water' ? waterSub(t) : undefined;
    const name = layer === 'water' || layer === 'parks' ? t.name : undefined;
    const make = (id: string, pts: Pt[]): Way => {
      const closed = pts.length >= 4 && same(pts[0]!, pts[pts.length - 1]!);
      return { id, ...(name ? { name } : {}), ...(sub ? { sub } : {}), closed, pts: flat(pts) };
    };
    if (el.type === 'way') {
      geometryPieces(el.geometry).forEach((p, i) => out.push(make(i ? `w${el.id}-${i}` : `w${el.id}`, p)));
    } else if (el.type === 'relation' && Array.isArray(el.members)) {
      // outer boundaries are stitched into rings; holes (inner) are rings of their own, which fill with the even-odd rule
      const pieces = (el.members as any[]).filter((m) => m.type === 'way').flatMap((m) => geometryPieces(m.geometry));
      stitch(pieces).forEach((p, i) => out.push(make(`r${el.id}-${i}`, p)));
    }
  }
  return out;
}

/** Overpass element -> a landmark (or undefined when it is not one of the kinds we draw). */
export function toLandmark(el: any): Landmark | undefined {
  const t: Record<string, string> = el.tags ?? {};
  if (!t.name) return undefined;
  const lat = el.type === 'node' ? el.lat : el.center?.lat;
  const lon = el.type === 'node' ? el.lon : el.center?.lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;
  const kind: LandmarkKind | undefined =
    t.tourism === 'attraction' ? 'attraction'
    : t.tourism === 'museum' || t.tourism === 'gallery' ? 'museum'
    : t.historic ? 'historic'
    : t.amenity === 'place_of_worship' ? 'worship'
    : t.railway === 'station' || t.public_transport === 'station' ? 'station'
    : t.leisure === 'park' ? 'park'
    : t.amenity === 'university' ? 'university'
    : t.leisure === 'stadium' ? 'stadium'
    : undefined;
  if (!kind) return undefined;
  return { id: `${el.type[0]}${el.id}`, name: t.name, kind, lat: r5(lat), lon: r5(lon), ...(t.wikidata || t.wikipedia ? { notable: true } : {}) };
}

/** Overpass filters (ways, and relations where noted) for each map layer, before the bounding box. */
const HIGHWAY = (re: string, extra = '') => [`way["highway"~"^(${re})$"]${extra}`];
export const LAYER_CLAUSES: Record<LayerKey, string[]> = {
  major: HIGHWAY('motorway|motorway_link|trunk|trunk_link|primary|primary_link'),
  secondary: HIGHWAY('secondary|secondary_link|tertiary|tertiary_link'),
  minor: HIGHWAY('residential|unclassified|living_street|road|service', '["service"!~"^(driveway|parking_aisle|drive-through|emergency_access)$"]'),
  paths: HIGHWAY('footway|pedestrian|cycleway|path|steps|track|bridleway'),
  rail: ['way["railway"~"^(rail|light_rail|tram|narrow_gauge)$"]["tunnel"!="yes"]["service"!~"."]'],
  buildings: ['way["building"]'],
  water: [
    'way["natural"="water"]', 'way["waterway"="riverbank"]', 'way["waterway"~"^(river|canal)$"]["tunnel"!="yes"]', 'way["natural"="coastline"]',
    'relation["natural"="water"]', 'relation["waterway"="riverbank"]',
  ],
  parks: [
    'way["leisure"~"^(park|garden|nature_reserve)$"]', 'way["landuse"~"^(grass|recreation_ground|village_green|forest)$"]', 'way["natural"="wood"]',
    'relation["leisure"~"^(park|garden|nature_reserve)$"]', 'relation["landuse"~"^(grass|forest)$"]',
  ],
};
/** Most elements asked of Overpass per layer; an answer this long may be cut short. */
export const LAYER_LIMIT: Record<LayerKey, number> = {
  major: 5000, secondary: 8000, minor: 30000, paths: 30000, rail: 5000, buildings: 60000, water: 3000, parks: 6000,
};

export interface Box { minLat: number; maxLat: number; minLon: number; maxLon: number }

/** Round a box outward to a fixed grid, so views of the same place that differ a little share one query and one cached answer. */
export function snapBBox(b: Box): Box {
  const g = SNAP_DEG;
  const r = (v: number) => Math.round(v * 1e4) / 1e4;
  return {
    minLat: r(Math.max(-90, Math.floor(b.minLat / g + 1e-9) * g)),
    maxLat: r(Math.min(90, Math.ceil(b.maxLat / g - 1e-9) * g)),
    minLon: r(Math.max(-180, Math.floor(b.minLon / g + 1e-9) * g)),
    maxLon: r(Math.min(180, Math.ceil(b.maxLon / g - 1e-9) * g)),
  };
}

/** Rough size of a box in km (width, height). */
export const boxKm = (b: Box): [number, number] => [
  (b.maxLon - b.minLon) * 111.32 * Math.cos((((b.minLat + b.maxLat) / 2) * Math.PI) / 180),
  (b.maxLat - b.minLat) * 110.57,
];

/** The request that identifies an answer in the cache: different views of one place share it. */
export function cacheKey(req: Request): Request {
  const url = new URL(req.url);
  if (url.pathname === '/api/layer' || url.pathname === '/api/landmarks') {
    const [s, n, w, e] = ['minLat', 'maxLat', 'minLon', 'maxLon'].map((k) => num(url.searchParams.get(k)));
    if ([s, n, w, e].every((v) => v !== undefined)) {
      const b = snapBBox({ minLat: s!, maxLat: n!, minLon: w!, maxLon: e! });
      const key = new URL(url.origin + url.pathname);
      key.searchParams.set('bbox', `${b.minLat},${b.minLon},${b.maxLat},${b.maxLon}`);
      for (const f of ['layer', 'notable']) if (url.searchParams.has(f)) key.searchParams.set(f, url.searchParams.get(f)!);
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
async function overpass(query: string, budgetMs = 22000, hostMs = 9000): Promise<any[]> {
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
        signal: AbortSignal.timeout(Math.min(hostMs, left)),
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

const readBox = (url: URL): Box | undefined => {
  const [s, n, w, e] = ['minLat', 'maxLat', 'minLon', 'maxLon'].map((k) => num(url.searchParams.get(k)));
  return [s, n, w, e].some((v) => v === undefined) ? undefined : { minLat: s!, maxLat: n!, minLon: w!, maxLon: e! };
};

const num = (v: string | null) => (v !== null && v.trim() !== '' && Number.isFinite(+v) ? +v : undefined);

/** The slice of an R2 bucket the export route uses. */
export interface FilesBucket { put(key: string, body: ArrayBuffer, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown> }
export interface ApiEnv { FILES?: FilesBucket }

export const MAX_EXPORT_BYTES = 30 * 1024 * 1024;
const EXPORT_TYPES: Record<string, string> = { svg: 'image/svg+xml', png: 'image/png', json: 'application/json' };

/** Where an uploaded file is kept: `city-plot/<session>/<time>-<name>`. Undefined when the session or name is not safe. */
export function exportKey(name: string, session: string, now = new Date()): string | undefined {
  const m = name.toLowerCase().match(/^([a-z0-9][a-z0-9._-]{0,80})\.(svg|png|json)$/);
  if (!m || !/^[a-z0-9-]{8,64}$/.test(session)) return undefined;
  return `city-plot/${session}/${now.toISOString().replace(/[:.]/g, '-')}-${m[1]!.replace(/\.+/g, '-')}.${m[2]}`;
}

async function saveExport(req: Request, url: URL, env: ApiEnv): Promise<Response> {
  if (!env.FILES) return json({ error: 'no storage bucket is connected' }, 501);
  const key = exportKey(url.searchParams.get('name') ?? '', url.searchParams.get('session') ?? '');
  if (!key) return json({ error: 'bad file name or session' }, 400);
  const body = await req.arrayBuffer();
  if (!body.byteLength || body.byteLength > MAX_EXPORT_BYTES) return json({ error: 'file empty or too large' }, 413);
  await env.FILES.put(key, body, { httpMetadata: { contentType: EXPORT_TYPES[key.slice(key.lastIndexOf('.') + 1)]! } });
  const res = json({ key });
  res.headers.set('cache-control', 'no-store');
  return res;
}

export async function handleApi(req: Request, env: ApiEnv = {}): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith('/api/')) return null;
  if (url.pathname === '/api/export' && req.method === 'POST') {
    try { return await saveExport(req, url, env); } catch (e) { return json({ error: e instanceof Error ? e.message : 'save failed' }, 500); }
  }
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
      const place = a.city ?? a.town ?? a.village ?? a.municipality ?? a.county ?? a.state_district;
      const region = a.state ?? a.country;
      return json({ location: [place, region].filter(Boolean).join(', ') });
    }
    case '/api/health':
      return health();
    case '/api/layer': {
      const layer = url.searchParams.get('layer') as LayerKey | null;
      if (!layer || !LAYER_KEYS.includes(layer)) return json({ error: 'unknown layer' }, 400);
      const box = readBox(url);
      if (!box) return json({ error: 'missing bbox' }, 400);
      const [w, h] = boxKm(box);
      // the client pads what it asks for by up to 30%, and a turned map needs the box around a tilted view, so allow room over the layer's own limit
      if (Math.max(w, h) > LAYER_MAX_KM[layer] * 2 + 1) return json({ error: `area too large for ${layer}` }, 400);
      const covers = snapBBox(box);
      const bb = `(${covers.minLat},${covers.minLon},${covers.maxLat},${covers.maxLon})`;
      const limit = LAYER_LIMIT[layer];
      // ways come whole; relations (big lakes and parks) are cut to the box so a sea does not come back in full
      const query = `[out:json][timeout:40][maxsize:536870912];
(${LAYER_CLAUSES[layer].map((c) => `${c}${bb};`).join('')});out geom${LAYER_CLAUSES[layer].some((c) => c.startsWith('relation')) ? bb : ''} ${limit};`;
      const elements = await overpass(query, 45000, 30000);
      const res = json({ covers, ways: normalizeWays(elements, layer), ...(elements.length >= limit ? { truncated: true } : {}) });
      if (elements.length >= limit) res.headers.set('cache-control', 'public, max-age=60, s-maxage=60');
      return res;
    }
    case '/api/landmarks': {
      const box = readBox(url);
      if (!box) return json({ error: 'missing bbox' }, 400);
      if (Math.max(...boxKm(box)) > LANDMARKS_MAX_KM * 2 + 1) return json({ error: 'area too large for landmarks' }, 400);
      const covers = snapBBox(box);
      const bb = `(${covers.minLat},${covers.minLon},${covers.maxLat},${covers.maxLon})`;
      const notable = url.searchParams.get('notable') === '1' ? '["wikidata"]' : '';
      const clauses = [
        '["tourism"="attraction"]', '["tourism"~"^(museum|gallery)$"]',
        '["historic"~"^(monument|castle|fort|archaeological_site|ruins|building|city_gate|palace)$"]',
        '["amenity"="place_of_worship"]', '["railway"="station"]', '["leisure"="park"]', '["amenity"="university"]', '["leisure"="stadium"]',
      ];
      const query = `[out:json][timeout:30];
(${clauses.map((c) => `nwr${c}["name"]${notable}${bb};`).join('')});out center 2000;`;
      const elements = await overpass(query, 35000, 25000);
      const landmarks = elements.map(toLandmark).filter((l): l is Landmark => !!l);
      return json({ covers, landmarks });
    }
    default:
      return json({ error: 'not found' }, 404);
  }
}
