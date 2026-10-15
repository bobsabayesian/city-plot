import { bbox, haversine, type BBox } from './geo/project';
import type { TrackPoint } from './gpx/types';
import type { Feature } from './scene/project';
import { computeStats } from './geo/stats';
import type { OsmData, OsmRequest } from './features/types';

async function api<T>(path: string): Promise<T> {
  const r = await fetch(path);
  if (!r.ok) throw new Error(((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? `Request failed (${r.status})`);
  return r.json() as Promise<T>;
}

export interface GeocodeHit extends Feature { location: string; kind: string }

/** Up to six candidate matches for a typed place or feature name, best first. */
export async function geocodeFeature(q: string): Promise<GeocodeHit[]> {
  return (await api<{ results: GeocodeHit[] }>(`/api/geocode?q=${encodeURIComponent(q)}`)).results;
}

/** Region name (e.g. "Pierce County, Washington") near the track's high point. */
export async function reverseLocation(pts: TrackPoint[]): Promise<string | undefined> {
  const at = computeStats(pts).peak ?? pts[0]!;
  return (await api<{ location: string }>(`/api/reverse?lat=${at.lat}&lon=${at.lon}`)).location || undefined;
}

/** Named OSM peak closest to the track's high point, if one is within `maxM`. */
export async function nearestPeakName(pts: TrackPoint[], maxM = 1500): Promise<string | undefined> {
  const high = computeStats(pts).peak;
  if (!high) return undefined;
  const b: BBox = bbox([high]);
  const pad = 0.02;
  const qs = new URLSearchParams({
    minLat: String(b.minLat - pad), maxLat: String(b.maxLat + pad),
    minLon: String(b.minLon - pad), maxLon: String(b.maxLon + pad),
  });
  const { peaks } = await api<{ peaks: { name: string; lat: number; lon: number }[] }>(`/api/peaks?${qs}`);
  let best: { name: string; d: number } | undefined;
  for (const pk of peaks) {
    const d = haversine(high.lat, high.lon, pk.lat, pk.lon);
    if (d <= maxM && (!best || d < best.d)) best = { name: pk.name, d };
  }
  return best?.name;
}

/** Named landmarks and water lines inside `b` (at most ~1 degree across). */
export async function fetchFeatures(b: BBox, req: OsmRequest): Promise<OsmData> {
  const qs = new URLSearchParams({
    minLat: String(b.minLat), maxLat: String(b.maxLat), minLon: String(b.minLon), maxLon: String(b.maxLon),
    kinds: req.kinds.join(','), lakes: req.lakes ? '1' : '0', rivers: req.rivers ? '1' : '0',
  });
  const d = await api<Pick<OsmData, 'landmarks' | 'water' | 'partial' | 'reason'> & { covers?: BBox }>(`/api/features?${qs}`);
  // The server rounds the area outward; what it really covers is what we may reuse without another fetch.
  return { ...d, covers: d.covers ?? b, requested: req };
}
