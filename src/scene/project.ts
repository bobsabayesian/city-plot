import type { TrackPoint } from '../gpx/types';
import type { BBox } from '../geo/project';
import { defaultFeatures, type FeatureSettings, type Landmark } from '../features/types';
import { defaultPens, PEN_INK, PEN_RED, type Pen } from './pens';
import { defaultBorder, type BorderSettings } from './border';
import type { HatchDensity } from './types';

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
export type StrokeStyle = 'solid' | 'dashed' | 'dotted';
export type FontKey = 'sans' | 'serif';
export type ProfilePosition = 'bottom' | 'corner';

export type Placement = 'top' | 'bottom';
export type InfoKey = 'distance' | 'gain' | 'maxEle' | 'duration' | 'date' | 'contour';
export type NorthStyle = 'arrow' | 'circle' | 'compass' | 'rose';
export type Corner = 'tl' | 'tr' | 'bl' | 'br';

export interface InfoItem {
  key: InfoKey;
  visible: boolean;
  label: string;
  /** user override; undefined = auto value from the GPX */
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

export interface Feature {
  name: string;
  bbox: BBox;
  lat: number;
  lon: number;
  /** what OpenStreetMap calls it, e.g. "volcano" */
  kind?: string;
  /** view width/height in km; undefined = fit the feature's own extent (min ~6 km) */
  spanKm?: number;
}
export interface Lookup { peakName?: string; location?: string }

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
  points: TrackPoint[];
  /** typed-in geographic feature; used for the map view when there is no GPX */
  feature?: Feature;
  /** named <wpt> entries from the GPX */
  waypoints: Landmark[];
  /** names found online for the loaded GPX */
  lookup: Lookup;
  features: FeatureSettings;
  units: 'imperial' | 'metric';
  /** the pen palette every section picks from */
  pens: Pen[];
  route: { pen: string; weightMm: number; style: StrokeStyle };
  terrain: {
    enabled: boolean;
    /** meters; 0 = automatic */
    intervalM: number;
    /** every Nth contour is drawn heavier; 0 = none */
    indexEvery: number;
    weightMm: number;
    indexWeightMm: number;
    opacity: number;
    /** one pen for regular lines, heavy lines and the elevation numbers */
    pen: string;
    /** elevation numbers written along the heavy contour lines */
    labels: {
      enabled: boolean;
      /** how far apart numbers on the same line are */
      density: 'sparse' | 'normal' | 'dense';
      /** label every Nth heavy line (1 = all of them) */
      every: number;
      /** leave a gap in the line behind the number (otherwise it sits just above the line) */
      gap: boolean;
      sizePt: number;
    };
  };
  profile: {
    enabled: boolean;
    position: ProfilePosition;
    /** one pen for the line, fill, ticks and labels */
    pen: string;
    /** how strong the fill is in print and PNG */
    opacity: number;
    /** plotter export: hatch the fill with lines of the pen (off = just the outline) */
    hatch: 'off' | HatchDensity;
    labels: {
      /** label the highest and lowest points */
      extremes: boolean;
      /** horizontal gridlines with elevation values */
      yTicks: boolean;
      /** distance ticks along the bottom */
      xTicks: boolean;
      sizePt: number;
    };
  };
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

export const defaultProject = (): Project => ({
  sizeId: '18x24',
  customSize: { ...DEFAULT_CUSTOM_MM },
  landscape: false,
  paper: '#f6f3ec',
  page: { margins: { top: DEFAULT_MARGIN_MM, right: DEFAULT_MARGIN_MM, bottom: DEFAULT_MARGIN_MM, left: DEFAULT_MARGIN_MM }, linked: true },
  border: defaultBorder(PEN_INK),
  points: [],
  waypoints: [],
  lookup: {},
  features: defaultFeatures(),
  units: 'imperial',
  pens: defaultPens(),
  route: { pen: PEN_RED, weightMm: 0.9, style: 'solid' },
  terrain: {
    enabled: true, intervalM: 0, indexEvery: 5,
    pen: PEN_INK, weightMm: 0.12, indexWeightMm: 0.25, opacity: 0.8,
    labels: { enabled: false, density: 'normal', every: 1, gap: true, sizePt: 8 },
  },
  profile: {
    enabled: true, position: 'bottom', pen: PEN_INK, opacity: 0.12, hatch: 'off',
    labels: { extremes: false, yTicks: false, xTicks: false, sizePt: 9 },
  },
  north: { enabled: false, style: 'arrow', corner: 'tr', sizeMm: 22, pen: PEN_INK, weightMm: 0.35 },
  text: {
    font: 'sans',
    trackingEm: 0.12,
    align: 'left',
    title: { visible: true, sizePt: 60, placement: 'bottom', pen: PEN_INK, align: 'inherit', style: 'fill', outlineMm: 0.35, fillPen: PEN_INK, fillDensity: 'solid' },
    location: { visible: true, sizePt: 18, placement: 'bottom', showCoords: true, pen: PEN_INK },
    info: {
      visible: true, pen: PEN_INK, sizePt: 22, placement: 'bottom', layout: 'row',
      items: [
        { key: 'distance', visible: true, label: 'Distance' },
        { key: 'gain', visible: true, label: 'Elevation gain' },
        { key: 'maxEle', visible: false, label: 'High point' },
        { key: 'duration', visible: false, label: 'Time' },
        { key: 'date', visible: true, label: 'Date' },
        { key: 'contour', visible: false, label: 'Contour interval' },
      ],
    },
  },
  showWatermark: true,
  watermarkPen: PEN_INK,
});

/** Page size in mm for the chosen size and orientation. A custom size is kept within sensible limits. */
export function posterMm(p: Pick<Project, 'sizeId' | 'landscape'> & { customSize?: { wMm: number; hMm: number } }): { w: number; h: number } {
  const clamp = (v: number) => Math.min(CUSTOM_SIZE_MAX_MM, Math.max(CUSTOM_SIZE_MIN_MM, Number.isFinite(v) ? v : CUSTOM_SIZE_MIN_MM));
  const s = p.sizeId === CUSTOM_SIZE_ID
    ? { wMm: clamp((p.customSize ?? DEFAULT_CUSTOM_MM).wMm), hMm: clamp((p.customSize ?? DEFAULT_CUSTOM_MM).hMm) }
    : (PRINT_SIZES.find((x) => x.id === p.sizeId) ?? PRINT_SIZES.find((x) => x.id === '18x24')!);
  return p.landscape ? { w: s.hMm, h: s.wMm } : { w: s.wMm, h: s.hMm };
}
