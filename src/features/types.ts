import type { BBox } from '../geo/project';

/** Point features the user can switch on and off one by one. */
export const LANDMARK_KINDS = ['peak', 'pass', 'hut', 'viewpoint', 'trailhead', 'waypoint'] as const;
export type LandmarkKind = (typeof LANDMARK_KINDS)[number];
/** What a drawn label can be: a point feature, or a named lake or river. */
export type LabelKind = LandmarkKind | 'lake' | 'river';
/** What a landmark pen can be set for: each point kind, water outlines, and water names (lakes and rivers). */
export type FeaturePenKey = LandmarkKind | 'waterOutline' | 'waterLabel';

export const KIND_LABELS: Record<LabelKind, string> = {
  peak: 'Peaks', pass: 'Passes', hut: 'Huts', viewpoint: 'Viewpoints',
  trailhead: 'Trailheads', waypoint: 'GPX waypoints', lake: 'Lake', river: 'River',
};

export interface Landmark {
  /** stable id: OSM `n123` (node), or `wpt-0` for GPX waypoints */
  id: string;
  name: string;
  kind: LandmarkKind;
  lat: number;
  lon: number;
  /** meters */
  ele?: number;
}

export interface WaterLine {
  /** OSM `w123` */
  id: string;
  kind: 'river' | 'lake';
  name?: string;
  /** [lat, lon] pairs; lakes are closed rings */
  coords: [number, number][];
}

/** What was asked of the server, so the client knows when a changed setting needs a new fetch. */
export interface OsmRequest {
  /** point kinds: peak, pass, hut, viewpoint, trailhead */
  kinds: LandmarkKind[];
  /** lake outlines (needed for outlines or lake labels) */
  lakes: boolean;
  rivers: boolean;
}

export interface OsmData {
  landmarks: Landmark[];
  water: WaterLine[];
  /** area this data was fetched for */
  covers: BBox;
  requested?: OsmRequest;
  /** parts the server could not fetch this time */
  partial?: ('landmarks' | 'water')[];
  /** why the server could not fetch the missing parts (which Overpass servers said what) */
  reason?: string;
}

export type Side = 'auto' | 'right' | 'left' | 'above' | 'below';

export interface FeatureOverride {
  name?: string;
  /** the user removed this label; its slot stays open instead of being refilled */
  hidden?: boolean;
  /** the user chose this one from the list, even if its kind is switched off */
  pinned?: boolean;
  side?: Side;
}

export interface FeatureSettings {
  enabled: boolean;
  /** most point labels drawn (hand-hidden ones don't count) */
  maxLabels: number;
  /** most river and lake names drawn; they compete with each other, not with the point labels */
  maxWaterLabels: number;
  kinds: Record<LandmarkKind, boolean>;
  /** draw rivers and lake outlines */
  water: boolean;
  /** write river and lake names */
  waterLabels: boolean;
  sizePt: number;
  /** pens: one default for markers and labels, with per-kind overrides (water defaults to blue) */
  pens: { default: string; overrides: Partial<Record<FeaturePenKey, string>> };
  waterWeightMm: number;
  overrides: Record<string, FeatureOverride>;
}

export const POINT_KINDS: LandmarkKind[] = ['peak', 'pass', 'hut', 'viewpoint', 'trailhead'];

/**
 * The server request implied by the current settings. Every point kind is always fetched, even the ones
 * switched off, because the "add landmark" list offers them; point queries are cheap. Water is the costly
 * part, so it is only fetched when outlines or names are on.
 */
export function wantedRequest(s: FeatureSettings): OsmRequest {
  return {
    kinds: [...POINT_KINDS],
    lakes: s.water || s.waterLabels,
    rivers: s.water || s.waterLabels,
  };
}

export const requestIsEmpty = (r: OsmRequest) => !r.kinds.length && !r.lakes && !r.rivers;

/** True if data fetched with `have` already contains everything `want` needs. */
export const requestCovers = (have: OsmRequest | undefined, want: OsmRequest) =>
  !!have && want.kinds.every((k) => have.kinds.includes(k)) && (!want.lakes || have.lakes) && (!want.rivers || have.rivers);

export const defaultFeatures = (): FeatureSettings => ({
  enabled: true,
  maxLabels: 8,
  maxWaterLabels: 4,
  // Peaks, trailheads and water lines are on by default; everything else is opt-in.
  kinds: { peak: true, pass: false, hut: false, viewpoint: false, trailhead: true, waypoint: false },
  water: true,
  waterLabels: false,
  sizePt: 11,
  pens: { default: 'ink', overrides: { waterOutline: 'blue', waterLabel: 'blue' } },
  waterWeightMm: 0.2,
  overrides: {},
});

/** The pen key for a drawn label: a point kind, or "waterLabel" for lake and river names. */
export const penKeyOf = (kind: LabelKind): FeaturePenKey => (kind === 'lake' || kind === 'river' ? 'waterLabel' : kind);
