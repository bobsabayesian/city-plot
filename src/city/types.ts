import type { BBox } from '../geo/project';
import type { HatchDensity } from '../scene/types';

/** The map layers, bottom of the drawing first. */
export const LAYER_KEYS = ['parks', 'water', 'buildings', 'paths', 'minor', 'secondary', 'major', 'rail'] as const;
export type LayerKey = (typeof LAYER_KEYS)[number];

export const LAYER_LABELS: Record<LayerKey, string> = {
  parks: 'Parks and green space',
  water: 'Water',
  buildings: 'Buildings',
  paths: 'Footpaths and trails',
  minor: 'Minor streets',
  secondary: 'Secondary streets',
  major: 'Major roads',
  rail: 'Railways',
};

/** Layers made of areas, which can be filled (with hatching, for a plotter). The rest are lines only. */
export const AREA_LAYERS: readonly LayerKey[] = ['parks', 'water', 'buildings'];
export const isAreaLayer = (k: LayerKey) => AREA_LAYERS.includes(k);

/**
 * The widest view (km, either direction) each layer is fetched and drawn at. Past this the answer is too big
 * for the public map servers, and the lines would be too dense to read on paper anyway.
 */
export const LAYER_MAX_KM: Record<LayerKey, number> = {
  buildings: 4, paths: 6, minor: 12, secondary: 30, major: 80, rail: 40, water: 80, parks: 40,
};

/** Landmark labels are fetched up to this view width. */
export const LANDMARKS_MAX_KM = 40;

export type StrokeStyle = 'solid' | 'dashed' | 'dotted';

export interface LayerStyle {
  enabled: boolean;
  /** id of the pen it is drawn with */
  pen: string;
  /** requested line thickness, mm; the pen draws it as a whole number of passes (see `passCount`) */
  weightMm: number;
  /** area layers: hatch the inside (plotter) / tint it (print) */
  fill: 'off' | HatchDensity;
  style: StrokeStyle;
}

/** One way from OpenStreetMap: a line or a ring, as flat [lat, lon, lat, lon, …]. */
export interface Way {
  id: string;
  name?: string;
  /** what it is, e.g. "river", "motorway"; only set where drawing cares (water) */
  sub?: string;
  closed: boolean;
  pts: number[];
}

export interface LayerData {
  /** area the way list is complete for */
  covers: BBox;
  ways: Way[];
  /** the server could not return everything (e.g. it hit its size limit) */
  truncated?: boolean;
}

/** The area, in degrees, that a request is rounded outward to so nearby views share a cached answer. */
export const SNAP_DEG = 0.005;
