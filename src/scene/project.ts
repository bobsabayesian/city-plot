import type { BBox } from '../geo/project';
import { defaultFeatures, type FeatureSettings, type Landmark } from '../features/types';
import { LAYER_KEYS, type LayerKey, type LayerStyle, type StrokeStyle } from '../city/types';
import { defaultPens, PEN_BLACK, PEN_BLUE, PEN_GREEN, type Pen } from './pens';
import { defaultBorder, type BorderSettings } from './border';
import type { HatchDensity } from './types';

export type { StrokeStyle };

export type SizeGroup = 'US (inches)' | 'ISO (A series)' | 'Metric (cm)';

export interface PrintSize {
  id: string;
  label: string;
  group: SizeGroup;
  /** portrait size in mm (exact for ISO and metric; inches converted for US sizes) */
  wMm: number;
  hMm: number;
}

const inch = (w: number, h: number): PrintSize => ({ id: `${w}x${h}`, label: `${w} × ${h} in`, group: 'US (inches)', wMm: +(w * 25.4).toFixed(3), hMm: +(h * 25.4).toFixed(3) });
const iso = (n: number, w: number, h: number): PrintSize => ({ id: `a${n}`, label: `A${n} (${w} × ${h} mm)`, group: 'ISO (A series)', wMm: w, hMm: h });
const cm = (w: number, h: number): PrintSize => ({ id: `cm${w}x${h}`, label: `${w} × ${h} cm`, group: 'Metric (cm)', wMm: w * 10, hMm: h * 10 });

export const PRINT_SIZES: PrintSize[] = [
  inch(5, 7), inch(8, 10), inch(11, 14), inch(11, 17), inch(12, 16), inch(12, 18), inch(16, 20), inch(16, 24),
  inch(18, 24), inch(20, 24), inch(20, 30), inch(24, 30), inch(24, 36), inch(27, 40), inch(30, 40), inch(36, 48),
  iso(5, 148, 210), iso(4, 210, 297), iso(3, 297, 420), iso(2, 420, 594), iso(1, 594, 841), iso(0, 841, 1189),
  cm(21, 30), cm(30, 40), cm(40, 50), cm(50, 70), cm(60, 90), cm(70, 100),
];

/** Id for a size the user types in. */
export const CUSTOM_SIZE_ID = 'custom';
/** Limits for a custom size, mm: from a small print to a large format roll. */
export const CUSTOM_SIZE_MIN_MM = 50;
export const CUSTOM_SIZE_MAX_MM = 3000;
export const DEFAULT_CUSTOM_MM = { wMm: 457.2, hMm: 609.6 };

export type Align = 'left' | 'center' | 'right';
export type FontKey = 'sans' | 'serif';

export type Placement = 'top' | 'bottom';
export type InfoKey = 'scale' | 'extent';
export type NorthStyle = 'arrow' | 'circle' | 'compass' | 'rose';
export type Corner = 'tl' | 'tr' | 'bl' | 'br';

export interface InfoItem {
  key: InfoKey;
  visible: boolean;
  label: string;
  /** user override; undefined = auto value from the map (scale, area) */
  value?: string;
}

export interface TitleBlock { visible: boolean; value?: string; sizePt: number; placement: Placement; pen: string }
export interface LocationBlock extends TitleBlock { showCoords: boolean }
export type TitleAlign = 'inherit' | 'left' | 'center' | 'right' | 'justify';
export type TitleStyle = 'fill' | 'outline' | 'outlineFill';
export interface TitleSettings extends TitleBlock {
  /** 'inherit' follows the text alignment; 'justify' stretches the title across the content width */
  align: TitleAlign;
  style: TitleStyle;
  /** line weight of the letter outline (outline and outlineFill) */
  outlineMm: number;
  /** pen for the inside of the letters (outlineFill); `pen` draws the outline */
  fillPen: string;
  /** how densely the inside is hatched in the plotter export */
  fillDensity: HatchDensity;
}
export interface InfoBlock {
  visible: boolean;
  pen: string;
  sizePt: number;
  placement: Placement;
  layout: 'row' | 'column';
  items: InfoItem[];
}

/** A city, landmark or address the user searched for (or typed coordinates for). */
export interface Place {
  name: string;
  lat: number;
  lon: number;
  /** what OpenStreetMap calls it, e.g. "city" */
  kind?: string;
  /** region name, e.g. "King County, Washington" */
  location?: string;
  /** the place's own extent, which the region starts from */
  bbox?: BBox;
}

/** The ground the map shows: its center and its width. The height follows from the page shape. */
export interface Region {
  lat: number;
  lon: number;
  widthKm: number;
  /** degrees the map is turned clockwise from north-up (-180 to 180); the north arrow follows */
  rotationDeg?: number;
}

/** Narrowest and widest region the controls offer. */
export const REGION_MIN_KM = 0.25;
export const REGION_MAX_KM = 80;

/** Distances from the paper edge to the content area, in mm. */
export interface Margins { top: number; right: number; bottom: number; left: number }
export interface PageSettings {
  margins: Margins;
  /** edit all four sides together */
  linked: boolean;
}

/** 1.25 in: about what the earlier layout used on an 18x24 poster, now fixed instead of scaling with the page. */
export const DEFAULT_MARGIN_MM = 31.75;
/** The content area keeps at least this share of the page in each direction. */
export const MIN_CONTENT_SHARE = 0.2;

/** Margins that are safe to lay out with: not negative, and leaving at least 20% of the page for content. */
export function clampMargins(m: Margins, widthMm: number, heightMm: number): Margins {
  const pos = (v: number) => (Number.isFinite(v) && v > 0 ? v : 0);
  let { top, right, bottom, left } = { top: pos(m.top), right: pos(m.right), bottom: pos(m.bottom), left: pos(m.left) };
  const maxH = widthMm * (1 - MIN_CONTENT_SHARE);
  const maxV = heightMm * (1 - MIN_CONTENT_SHARE);
  if (left + right > maxH) { const k = maxH / (left + right); left *= k; right *= k; }
  if (top + bottom > maxV) { const k = maxV / (top + bottom); top *= k; bottom *= k; }
  return { top, right, bottom, left };
}

export interface Project {
  sizeId: string;
  /** used when sizeId is 'custom'; portrait, mm */
  customSize: { wMm: number; hMm: number };
  landscape: boolean;
  paper: string;
  page: PageSettings;
  /** a single or double frame inside the page margin */
  border: BorderSettings;
  /** what was searched for; names the poster */
  place?: Place;
  /** the area shown; undefined until a place has been chosen */
  region?: Region;
  /** the user's own landmarks ("home", a hotel, …) */
  custom: Landmark[];
  features: FeatureSettings;
  units: 'imperial' | 'metric';
  /** the pen palette every part of the design picks from */
  pens: Pen[];
  /** how each map layer is drawn */
  layers: Record<LayerKey, LayerStyle>;
  north: {
    enabled: boolean;
    style: NorthStyle;
    corner: Corner;
    sizeMm: number;
    pen: string;
    weightMm: number;
  };
  text: {
    font: FontKey;
    trackingEm: number;
    align: Align;
    title: TitleSettings;
    location: LocationBlock;
    info: InfoBlock;
  };
  showWatermark: boolean;
  watermarkPen: string;
}

/**
 * Line thicknesses are multiples of the default 0.3 mm pen: 1, 2, 3 and 4 passes at a 20% overlap are
 * 0.3, 0.54, 0.78 and 1.02 mm.
 */
export const defaultLayers = (): Record<LayerKey, LayerStyle> => ({
  parks: { enabled: true, pen: PEN_GREEN, weightMm: 0.3, fill: 'light', style: 'solid' },
  water: { enabled: true, pen: PEN_BLUE, weightMm: 0.3, fill: 'light', style: 'solid' },
  buildings: { enabled: true, pen: PEN_BLACK, weightMm: 0.3, fill: 'off', style: 'solid' },
  paths: { enabled: false, pen: PEN_BLACK, weightMm: 0.3, fill: 'off', style: 'dashed' },
  minor: { enabled: true, pen: PEN_BLACK, weightMm: 0.3, fill: 'off', style: 'solid' },
  secondary: { enabled: true, pen: PEN_BLACK, weightMm: 0.54, fill: 'off', style: 'solid' },
  major: { enabled: true, pen: PEN_BLACK, weightMm: 0.78, fill: 'off', style: 'solid' },
  rail: { enabled: false, pen: PEN_BLACK, weightMm: 0.3, fill: 'off', style: 'dashed' },
});

export const defaultProject = (): Project => ({
  sizeId: '18x24',
  customSize: { ...DEFAULT_CUSTOM_MM },
  landscape: false,
  paper: '#f6f3ec',
  page: { margins: { top: DEFAULT_MARGIN_MM, right: DEFAULT_MARGIN_MM, bottom: DEFAULT_MARGIN_MM, left: DEFAULT_MARGIN_MM }, linked: true },
  border: defaultBorder(PEN_BLACK),
  custom: [],
  features: defaultFeatures(),
  units: 'imperial',
  pens: defaultPens(),
  layers: defaultLayers(),
  north: { enabled: false, style: 'arrow', corner: 'tr', sizeMm: 22, pen: PEN_BLACK, weightMm: 0.35 },
  text: {
    font: 'sans',
    trackingEm: 0.12,
    align: 'left',
    title: { visible: true, sizePt: 60, placement: 'bottom', pen: PEN_BLACK, align: 'inherit', style: 'fill', outlineMm: 0.35, fillPen: PEN_BLACK, fillDensity: 'solid' },
    location: { visible: true, sizePt: 18, placement: 'bottom', showCoords: true, pen: PEN_BLACK },
    info: {
      visible: true, pen: PEN_BLACK, sizePt: 22, placement: 'bottom', layout: 'row',
      items: [
        { key: 'extent', visible: true, label: 'Area' },
        { key: 'scale', visible: true, label: 'Scale' },
      ],
    },
  },
  showWatermark: true,
  watermarkPen: PEN_BLACK,
});

/** Page size in mm for the chosen size and orientation. A custom size is kept within sensible limits. */
export function posterMm(p: Pick<Project, 'sizeId' | 'landscape'> & { customSize?: { wMm: number; hMm: number } }): { w: number; h: number } {
  const clamp = (v: number) => Math.min(CUSTOM_SIZE_MAX_MM, Math.max(CUSTOM_SIZE_MIN_MM, Number.isFinite(v) ? v : CUSTOM_SIZE_MIN_MM));
  const s = p.sizeId === CUSTOM_SIZE_ID
    ? { wMm: clamp((p.customSize ?? DEFAULT_CUSTOM_MM).wMm), hMm: clamp((p.customSize ?? DEFAULT_CUSTOM_MM).hMm) }
    : (PRINT_SIZES.find((x) => x.id === p.sizeId) ?? PRINT_SIZES.find((x) => x.id === '18x24')!);
  return p.landscape ? { w: s.hMm, h: s.wMm } : { w: s.wMm, h: s.hMm };
}
