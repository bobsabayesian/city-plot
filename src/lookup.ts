import type { BBox } from './geo/project';
import type { Place } from './scene/project';
import type { LandmarkData } from './features/types';
import type { LayerData, LayerKey } from './city/types';

async function api<T>(path: string): Promise<T> {
  const r = await fetch(path);
  if (!r.ok) throw new Error(((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? `Request failed (${r.status})`);
  return r.json() as Promise<T>;
}

export interface GeocodeHit extends Place { location: string; kind: string; bbox: NonNullable<Place['bbox']> }

/** Up to six candidate matches for a typed place, landmark or address, best first. */
export async function geocode(q: string): Promise<GeocodeHit[]> {
  return (await api<{ results: GeocodeHit[] }>(`/api/geocode?q=${encodeURIComponent(q)}`)).results;
}

/** Region name (e.g. "Seattle, Washington") for a point. */
export async function reverseLocation(lat: number, lon: number): Promise<string | undefined> {
  return (await api<{ location: string }>(`/api/reverse?lat=${lat}&lon=${lon}`)).location || undefined;
}

const boxParams = (b: BBox) => ({ minLat: String(b.minLat), maxLat: String(b.maxLat), minLon: String(b.minLon), maxLon: String(b.maxLon) });

/** One map layer's ways inside `b`. The server rounds the area outward; `covers` is what the answer is complete for. */
export function fetchLayer(layer: LayerKey, b: BBox): Promise<LayerData> {
  return api<LayerData>(`/api/layer?${new URLSearchParams({ layer, ...boxParams(b) })}`);
}

/** Named landmarks inside `b`; `notableOnly` asks only for ones linked to Wikidata (for wide views). */
export async function fetchLandmarks(b: BBox, notableOnly: boolean): Promise<LandmarkData> {
  const d = await api<Pick<LandmarkData, 'landmarks' | 'covers'>>(`/api/landmarks?${new URLSearchParams({ ...boxParams(b), notable: notableOnly ? '1' : '0' })}`);
  return { ...d, notableOnly };
}

let session: string | undefined;
/** An id for this browser session, so everything saved from it lands in one folder. Kept for the tab's lifetime. */
export function sessionId(): string {
  if (session) return session;
  try { session = sessionStorage.getItem('city-plot-session') ?? undefined; } catch { /* storage blocked */ }
  if (!session) {
    session = crypto.randomUUID();
    try { sessionStorage.setItem('city-plot-session', session); } catch { /* storage blocked */ }
  }
  return session;
}

/** Keep a copy of an export in the project's storage bucket. Resolves to false when there is none (local dev) or it failed. */
export async function saveExport(name: string, data: Blob): Promise<boolean> {
  try {
    return (await fetch(`/api/export?${new URLSearchParams({ name, session: sessionId() })}`, { method: 'POST', body: data })).ok;
  } catch {
    return false;
  }
}
