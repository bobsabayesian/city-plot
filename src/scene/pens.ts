import type { FeaturePenKey } from '../features/types';
import type { Project } from './project';

/** A physical pen: its ink color and the width of its tip. Sections of the design pick a pen from the palette. */
export interface Pen {
  id: string;
  name: string;
  color: string;
  /** tip width in mm; a line heavier than this is drawn as several passes in the plotter export */
  tipMm: number;
}

export const MAX_PENS = 8;
export const DEFAULT_TIP_MM = 0.3;
export const PEN_INK = 'ink';
export const PEN_RED = 'red';
export const PEN_BLUE = 'blue';

export const defaultPens = (): Pen[] => [
  { id: PEN_INK, name: 'Ink', color: '#1f2a24', tipMm: DEFAULT_TIP_MM },
  { id: PEN_RED, name: 'Route red', color: '#b4441f', tipMm: DEFAULT_TIP_MM },
  { id: PEN_BLUE, name: 'Water blue', color: '#2f6f9f', tipMm: DEFAULT_TIP_MM },
];

/** Colors offered to new pens, in order. */
const NEW_PEN_COLORS = ['#6b4f9e', '#2e7d4f', '#c28a1c', '#a33a6b', '#4a4a4a', '#0f7f8c', '#8a5a2b', '#d1495b'];

/** The pen with this id, or the first pen if it no longer exists. There is always at least one pen. */
export const penFor = (pens: Pen[], id: string | undefined): Pen => pens.find((p) => p.id === id) ?? pens[0]!;

export const FEATURE_PEN_LABELS: Record<FeaturePenKey, string> = {
  peak: 'Peaks', pass: 'Passes', hut: 'Huts', viewpoint: 'Viewpoints', trailhead: 'Trailheads', waypoint: 'GPX waypoints',
  waterOutline: 'Water outlines', waterLabel: 'Water labels',
};

/** The pen a landmark kind (or water) is drawn with: its override, else the landmarks default. */
export const featurePenId = (f: Project['features'], key: FeaturePenKey): string => f.pens.overrides[key] ?? f.pens.default;

/** Run `fn` on every pen id the project refers to, replacing it with the result. Mutates (use on a draft). */
export function mapPenRefs(p: Project, fn: (id: string) => string): void {
  p.route.pen = fn(p.route.pen);
  p.terrain.pen = fn(p.terrain.pen);
  p.profile.pen = fn(p.profile.pen);
  p.north.pen = fn(p.north.pen);
  p.text.title.pen = fn(p.text.title.pen);
  p.text.title.fillPen = fn(p.text.title.fillPen);
  p.text.location.pen = fn(p.text.location.pen);
  p.text.info.pen = fn(p.text.info.pen);
  p.watermarkPen = fn(p.watermarkPen);
  p.border.pen = fn(p.border.pen);
  p.features.pens.default = fn(p.features.pens.default);
  for (const k of Object.keys(p.features.pens.overrides) as FeaturePenKey[]) {
    const id = p.features.pens.overrides[k];
    if (id !== undefined) p.features.pens.overrides[k] = fn(id);
  }
}

/** Add a pen (up to MAX_PENS). Returns it, or undefined if the palette is full. Mutates (use on a draft). */
export function addPen(p: Project): Pen | undefined {
  if (p.pens.length >= MAX_PENS) return undefined;
  let n = p.pens.length + 1;
  while (p.pens.some((x) => x.id === `pen-${n}`)) n++;
  const pen: Pen = { id: `pen-${n}`, name: `Pen ${p.pens.length + 1}`, color: NEW_PEN_COLORS[(p.pens.length - 3 + NEW_PEN_COLORS.length * 4) % NEW_PEN_COLORS.length]!, tipMm: DEFAULT_TIP_MM };
  p.pens.push(pen);
  return pen;
}

/** Remove a pen; everything that used it moves to the first remaining pen. The last pen cannot be removed. */
export function removePen(p: Project, id: string): boolean {
  if (p.pens.length <= 1 || !p.pens.some((x) => x.id === id)) return false;
  p.pens = p.pens.filter((x) => x.id !== id);
  const fallback = p.pens[0]!.id;
  mapPenRefs(p, (ref) => (ref === id ? fallback : ref));
  // an override that now equals the default is no longer an override
  for (const k of Object.keys(p.features.pens.overrides) as FeaturePenKey[]) {
    if (p.features.pens.overrides[k] === p.features.pens.default) delete p.features.pens.overrides[k];
  }
  return true;
}

export interface PenUse { penId: string; section: string }

/** Which sections of the design use which pen, for the Pens panel. Switched-off sections are left out. */
export function penUsage(p: Project): PenUse[] {
  const use: PenUse[] = [];
  const add = (penId: string, section: string) => use.push({ penId, section });
  if (p.points.length) add(p.route.pen, 'Route');
  if (p.terrain.enabled) add(p.terrain.pen, p.terrain.labels.enabled ? 'Contours and their numbers' : 'Contours');
  if (p.profile.enabled && p.points.length) add(p.profile.pen, 'Elevation profile');
  if (p.north.enabled) add(p.north.pen, 'North arrow');
  if (p.text.title.visible) {
    add(p.text.title.pen, p.text.title.style === 'fill' ? 'Title' : 'Title outline');
    if (p.text.title.style === 'outlineFill') add(p.text.title.fillPen, 'Title fill');
  }
  if (p.text.location.visible) add(p.text.location.pen, 'Location');
  if (p.text.info.visible) add(p.text.info.pen, 'Route info');
  if (p.showWatermark) add(p.watermarkPen, 'Watermark');
  if (p.border.enabled) add(p.border.pen, 'Border');
  if (p.features.enabled) {
    add(p.features.pens.default, 'Landmarks');
    for (const k of Object.keys(p.features.pens.overrides) as FeaturePenKey[]) {
      const id = p.features.pens.overrides[k];
      if (id !== undefined) add(id, FEATURE_PEN_LABELS[k]);
    }
  }
  return use;
}
