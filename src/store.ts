import { create } from 'zustand';
import { defaultProject, REGION_MAX_KM, REGION_MIN_KM, type Place, type Project, type Region } from './scene/project';
import { parseLatLon } from './scene/buildScene';
import type { BBox } from './geo/project';
import { covered, padBBox } from './city/draw';
import { LANDMARKS_MAX_KM, LAYER_KEYS, LAYER_MAX_KM, type LayerData, type LayerKey } from './city/types';
import type { Landmark, LandmarkData } from './features/types';
import { fetchLandmarks, fetchLayer, geocode, reverseLocation, type GeocodeHit } from './lookup';

export interface FetchState<T> {
  data?: T;
  status: 'idle' | 'loading' | 'error';
  error?: string;
  /** the area an in-flight request was made for */
  requested?: BBox;
}

/** Landmarks are asked for in full up to this view width; wider than that only ones linked to Wikidata. */
export const NOTABLE_ABOVE_KM = 8;
/** Data is fetched for the view grown by this much on every side, so a small pan needs no new request. */
const PAD = 0.15;

interface Store {
  project: Project;
  /** candidates from the last search */
  searchResults: GeocodeHit[];
  searchIndex: number;
  layers: Partial<Record<LayerKey, FetchState<LayerData>>>;
  landmarks: FetchState<LandmarkData>;
  busy: string;
  notice: string;
  set: (fn: (p: Project) => void) => void;
  setRegion: (r: Partial<Region>) => void;
  searchPlace: (q: string) => Promise<void>;
  choosePlace: (i: number) => void;
  /** Fetch whatever the current view needs that is not already here or on its way. */
  ensureData: (view: BBox, widestKm: number) => void;
  retryData: () => void;
  addCustom: (name: string, where: string, icon: Landmark['icon']) => Promise<boolean>;
}

/** Region a search result starts from: its own extent, kept to a size the layers can draw. */
export function regionFor(hit: Pick<Place, 'lat' | 'lon' | 'bbox'>): Region {
  const b = hit.bbox;
  const km = b ? (b.maxLon - b.minLon) * 111.32 * Math.cos((hit.lat * Math.PI) / 180) : 0;
  return { lat: hit.lat, lon: hit.lon, widthKm: +Math.min(12, Math.max(1.5, km)).toFixed(2) };
}

export const clampKm = (km: number) => Math.min(REGION_MAX_KM, Math.max(REGION_MIN_KM, km));

let placeId = 0;

/**
 * Offer the searched place as one of "my landmarks", switched off: a school or a street corner is not an OSM
 * landmark, but you may still want it marked. The previous search's entry goes if it was never switched on.
 * Mutates (use on a draft).
 */
export function offerPlace(p: Project, place: Place): void {
  p.custom = p.custom.filter((c) => !(c.fromSearch && p.features.overrides[c.id]?.hidden));
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-4;
  if (p.custom.some((c) => c.name === place.name && near(c.lat, place.lat) && near(c.lon, place.lon))) return;
  let n = 1;
  while (p.custom.some((c) => c.id === `custom-${n}`)) n++;
  const id = `custom-${n}`;
  p.custom.push({ id, name: place.name, kind: 'custom', lat: place.lat, lon: place.lon, icon: 'pin', fromSearch: true });
  p.features.overrides[id] = { hidden: true };
}
let customId = 0;

export const useStore = create<Store>((setState, get) => ({
  project: defaultProject(),
  searchResults: [],
  searchIndex: 0,
  layers: {},
  landmarks: { status: 'idle' },
  busy: '',
  notice: '',

  set: (fn) =>
    setState((s) => {
      const project = structuredClone(s.project);
      fn(project);
      return { project };
    }),

  setRegion: (r) => get().set((p) => {
    if (!p.region) return;
    Object.assign(p.region, r);
    p.region.widthKm = clampKm(p.region.widthKm);
    p.region.lat = Math.max(-80, Math.min(80, p.region.lat));
    if (p.region.rotationDeg !== undefined) p.region.rotationDeg = ((((p.region.rotationDeg + 180) % 360) + 360) % 360) - 180;
  }),

  choosePlace: (i) => {
    const hit = get().searchResults[i];
    if (!hit) return;
    ++placeId;
    const place: Place = { name: hit.name, lat: hit.lat, lon: hit.lon, kind: hit.kind, location: hit.location || undefined, bbox: hit.bbox };
    get().set((p) => { p.place = place; p.region = regionFor(place); p.features.overrides = Object.fromEntries(Object.entries(p.features.overrides).filter(([k]) => k.startsWith('custom-'))); offerPlace(p, place); });
    setState({ searchIndex: i, layers: {}, landmarks: { status: 'idle' } });
  },

  searchPlace: async (q) => {
    setState({ busy: 'Searching…', notice: '' });
    try {
      const at = parseLatLon(q);
      if (at) {
        const id = ++placeId;
        const place: Place = { name: `${at.lat.toFixed(4)}, ${at.lon.toFixed(4)}`, lat: at.lat, lon: at.lon, kind: 'coordinates' };
        get().set((p) => { p.place = place; p.region = regionFor(place); p.features.overrides = Object.fromEntries(Object.entries(p.features.overrides).filter(([k]) => k.startsWith('custom-'))); });
        setState({ searchResults: [], layers: {}, landmarks: { status: 'idle' }, busy: '' });
        // the poster still gets a region name, a moment later
        reverseLocation(at.lat, at.lon).then((location) => { if (id === placeId) get().set((p) => { if (p.place) p.place.location = location; }); }).catch(() => {});
        return;
      }
      const results = await geocode(q);
      setState({ searchResults: results, busy: '' });
      get().choosePlace(0);
    } catch (e) {
      setState({ busy: '', notice: e instanceof Error ? `Search failed: ${e.message}` : 'Search failed' });
    }
  },

  ensureData: (view, widestKm) => {
    const s = get();
    const enabled = LAYER_KEYS.filter((k) => s.project.layers[k].enabled && widestKm <= LAYER_MAX_KM[k]);
    for (const key of enabled) {
      const st = s.layers[key];
      if (covered(st?.data?.covers, view)) continue;
      if (st?.status === 'loading' && covered(st.requested, view)) continue;
      if (st?.status === 'error' && covered(st.requested, view)) continue; // the Retry button clears this
      const ask = padBBox(view, PAD);
      const keep = st?.data;
      setState((cur) => ({ layers: { ...cur.layers, [key]: { data: keep, status: 'loading', requested: ask } } }));
      fetchLayer(key, ask).then(
        (data) => setState((cur) => cur.layers[key]?.requested === ask ? { layers: { ...cur.layers, [key]: { data, status: 'idle' } } } : {}),
        (e) => setState((cur) => cur.layers[key]?.requested === ask ? { layers: { ...cur.layers, [key]: { data: keep, status: 'error', error: e instanceof Error ? e.message : 'Failed', requested: ask } } } : {}),
      );
    }

    if (!s.project.features.enabled || widestKm > LANDMARKS_MAX_KM) return;
    const notableOnly = widestKm > NOTABLE_ABOVE_KM;
    const lm = s.landmarks;
    // a full list also answers a request for the notable ones
    const have = (d?: LandmarkData) => !!d && covered(d.covers, view) && (!d.notableOnly || notableOnly);
    if (have(lm.data) || (lm.status !== 'idle' && covered(lm.requested, view))) return;
    const ask = padBBox(view, PAD);
    const keep = lm.data;
    setState({ landmarks: { data: keep, status: 'loading', requested: ask } });
    fetchLandmarks(ask, notableOnly).then(
      (data) => setState((cur) => cur.landmarks.requested === ask ? { landmarks: { data, status: 'idle' } } : {}),
      (e) => setState((cur) => cur.landmarks.requested === ask ? { landmarks: { data: keep, status: 'error', error: e instanceof Error ? e.message : 'Failed', requested: ask } } : {}),
    );
  },

  retryData: () => setState((s) => ({
    layers: Object.fromEntries(Object.entries(s.layers).map(([k, v]) => [k, v?.status === 'error' ? { data: v.data, status: 'idle' as const } : v])),
    landmarks: s.landmarks.status === 'error' ? { data: s.landmarks.data, status: 'idle' } : s.landmarks,
  })),

  addCustom: async (name, where, icon) => {
    setState({ busy: 'Looking up…', notice: '' });
    try {
      const coords = parseLatLon(where);
      const at = coords ?? (await geocode(where))[0];
      if (!at) throw new Error('not found');
      const label = name.trim() || (coords ? 'Landmark' : (at as GeocodeHit).name);
      get().set((p) => {
        let n = ++customId;
        while (p.custom.some((c) => c.id === `custom-${n}`)) n = ++customId;
        p.custom.push({ id: `custom-${n}`, name: label, kind: 'custom', lat: at.lat, lon: at.lon, icon: icon ?? 'pin' });
      });
      setState({ busy: '' });
      return true;
    } catch (e) {
      setState({ busy: '', notice: e instanceof Error ? `Could not find that: ${e.message}` : 'Could not find that' });
      return false;
    }
  },
}));
