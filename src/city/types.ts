import type { BBox } from '../geo/project';
import type { HatchDensity } from '../scene/types';
import type { WaterName } from '../features/types';

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

/**
 * Hatching by height: buildings under 15 m are left as outlines, and taller ones hatched more densely, so the tall
 * blocks of a downtown stand out. A building whose height is not known (the Overpass fallback) is hatched lightly.
 */
export function heightDensity(h: number | undefined): HatchDensity | undefined {
  if (h === undefined) return 'light';
  return h < 15 ? undefined : h < 45 ? 'light' : h < 120 ? 'medium' : 'solid';
}

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

/**
 * How wide a layer can be drawn when its "wide" switch is on: as far as the map tiles carry it at full detail (a
 * 1:25,000 field map on a big page is about 13 km tall). The tiles bring every layer at once, so this costs no extra
 * data, only a busier drawing.
 */
export const LAYER_WIDE_MAX_KM: Record<LayerKey, number> = { ...LAYER_MAX_KM, buildings: 13, paths: 10, minor: 24 };

/**
 * The widest view each layer is asked of Overpass for, when the map tiles cannot be reached: the usual limits, wide or
 * not, since Overpass is a shared public server.
 */
export const OVERPASS_MAX_KM: Record<LayerKey, number> = LAYER_MAX_KM;

/** The widest view a layer is drawn at, with its settings. */
export const layerMaxKm = (k: LayerKey, s?: { wide?: boolean }) => (s?.wide ? LAYER_WIDE_MAX_KM[k] : LAYER_MAX_KM[k]);

/** Landmark labels are fetched up to this view width. */
export const LANDMARKS_MAX_KM = 40;

export type StrokeStyle = 'solid' | 'dashed' | 'dotted';

export interface LayerStyle {
  enabled: boolean;
  /** id of the pen it is drawn with */
  pen: string;
  /** requested line thickness, mm; the pen draws it as a whole number of passes (see `passCount`) */
  weightMm: number;
  /** area layers: hatch the inside (plotter) / tint it (print); buildings can be hatched more densely the taller they are */
  fill: 'off' | HatchDensity | 'height';
  style: StrokeStyle;
  /** draw it in wider views than it is usually drawn at (see LAYER_WIDE_MAX_KM); for field maps */
  wide?: boolean;
  /** water only: lines that follow the shore out into the water (see city/waterlines) */
  waterlines?: WaterlineStyle;
}

/** Waterlines, like an engraved chart: `count` lines, the first `gapMm` from the shore, each gap `widen` (0.25 = 25%) wider than the last. */
export interface WaterlineStyle { count: number; gapMm: number; widen: number }
export const DEFAULT_WATERLINES: WaterlineStyle = { count: 0, gapMm: 1.2, widen: 0.25 };

/** One way from OpenStreetMap: a line or a ring, as flat [lat, lon, lat, lon, …]. */
export interface Way {
  id: string;
  name?: string;
  /** what it is, e.g. "river", "motorway"; only set where drawing cares (water) */
  sub?: string;
  closed: boolean;
  pts: number[];
  /** a ring that is only filled, never outlined: the part of an area cut by a map tile's edge (its outline is drawn as open lines) */
  fill?: true;
  /** buildings: how tall, metres (from the map tiles), for hatching by height */
  h?: number;
}

export interface LayerData {
  /** area the way list is complete for */
  covers: BBox;
  ways: Way[];
  /** the server could not return everything (e.g. it hit its size limit) */
  truncated?: boolean;
  /** where it came from: the map tiles (fast) or an Overpass query (the fallback) */
  source?: 'tiles' | 'overpass';
  /** the water layer's lake names, which the tiles give as points */
  waterNames?: WaterName[];
}

/** The area, in degrees, that a request is rounded outward to so nearby views share a cached answer. */
export const SNAP_DEG = 0.005;
