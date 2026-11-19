import { DEFAULT_WATERLINES, type LayerKey, type LayerStyle } from '../city/types';
import { defaultBorder } from './border';
import { defaultPens, withKind, type Pen } from './pens';
import { coasterPreset, defaultLayers, sizeShape, type FontKey, type NorthStyle, type Project, type TitleStyle } from './project';
import type { HatchDensity } from './types';

/**
 * Looks: a whole style in one click (paper, pens, how each layer is drawn, the type, border and north arrow), as a
 * starting point to adjust from. A look leaves the place, the map area, the page size and margins, the text and the
 * landmarks alone; on a coaster the coaster's own limits are applied again afterwards.
 */
export interface Look {
  id: string;
  name: string;
  /** one line on what it is like */
  blurb: string;
  paper: string;
  pens: Pen[];
  /** the pen most of the design is drawn with: text, border, north arrow, landmarks */
  ink: string;
  /** changes to the default layers */
  layers: Partial<Record<LayerKey, Partial<LayerStyle>>>;
  font: FontKey;
  trackingEm: number;
  title: { style: TitleStyle; fillPen?: string; fillDensity?: HatchDensity };
  border: false | { style: 'single' | 'double'; weightMm: number };
  north: false | NorthStyle;
  /** pen for lake and river names, when not the ink */
  waterLabel?: string;
  /** how unsteady the hand is, 0 (a machine line) to 1; default 0 */
  hand?: number;
  /** draw the kilometre grid, numbered in the margin */
  grid?: boolean;
}

const pen = (id: string, name: string, color: string, kind: string, tipMm: number): Pen => withKind({ id, name, color, tipMm }, kind, tipMm);
const off: Partial<LayerStyle> = { enabled: false };

export const LOOKS: Look[] = [
  {
    id: 'classic', name: 'Classic', blurb: 'Black streets, green parks, blue water on warm white. The default.',
    paper: '#f6f3ec', pens: defaultPens(), ink: 'black', layers: {},
    font: 'sans', trackingEm: 0.12, title: { style: 'fill' }, border: false, north: false, waterLabel: 'blue',
  },
  {
    id: 'engraved', name: 'Engraved chart', blurb: 'Sepia on cream, waterlines out from every shore, a compass rose and serif type.',
    paper: '#f3ead3',
    pens: [pen('ink', 'Sepia', '#3a2a1a', 'technical', 0.25), pen('sea', 'Slate blue', '#3b5a74', 'technical', 0.18)],
    ink: 'ink',
    layers: {
      water: { pen: 'sea', weightMm: 0.25, fill: 'off', waterlines: { count: 12, gapMm: 0.7, widen: 0.18 } },
      parks: { pen: 'ink', fill: 'light', style: 'dotted' },
      buildings: { pen: 'ink', weightMm: 0.25, fill: 'medium' },
      minor: { pen: 'ink', weightMm: 0.25 },
      secondary: { pen: 'ink', weightMm: 0.45 },
      major: { pen: 'ink', weightMm: 0.65 },
      rail: { enabled: true, pen: 'ink', style: 'dashed' },
    },
    font: 'serif', trackingEm: 0.2, title: { style: 'outlineFill', fillPen: 'ink', fillDensity: 'light' },
    border: { style: 'double', weightMm: 0.35 }, north: 'rose', waterLabel: 'sea',
  },
  {
    id: 'blueprint', name: 'Blueprint', blurb: 'White and pale blue gel pens on navy, outlines only, wide-spaced capitals.',
    paper: '#16213e',
    pens: [pen('chalk', 'White gel', '#f4f1ea', 'gel', 0.5), pen('ice', 'Pale blue gel', '#9cc3ff', 'gel', 0.5)],
    ink: 'chalk',
    layers: {
      water: { pen: 'ice', fill: 'off', waterlines: { count: 6, gapMm: 1.6, widen: 0.3 } },
      parks: { pen: 'ice', fill: 'off', style: 'dashed' },
      buildings: { pen: 'chalk', weightMm: 0.5 },
      minor: { pen: 'chalk', weightMm: 0.5 },
      secondary: { pen: 'chalk', weightMm: 0.5 },
      major: { pen: 'chalk', weightMm: 0.9 },
      rail: { enabled: true, pen: 'ice', style: 'dashed' },
    },
    font: 'sans', trackingEm: 0.3, title: { style: 'outline' },
    border: { style: 'single', weightMm: 0.5 }, north: 'compass', waterLabel: 'ice',
  },
  {
    id: 'nolli', name: 'Nolli', blurb: 'Buildings filled solid, streets left as white paper: the city as figure and ground.',
    paper: '#ffffff',
    pens: [pen('ink', 'Black', '#111111', 'technical', 0.3), pen('grey', 'Grey', '#7a7a7a', 'fineliner', 0.3)],
    ink: 'ink',
    layers: {
      buildings: { pen: 'ink', fill: 'solid' },
      water: { pen: 'grey', fill: 'medium' },
      parks: { pen: 'grey', fill: 'off', style: 'dotted' },
      minor: off, secondary: off, major: off, paths: off, rail: off,
    },
    font: 'serif', trackingEm: 0.08, title: { style: 'fill' },
    border: { style: 'single', weightMm: 0.3 }, north: 'arrow', waterLabel: 'grey',
  },
  {
    id: 'minimal', name: 'Minimal', blurb: 'Only the streets, one black pen, three weights. Lets the street plan speak.',
    paper: '#ffffff',
    pens: [pen('ink', 'Black', '#111111', 'technical', 0.3)],
    ink: 'ink',
    layers: {
      buildings: off, parks: off, paths: off, rail: off,
      water: { pen: 'ink', fill: 'off' },
      minor: { pen: 'ink', weightMm: 0.3 },
      secondary: { pen: 'ink', weightMm: 0.54 },
      major: { pen: 'ink', weightMm: 1.02 },
    },
    font: 'sans', trackingEm: 0.4, title: { style: 'fill' }, border: false, north: false,
  },
  {
    id: 'military', name: 'Military', blurb: 'A field map: kilometre grid numbered in the margin, black buildings, red roads. Best at 1:25,000 or 1:50,000.',
    paper: '#f6f4ec',
    pens: [
      pen('ink', 'Black', '#161616', 'technical', 0.25), pen('road', 'Red-brown', '#b03a2e', 'technical', 0.3),
      pen('water', 'Blue', '#1f5fa8', 'technical', 0.25), pen('wood', 'Green', '#3f7d3a', 'technical', 0.25),
    ],
    ink: 'ink',
    layers: {
      // a field map keeps its buildings and side streets at 1:25,000 and 1:50,000
      buildings: { pen: 'ink', weightMm: 0.25, fill: 'solid', wide: true },
      major: { pen: 'road', weightMm: 0.78 },
      secondary: { pen: 'road', weightMm: 0.54 },
      minor: { pen: 'ink', weightMm: 0.25, wide: true },
      rail: { enabled: true, pen: 'ink', weightMm: 0.54, style: 'solid' },
      water: { pen: 'water', weightMm: 0.25, fill: 'light' },
      parks: { pen: 'wood', weightMm: 0.25, fill: 'medium', style: 'solid' },
    },
    font: 'sans', trackingEm: 0.06, title: { style: 'fill' },
    border: { style: 'single', weightMm: 0.5 }, north: false, waterLabel: 'water', grid: true,
  },
  {
    id: 'kraft', name: 'Kraft', blurb: 'Black fineliner and white gel on brown kraft paper, like a hand-drawn shop map.',
    paper: '#b08968',
    pens: [pen('ink', 'Black fineliner', '#1a1410', 'fineliner', 0.4), pen('chalk', 'White gel', '#f7f3e8', 'gel', 0.5)],
    ink: 'ink',
    layers: {
      water: { pen: 'chalk', fill: 'off', waterlines: { count: 5, gapMm: 1.4, widen: 0.35 } },
      parks: { pen: 'chalk', fill: 'off', style: 'dotted' },
      buildings: { pen: 'ink', weightMm: 0.4 },
      minor: { pen: 'ink', weightMm: 0.4 },
      secondary: { pen: 'ink', weightMm: 0.4 },
      major: { pen: 'ink', weightMm: 0.72 },
    },
    font: 'serif', trackingEm: 0.15, title: { style: 'outlineFill', fillPen: 'chalk', fillDensity: 'solid' },
    border: { style: 'double', weightMm: 0.4 }, north: 'circle', waterLabel: 'chalk', hand: 0.5,
  },
];

export const lookById = (id: string): Look | undefined => LOOKS.find((l) => l.id === id);

/** Restyle the project as this look. Mutates (use on a draft). */
export function applyLook(p: Project, look: Look): void {
  p.paper = look.paper;
  p.pens = structuredClone(look.pens);
  const layers = defaultLayers();
  for (const k of Object.keys(layers) as LayerKey[]) {
    // a layer keeps its default pen if the look has it, else takes the look's ink: none is left pointing at a missing pen
    const pen = look.pens.some((x) => x.id === layers[k].pen) ? layers[k].pen : look.ink;
    layers[k] = { ...layers[k], pen, ...look.layers[k] };
    if (k === 'water') layers.water.waterlines = { ...DEFAULT_WATERLINES, ...look.layers.water?.waterlines };
  }
  p.layers = layers;

  p.text.font = look.font;
  p.text.trackingEm = look.trackingEm;
  p.text.title.style = look.title.style;
  p.text.title.pen = look.ink;
  p.text.title.fillPen = look.title.fillPen ?? look.ink;
  p.text.title.fillDensity = look.title.fillDensity ?? 'solid';
  p.text.location.pen = look.ink;
  p.text.info.pen = look.ink;
  p.watermarkPen = look.ink;
  p.route.pen = look.ink;

  const border = defaultBorder(look.ink);
  p.border = look.border ? { ...border, enabled: true, style: look.border.style, weightMm: look.border.weightMm } : border;
  p.north = { ...p.north, enabled: !!look.north, style: look.north || p.north.style, pen: look.ink };

  p.features.pens = { default: look.ink, overrides: look.waterLabel ? { waterLabel: look.waterLabel } : {} };
  p.hand = { ...p.hand, amount: look.hand ?? 0 };
  p.grid = { ...p.grid, enabled: !!look.grid, pen: look.ink };

  // a coaster keeps its own limits (no title, no buildings, lighter lines) whatever the look
  if (sizeShape(p)) coasterPreset(p);
}
