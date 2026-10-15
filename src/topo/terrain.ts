import type { BBox } from '../geo/project';

export const TILE = 256;
export const TILE_URL = (z: number, x: number, y: number) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

/** Elevation samples (meters) on a regular Web Mercator pixel grid. */
export interface TerrainField {
  z: number;
  /** world pixel of grid cell (0,0) */
  px0: number;
  py0: number;
  w: number;
  h: number;
  data: Float32Array;
  /** geographic area the grid fully covers */
  covers: BBox;
}

export type TileFetcher = (z: number, x: number, y: number) => Promise<Float32Array>;

export const decodeTerrarium = (r: number, g: number, b: number) => r * 256 + g + b / 256 - 32768;

export function lonToPx(lon: number, z: number) {
  return ((lon + 180) / 360) * TILE * 2 ** z;
}
export function latToPx(lat: number, z: number) {
  const s = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE * 2 ** z;
}
export function pxToLon(px: number, z: number) {
  return (px / (TILE * 2 ** z)) * 360 - 180;
}
export function pxToLat(py: number, z: number) {
  const n = Math.PI - (2 * Math.PI * py) / (TILE * 2 ** z);
  return (Math.atan(Math.sinh(n)) * 180) / Math.PI;
}

export const covers = (field: Pick<TerrainField, 'covers'>, need: BBox) =>
  need.minLat >= field.covers.minLat && need.maxLat <= field.covers.maxLat &&
  need.minLon >= field.covers.minLon && need.maxLon <= field.covers.maxLon;

export const padBBox = (b: BBox, frac: number): BBox => {
  const dLat = (b.maxLat - b.minLat) * frac;
  const dLon = (b.maxLon - b.minLon) * frac;
  return {
    minLat: Math.max(-85, b.minLat - dLat), maxLat: Math.min(85, b.maxLat + dLat),
    minLon: Math.max(-180, b.minLon - dLon), maxLon: Math.min(180, b.maxLon + dLon),
  };
};

/** Highest zoom whose tile footprint for `bbox` stays within maxTiles per axis. */
export function pickZoom(b: BBox, maxTilesPerAxis = 4, maxZoom = 13): number {
  for (let z = maxZoom; z > 0; z--) {
    const tx = Math.floor(lonToPx(b.maxLon, z) / TILE) - Math.floor(lonToPx(b.minLon, z) / TILE) + 1;
    const ty = Math.floor(latToPx(b.minLat, z) / TILE) - Math.floor(latToPx(b.maxLat, z) / TILE) + 1;
    if (tx <= maxTilesPerAxis && ty <= maxTilesPerAxis) return z;
  }
  return 1;
}

/** Fetch + stitch the tiles covering `bbox` (padded by the caller). */
export async function loadTerrain(bbox: BBox, fetchTile: TileFetcher = browserTileFetcher): Promise<TerrainField> {
  const z = pickZoom(bbox);
  const n = 2 ** z;
  const tx0 = Math.max(0, Math.floor(lonToPx(bbox.minLon, z) / TILE));
  const tx1 = Math.min(n - 1, Math.floor(lonToPx(bbox.maxLon, z) / TILE));
  const ty0 = Math.max(0, Math.floor(latToPx(bbox.maxLat, z) / TILE));
  const ty1 = Math.min(n - 1, Math.floor(latToPx(bbox.minLat, z) / TILE));
  const w = (tx1 - tx0 + 1) * TILE;
  const h = (ty1 - ty0 + 1) * TILE;
  const data = new Float32Array(w * h);
  const jobs: Promise<void>[] = [];
  for (let ty = ty0; ty <= ty1; ty++)
    for (let tx = tx0; tx <= tx1; tx++)
      jobs.push(
        fetchTile(z, tx, ty).then((tile) => {
          for (let row = 0; row < TILE; row++)
            data.set(tile.subarray(row * TILE, (row + 1) * TILE), ((ty - ty0) * TILE + row) * w + (tx - tx0) * TILE);
        }),
      );
  await Promise.all(jobs);
  const px0 = tx0 * TILE;
  const py0 = ty0 * TILE;
  return {
    z, px0, py0, w, h, data,
    covers: {
      minLat: pxToLat(py0 + h, z), maxLat: pxToLat(py0, z),
      minLon: pxToLon(px0, z), maxLon: pxToLon(px0 + w, z),
    },
  };
}

const tileCache = new Map<string, Promise<Float32Array>>();

export const browserTileFetcher: TileFetcher = (z, x, y) => {
  const key = `${z}/${x}/${y}`;
  let hit = tileCache.get(key);
  if (!hit) {
    hit = (async () => {
      const res = await fetch(TILE_URL(z, x, y));
      if (!res.ok) throw new Error(`Terrain tile ${key} failed (${res.status})`);
      const bmp = await createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      const cv = new OffscreenCanvas(TILE, TILE);
      const ctx = cv.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(bmp, 0, 0);
      const px = ctx.getImageData(0, 0, TILE, TILE).data;
      const out = new Float32Array(TILE * TILE);
      for (let i = 0; i < out.length; i++) out[i] = decodeTerrarium(px[i * 4]!, px[i * 4 + 1]!, px[i * 4 + 2]!);
      return out;
    })();
    hit.catch(() => tileCache.delete(key));
    tileCache.set(key, hit);
  }
  return hit;
};
