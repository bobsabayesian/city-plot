import { create } from 'zustand';
import { defaultProject, type Project } from './scene/project';
import type { TrackPoint } from './gpx/types';
import type { Landmark, OsmData, OsmRequest } from './features/types';
import type { TerrainField } from './topo/terrain';
import { fetchFeatures, geocodeFeature, type GeocodeHit, nearestPeakName, reverseLocation } from './lookup';

interface Store {
  project: Project;
  terrain?: TerrainField;
  terrainStatus: 'idle' | 'loading' | 'error';
  terrainError?: string;
  /** candidates from the last feature search */
  searchResults: GeocodeHit[];
  searchIndex: number;
  osm?: OsmData;
  osmStatus: 'idle' | 'loading' | 'error';
  osmError?: string;
  busy: string;
  notice: string;
  set: (fn: (p: Project) => void) => void;
  setTerrain: (t: TerrainField | undefined, status: Store['terrainStatus'], error?: string) => void;
  loadPoints: (pts: TrackPoint[], lookups?: boolean, waypoints?: Landmark[]) => void;
  loadOsm: (b: import('./geo/project').BBox, req: OsmRequest) => Promise<void>;
  retryOsm: () => void;
  searchFeature: (q: string) => Promise<void>;
  chooseResult: (i: number) => void;
}

let loadId = 0;

export const useStore = create<Store>((setState, get) => ({
  project: defaultProject(),
  terrainStatus: 'idle',
  searchResults: [],
  searchIndex: 0,
  osmStatus: 'idle',
  busy: '',
  notice: '',
  set: (fn) =>
    setState((s) => {
      const project = structuredClone(s.project);
      fn(project);
      return { project };
    }),
  setTerrain: (terrain, terrainStatus, terrainError) => setState({ terrain, terrainStatus, terrainError }),

  loadOsm: async (b, req) => {
    setState({ osmStatus: 'loading', osmError: undefined });
    try {
      setState({ osm: await fetchFeatures(b, req), osmStatus: 'idle' });
    } catch (e) {
      setState({ osm: undefined, osmStatus: 'error', osmError: e instanceof Error ? e.message : 'Landmarks failed' });
    }
  },

  retryOsm: () => setState({ osm: undefined, osmError: undefined }),

  loadPoints: (pts, lookups = true, waypoints = []) => {
    const id = ++loadId;
    get().set((p) => { p.points = pts; p.waypoints = waypoints; p.feature = undefined; p.lookup = {}; p.features.overrides = {}; });
    if (!lookups) return;
    // Fire-and-forget name lookups; the poster is complete without them. Ignore results if the track changed.
    const stale = () => id !== loadId;
    reverseLocation(pts).then((location) => { if (!stale()) get().set((p) => { p.lookup.location = location; }); }).catch(() => {});
    nearestPeakName(pts).then((peakName) => { if (!stale()) get().set((p) => { p.lookup.peakName = peakName; }); }).catch(() => {});
  },

  chooseResult: (i) => {
    const hit = get().searchResults[i];
    if (!hit) return;
    loadId++;
    get().set((p) => {
      p.points = [];
      p.waypoints = [];
      p.features.overrides = {};
      p.feature = { name: hit.name, bbox: hit.bbox, lat: hit.lat, lon: hit.lon, kind: hit.kind };
      p.lookup = { location: hit.location || undefined };
    });
    setState({ searchIndex: i, osm: undefined });
  },

  searchFeature: async (q) => {
    setState({ busy: 'Searching…', notice: '' });
    try {
      const results = await geocodeFeature(q);
      setState({ searchResults: results, busy: '' });
      get().chooseResult(0);
    } catch (e) {
      setState({ busy: '', notice: e instanceof Error ? `Search failed: ${e.message}` : 'Search failed' });
    }
  },
}));
