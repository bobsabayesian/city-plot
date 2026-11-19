import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { clipPolygon, clipPolyline, type XY } from '../geo/clip';
import type { BBox } from '../geo/project';
import type { WaterName } from '../features/types';
import { LAYER_KEYS, type LayerKey, type Way } from './types';

/**
 * Map layers from OpenFreeMap's OpenMapTiles vector tiles: streets, buildings, water, parks and railways for a whole
 * view in one go. Tiles are static files, so this takes a second or two where an Overpass query for the same area
 * can take a minute. Fetch them from the user's own browser (the service's terms rule out automated collection),
 * at most four at once, and keep the count modest.
 */
export const TILEJSON_URL = 'https://tiles.openfreemap.org/planet';
/** The sharpest zoom the tiles have. Buildings and footpaths only exist at the top zooms. */
export const MAX_ZOOM = 14;
export const MIN_ZOOM = 8;
/** Most tiles one view may take; a bigger area is fetched at a lower zoom instead. */
export const MAX_TILES = 150;
export const CONCURRENCY = 4;
/** Ponds and pools smaller than this are left out of the water (m²). */
export const MIN_WATER_AREA_M2 = 400;

export interface TileCoord { z: number; x: number; y: number }
export interface DecodedCityTile { ways: Record<LayerKey, Way[]>; waterNames: WaterName[] }

const emptyTile = (): DecodedCityTile => ({ ways: Object.fromEntries(LAYER_KEYS.map((k) => [k, []])) as unknown as Record<LayerKey, Way[]>, waterNames: [] });

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const tileX = (lon: number, z: number) => ((lon + 180) / 360) * 2 ** z;
const tileY = (lat: number, z: number) => {
  const s = Math.sin((clamp(lat, -85.05, 85.05) * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z;
};
const lonAt = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
const latAt = (y: number, z: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;
const r5 = (v: number) => Math.round(v * 1e5) / 1e5;

/** The range of tiles that covers a bounding box at one zoom. */
function tileRange(b: BBox, z: number) {
  const n = 2 ** z;
  return {
    x0: clamp(Math.floor(tileX(b.minLon, z)), 0, n - 1), x1: clamp(Math.floor(tileX(b.maxLon, z)), 0, n - 1),
    y0: clamp(Math.floor(tileY(b.maxLat, z)), 0, n - 1), y1: clamp(Math.floor(tileY(b.minLat, z)), 0, n - 1),
  };
}

/** How many tiles cover a bounding box at one zoom (counted, not listed, so a huge area costs nothing). */
export const tileCount = (b: BBox, z: number) => { const r = tileRange(b, z); return (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1); };

/** The tiles that cover a bounding box at one zoom. */
export function tilesFor(b: BBox, z: number): TileCoord[] {
  const { x0, x1, y0, y1 } = tileRange(b, z);
  const out: TileCoord[] = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push({ z, x, y });
  return out;
}

/** The sharpest zoom whose tile count for this area stays within the budget. */
export function pickZoom(b: BBox, maxTiles = MAX_TILES): number {
  for (let z = MAX_ZOOM; z >= MIN_ZOOM; z--) if (tileCount(b, z) <= maxTiles) return z;
  return MIN_ZOOM;
}

/** The area a set of tiles covers. */
export function tilesBBox(tiles: TileCoord[]): BBox {
  const z = tiles[0]!.z;
  const xs = tiles.map((t) => t.x);
  const ys = tiles.map((t) => t.y);
  return { minLat: latAt(Math.max(...ys) + 1, z), maxLat: latAt(Math.min(...ys), z), minLon: lonAt(Math.min(...xs), z), maxLon: lonAt(Math.max(...xs) + 1, z) };
}

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** Which map layer a street, track or railway belongs to (undefined: not drawn). */
export function transportLayer(p: Record<string, unknown>): LayerKey | undefined {
  const cls = text(p.class);
  const sub = text(p.subclass);
  switch (cls) {
    case 'motorway': case 'trunk': case 'primary': return 'major';
    case 'secondary': case 'tertiary': return 'secondary';
    case 'minor': return 'minor';
    case 'service': return ['driveway', 'parking_aisle', 'drive-through', 'emergency_access'].includes(text(p.service)) ? undefined : 'minor';
    case 'track': return 'paths';
    case 'path': return sub === 'platform' || sub === 'corridor' ? undefined : 'paths';
    case 'rail': return text(p.brunnel) === 'tunnel' ? undefined : 'rail';
    case 'transit': return (sub === 'light_rail' || sub === 'tram') && text(p.brunnel) !== 'tunnel' ? 'rail' : undefined;
    default: return undefined;
  }
}

/** Turn one tile's bytes into ways for each map layer, plus lake names. Each feature belongs to the tile it lies in. */
export function decodeCityTile(bytes: Uint8Array, z: number, tx: number, ty: number): DecodedCityTile {
  const vt = new VectorTile(new PbfReader(bytes));
  const out = emptyTile();
  const tag = `${z}-${tx}-${ty}`;

  for (const [layerName, layer] of Object.entries(vt.layers)) {
    const ext = layer.extent;
    const rect = { x: 0, y: 0, w: ext, h: ext };
    const toLL = (x: number, y: number): [number, number] => [r5(latAt(ty + y / ext, z)), r5(lonAt(tx + x / ext, z))];
    const flat = (pts: XY[]) => pts.flatMap(([x, y]) => toLL(x, y));
    const metersPerUnit = (40075016.686 * Math.cos((latAt(ty + 0.5, z) * Math.PI) / 180)) / (2 ** z * ext);
    let n = 0;

    // Lines are cut to the tile's own square: tiles carry a margin that neighbors also draw, and without this
    // every street along a tile border would be drawn twice.
    const addLine = (layerKey: LayerKey, pts: XY[], extra: Partial<Way> = {}) => {
      for (const piece of clipPolyline(pts, rect)) if (piece.length >= 2) out.ways[layerKey].push({ id: `${layerKey}:${tag}:${n++}`, closed: false, pts: flat(piece), ...extra });
    };
    /**
     * An area ring. Wholly inside the tile it is one closed way. Cut by the tile edge, its outline is drawn as open
     * lines (so no false edge shows along the border) and its inside as a separate fill-only ring, both cut to the
     * tile; the neighbor tile supplies the rest.
     */
    const addArea = (layerKey: LayerKey, ring: XY[], extra: Partial<Way> = {}) => {
      if (ring.length < 3) return;
      const closed = ring[0]![0] === ring[ring.length - 1]![0] && ring[0]![1] === ring[ring.length - 1]![1] ? ring : [...ring, ring[0]!];
      if (closed.every(([x, y]) => x >= 0 && x <= ext && y >= 0 && y <= ext)) {
        out.ways[layerKey].push({ id: `${layerKey}:${tag}:${n++}`, closed: true, pts: flat(closed), ...extra });
        return;
      }
      const pieces = clipPolyline(closed, rect);
      if (!pieces.length) return;
      for (const piece of pieces) if (piece.length >= 2) out.ways[layerKey].push({ id: `${layerKey}:${tag}:${n++}`, closed: false, pts: flat(piece), ...extra });
      const inside = clipPolygon(closed, rect);
      if (inside.length >= 3) out.ways[layerKey].push({ id: `${layerKey}:${tag}:${n++}`, closed: true, fill: true, pts: flat([...inside, inside[0]!]), ...extra });
    };
    const rings = (f: ReturnType<typeof layer.feature>) => f.loadGeometry().map((r) => r.map((q): XY => [q.x, q.y]));
    const area = (r: XY[]) => { let a = 0; for (let i = 0; i < r.length; i++) { const b = r[(i + 1) % r.length]!; a += r[i]![0] * b[1] - b[0] * r[i]![1]; } return Math.abs(a) / 2; };

    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      const p = f.properties;

      if (layerName === 'transportation') {
        if (f.type !== 2) continue; // lines only: piers, bridges and platforms come as areas
        const key = transportLayer(p);
        if (key) for (const line of rings(f)) addLine(key, line);
      } else if (layerName === 'building') {
        for (const ring of rings(f)) addArea('buildings', ring);
      } else if (layerName === 'landcover') {
        const cls = text(p.class);
        if (cls === 'grass' || cls === 'wood') for (const ring of rings(f)) addArea('parks', ring);
      } else if (layerName === 'water') {
        if (text(p.class) === 'swimming_pool') continue;
        for (const ring of rings(f)) if (area(ring) * metersPerUnit * metersPerUnit >= MIN_WATER_AREA_M2) addArea('water', ring, { sub: 'lake' });
      } else if (layerName === 'waterway') {
        const cls = text(p.class);
        if (cls !== 'river' && cls !== 'canal') continue;
        const name = text(p.name);
        for (const line of rings(f)) addLine('water', line, { sub: cls, ...(name ? { name } : {}) });
      } else if (layerName === 'water_name') {
        const name = text(p.name);
        const cls = text(p.class);
        const pt = f.loadGeometry()[0]?.[0];
        // lake labels sit anywhere in the tile's wide margin and the same lake shows up in several tiles,
        // so there is no owner tile: accept them all and keep one per name later
        if (!name || !pt || cls === 'ocean' || cls === 'sea' || cls === 'river') continue;
        const [lat, lon] = toLL(pt.x, pt.y);
        out.waterNames.push({ id: `t:wn:${name}:${lat.toFixed(4)},${lon.toFixed(4)}`, name, lat, lon });
      }
    }
  }
  return out;
}

type Fetcher = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer>; json(): Promise<unknown> }>;

let template: { url: string; at: number } | undefined;
const TEMPLATE_TTL_MS = 3_600_000;

/** The current tile address. It carries the build date, which changes weekly, so it is read from the TileJSON. */
export async function tileTemplate(f: Fetcher = fetch as Fetcher, signal?: AbortSignal): Promise<string> {
  if (template && Date.now() - template.at < TEMPLATE_TTL_MS) return template.url;
  const r = await f(TILEJSON_URL, { signal });
  if (!r.ok) throw new Error(`Map tile service answered ${r.status}`);
  const url = ((await r.json()) as { tiles?: unknown[] }).tiles?.[0];
  if (typeof url !== 'string' || !/\{z\}.*\{x\}.*\{y\}/.test(url)) throw new Error('Map tile service gave an unexpected answer');
  template = { url, at: Date.now() };
  return url;
}

const cache = new Map<string, Promise<DecodedCityTile>>();
/** Decoded tiles are big (every building in them), so fewer are kept than a landmark-only cache would. */
const CACHE_MAX = 400;

/** Forget what was cached (for tests). */
export function resetTileCache() {
  template = undefined;
  cache.clear();
}

function getTile(url: string, c: TileCoord, f: Fetcher, signal?: AbortSignal): Promise<DecodedCityTile> {
  const hit = cache.get(url);
  if (hit) return hit;
  const p = (async () => {
    let last = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await f(url, { signal });
      if (r.ok) return decodeCityTile(new Uint8Array(await r.arrayBuffer()), c.z, c.x, c.y);
      if (r.status === 404 || r.status === 204) return emptyTile(); // an empty tile
      last = r.status;
    }
    throw new Error(`Map tile ${c.z}/${c.x}/${c.y} failed (${last})`);
  })();
  cache.set(url, p);
  p.catch(() => cache.delete(url));
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return p;
}

/** Run `job` over `items`, at most `limit` at a time. */
async function pool<T, R>(items: T[], limit: number, job: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await job(items[i]!); }
  }));
  return out;
}

export interface CityTiles {
  layers: Record<LayerKey, Way[]>;
  waterNames: WaterName[];
  /** the area the tiles cover (at least the area asked for) */
  covers: BBox;
  zoom: number;
  tiles: number;
  /** the sharpest zoom: footpaths, small streets and buildings are all there */
  complete: boolean;
}

export interface TileOptions { fetch?: Fetcher; signal?: AbortSignal; maxTiles?: number }

/** Every map layer for an area, from the vector tiles. */
export async function loadCityTiles(b: BBox, opts: TileOptions = {}): Promise<CityTiles> {
  const f = opts.fetch ?? (fetch as Fetcher);
  const zoom = pickZoom(b, opts.maxTiles ?? MAX_TILES);
  const tiles = tilesFor(b, zoom);
  const tpl = await tileTemplate(f, opts.signal);
  const decoded = await pool(tiles, CONCURRENCY, (t) =>
    getTile(tpl.replace('{z}', String(t.z)).replace('{x}', String(t.x)).replace('{y}', String(t.y)), t, f, opts.signal));
  const layers = emptyTile().ways;
  const names = new Map<string, WaterName>();
  for (const d of decoded) {
    for (const k of LAYER_KEYS) for (const w of d.ways[k]) layers[k].push(w);
    for (const n of d.waterNames) if (!names.has(n.name.toLowerCase())) names.set(n.name.toLowerCase(), n);
  }
  return { layers, waterNames: [...names.values()], covers: tilesBBox(tiles), zoom, tiles: tiles.length, complete: zoom >= MAX_ZOOM };
}
