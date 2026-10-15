import type { BBox } from '../geo/project';

/** Named places that get a marker and a label. `custom` are the user's own (home, a hotel, …). */
export const LANDMARK_KINDS = ['attraction', 'museum', 'historic', 'worship', 'station', 'park', 'university', 'stadium', 'custom'] as const;
export type LandmarkKind = (typeof LANDMARK_KINDS)[number];
/** What a drawn label can be: a landmark, or a named lake or river. */
export type LabelKind = LandmarkKind | 'lake' | 'river';
/** What a landmark pen can be set for: each landmark kind, and water names (lakes and rivers). */
export type FeaturePenKey = LandmarkKind | 'waterLabel';

export const KIND_LABELS: Record<LabelKind, string> = {
  attraction: 'Attractions', museum: 'Museums', historic: 'Historic sites', worship: 'Places of worship', station: 'Stations',
  park: 'Park names', university: 'Universities', stadium: 'Stadiums', custom: 'My landmarks', lake: 'Lake', river: 'River',
};

/** Kinds fetched from OpenStreetMap (everything but the user's own). */
export const OSM_KINDS = LANDMARK_KINDS.filter((k) => k !== 'custom');

/** Marker drawn for a user's own landmark. */
export const CUSTOM_ICONS = ['pin', 'home', 'star', 'flag'] as const;
export type CustomIcon = (typeof CUSTOM_ICONS)[number];
export const ICON_LABELS: Record<CustomIcon, string> = { pin: 'Pin', home: 'Home', star: 'Star', flag: 'Flag' };

export interface Landmark {
  /** stable id: OSM `n123` / `w123` / `r123`, or `custom-1` */
  id: string;
  name: string;
  kind: LandmarkKind;
  lat: number;
  lon: number;
  /** OpenStreetMap links it to Wikipedia or Wikidata, so people have heard of it */
  notable?: boolean;
  /** user landmarks only */
  icon?: CustomIcon;
  /** user landmarks only: added automatically for a searched place (and still off), so it can be replaced by the next search */
  fromSearch?: boolean;
}

/** A lake or river, for writing its name; lakes are closed rings, [lat, lon] pairs. */
export interface WaterLine {
  id: string;
  kind: 'river' | 'lake';
  name?: string;
  coords: [number, number][];
}

export interface LandmarkData {
  landmarks: Landmark[];
  /** area this list is complete for */
  covers: BBox;
  /** every landmark was asked for, or only the ones OpenStreetMap links to Wikipedia/Wikidata */
  notableOnly: boolean;
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
  /** most landmark labels drawn (hand-hidden ones don't count; the user's own never count) */
  maxLabels: number;
  /** most river and lake names drawn; they compete with each other, not with the landmark labels */
  maxWaterLabels: number;
  kinds: Record<LandmarkKind, boolean>;
  /** write river and lake names */
  waterLabels: boolean;
  sizePt: number;
  /** pens: one default for markers and labels, with per-kind overrides */
  pens: { default: string; overrides: Partial<Record<FeaturePenKey, string>> };
  overrides: Record<string, FeatureOverride>;
}

export const defaultFeatures = (): FeatureSettings => ({
  enabled: true,
  maxLabels: 10,
  maxWaterLabels: 3,
  kinds: { attraction: true, museum: true, historic: true, worship: false, station: true, park: false, university: false, stadium: false, custom: true },
  waterLabels: false,
  sizePt: 11,
  pens: { default: 'black', overrides: { waterLabel: 'blue' } },
  overrides: {},
});

/** The pen key for a drawn label: a landmark kind, or "waterLabel" for lake and river names. */
export const penKeyOf = (kind: LabelKind): FeaturePenKey => (kind === 'lake' || kind === 'river' ? 'waterLabel' : kind);
