import type { FeaturePenKey } from '../features/types';
import { LAYER_KEYS, LAYER_LABELS } from '../city/types';
import type { Project } from './project';

/** A physical pen: its ink color and the width of its tip. Sections of the design pick a pen from the palette. */
export interface Pen {
  id: string;
  name: string;
  color: string;
  /** tip width in mm; a line heavier than this is drawn as several passes in the plotter export */
  tipMm: number;
  /** what kind of pen it is (a key of PEN_KINDS); older projects have none and are treated as 'custom' */
  kind?: string;
  /** 0 = opaque ink, 1 = translucent ink that darkens where lines overlap (used when drawing the preview) */
  transparency?: number;
  /** how far the ink spreads past the tip on paper, mm each side: a marker bleeds, a technical pen hardly does */
  gainMm?: number;
}

/** The kinds of pen, with starting estimates (not measurements) for how they behave on paper. */
export interface PenKind { id: string; label: string; tipsMm: number[]; transparency: number; gainMm: number }
export const PEN_KINDS: PenKind[] = [
  { id: 'technical', label: 'Technical pen (Isograph)', tipsMm: [0.1, 0.13, 0.18, 0.25, 0.3, 0.35, 0.5, 0.7, 1.0], transparency: 0.15, gainMm: 0.02 },
  { id: 'fineliner', label: 'Fineliner (Micron)', tipsMm: [0.2, 0.3, 0.4, 0.5, 0.8], transparency: 0.35, gainMm: 0.04 },
  { id: 'gel', label: 'Gel pen', tipsMm: [0.3, 0.5, 0.7, 1.0], transparency: 0.1, gainMm: 0.05 },
  { id: 'marker', label: 'Marker (Molotow)', tipsMm: [0.5, 1.0, 2.0, 3.0], transparency: 0.9, gainMm: 0.25 },
  { id: 'custom', label: 'Custom', tipsMm: [], transparency: 0.5, gainMm: 0.05 },
];
export const penKind = (id: string | undefined): PenKind => PEN_KINDS.find((k) => k.id === id) ?? PEN_KINDS[PEN_KINDS.length - 1]!;

/** The pen taking on a kind (and tip): its transparency and spread follow the kind. The ink color and name stay. */
export function withKind(pen: Pen, kindId: string, tipMm?: number): Pen {
  const k = penKind(kindId);
  const tip = tipMm ?? (k.tipsMm.includes(pen.tipMm) || !k.tipsMm.length ? pen.tipMm : k.tipsMm.reduce((a, b) => (Math.abs(b - pen.tipMm) < Math.abs(a - pen.tipMm) ? b : a)));
  return { ...pen, kind: k.id, tipMm: tip, transparency: k.transparency, gainMm: k.gainMm };
}

/** The width one pass of this pen leaves on paper: the tip plus the spread of the ink on both sides. */
export const inkWidth = (pen: Pen): number => +(pen.tipMm + 2 * (pen.gainMm ?? 0)).toFixed(4);

/** A pen kept under a name ("Micron 0.3"), kept in this browser and put into any project. */
export interface SavedPen { name: string; color: string; kind: string; tipMm: number; transparency: number; gainMm: number }
export const PEN_LIBRARY_KEY = 'city-plot-pen-library';
export const MAX_SAVED_PENS = 50;
const isHex = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
const inRange = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

export function cleanSavedPen(raw: unknown): SavedPen | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === 'string' ? r.name.trim().slice(0, 60) : '';
  if (!name || !isHex(r.color) || !inRange(r.tipMm, 0.05, 20) || !inRange(r.transparency, 0, 1) || !inRange(r.gainMm, 0, 5)) return null;
  return { name, color: r.color.toLowerCase(), kind: penKind(typeof r.kind === 'string' ? r.kind : undefined).id, tipMm: r.tipMm, transparency: r.transparency, gainMm: r.gainMm };
}
export function loadSavedPens(storage?: Pick<Storage, 'getItem'>): SavedPen[] {
  try {
    const st = storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage);
    const parsed: unknown = JSON.parse(st?.getItem(PEN_LIBRARY_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.map(cleanSavedPen).filter((x): x is SavedPen => x !== null).slice(0, MAX_SAVED_PENS) : [];
  } catch { return []; }
}
export function storeSavedPens(list: SavedPen[], storage?: Pick<Storage, 'setItem'>): void {
  try {
    const st = storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage);
    st?.setItem(PEN_LIBRARY_KEY, JSON.stringify(list.slice(0, MAX_SAVED_PENS)));
  } catch { /* storage may be blocked or full */ }
}
/** The list with this pen added; a pen of the same name (any case) is replaced where it stood. */
export function withSavedPen(list: SavedPen[], pen: SavedPen): SavedPen[] {
  const at = list.findIndex((x) => x.name.toLowerCase() === pen.name.toLowerCase());
  return at >= 0 ? list.map((x, i) => (i === at ? pen : x)) : [...list, pen].slice(0, MAX_SAVED_PENS);
}
export const savedFromPen = (name: string, pen: Pen): SavedPen => ({
  name: name.trim().slice(0, 60), color: pen.color.toLowerCase(), kind: penKind(pen.kind).id, tipMm: pen.tipMm,
  transparency: pen.transparency ?? penKind(pen.kind).transparency, gainMm: pen.gainMm ?? penKind(pen.kind).gainMm,
});
/** The pen taking on a saved pen's kind, tip, ink and spread; its id (and so what uses it) stays. */
export const applySavedPen = (pen: Pen, s: SavedPen): Pen => ({ ...pen, name: s.name, color: s.color, kind: s.kind, tipMm: s.tipMm, transparency: s.transparency, gainMm: s.gainMm });

/** Sheet colors offered in the app. */
export const PAPER_COLORS: { name: string; color: string }[] = [
  { name: 'White', color: '#ffffff' },
  { name: 'Warm white', color: '#f6f3ec' },
  { name: 'Cream', color: '#f3ead3' },
  { name: 'Kraft', color: '#b08968' },
  { name: 'Charcoal', color: '#2b2b2b' },
  { name: 'Navy', color: '#16213e' },
  { name: 'Black', color: '#0d0d0d' },
];

const lin = (hex: string, i: number) => { const v = parseInt(hex.replace('#', '').slice(i, i + 2), 16) / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
/** Relative luminance of a #rrggbb color, 0 (black) to 1 (white). */
export const luminance = (hex: string): number => { const y = 0.2126 * lin(hex, 0) + 0.7152 * lin(hex, 2) + 0.0722 * lin(hex, 4); return Number.isFinite(y) ? y : 1; };
/** Contrast ratio between two colors, 1 (none) to 21 (black on white). */
export const contrast = (a: string, b: string): number => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi! + 0.05) / (lo! + 0.05); };
/** True when the sheet is dark enough that light inks are needed. */
export const isDarkPaper = (color: string): boolean => Math.cbrt(luminance(color)) < 0.42;
/** Below this contrast an ink is hard to read on the paper. */
export const MIN_INK_CONTRAST = 2;

export const MAX_PENS = 8;
/** Isograph nib width the default pens start with. */
export const DEFAULT_TIP_MM = 0.3;
export const PEN_BLACK = 'black';
export const PEN_GREEN = 'green';
export const PEN_BLUE = 'blue';

/** Isograph technical pens. No ink spread is assumed, so a 0.3 mm pen's passes are exactly 0.3, 0.54, 0.78 mm: raise Spread to model bleed. */
export const defaultPens = (): Pen[] => [
  { id: PEN_BLACK, name: 'Black', color: '#111111', tipMm: DEFAULT_TIP_MM, kind: 'technical', transparency: 0.15, gainMm: 0 },
  { id: PEN_GREEN, name: 'Green', color: '#1e7a3c', tipMm: DEFAULT_TIP_MM, kind: 'technical', transparency: 0.15, gainMm: 0 },
  { id: PEN_BLUE, name: 'Blue', color: '#1f55b5', tipMm: DEFAULT_TIP_MM, kind: 'technical', transparency: 0.15, gainMm: 0 },
];

/** Colors offered to new pens, in order. */
const NEW_PEN_COLORS = ['#6b4f9e', '#2e7d4f', '#c28a1c', '#a33a6b', '#4a4a4a', '#0f7f8c', '#8a5a2b', '#d1495b'];

/** The pen with this id, or the first pen if it no longer exists. There is always at least one pen. */
export const penFor = (pens: Pen[], id: string | undefined): Pen => pens.find((p) => p.id === id) ?? pens[0]!;

export const FEATURE_PEN_LABELS: Record<FeaturePenKey, string> = {
  attraction: 'Attractions', museum: 'Museums', historic: 'Historic sites', worship: 'Places of worship', station: 'Stations',
  park: 'Park names', university: 'Universities', stadium: 'Stadiums', custom: 'My landmarks', waterLabel: 'Water names',
};

/** The pen a landmark kind (or water name) is drawn with: its override, else the landmarks default. */
export const featurePenId = (f: Project['features'], key: FeaturePenKey): string => f.pens.overrides[key] ?? f.pens.default;

/** Run `fn` on every pen id the project refers to, replacing it with the result. Mutates (use on a draft). */
export function mapPenRefs(p: Project, fn: (id: string) => string): void {
  for (const k of LAYER_KEYS) p.layers[k].pen = fn(p.layers[k].pen);
  p.north.pen = fn(p.north.pen);
  p.text.title.pen = fn(p.text.title.pen);
  p.text.title.fillPen = fn(p.text.title.fillPen);
  p.text.location.pen = fn(p.text.location.pen);
  p.text.info.pen = fn(p.text.info.pen);
  p.watermarkPen = fn(p.watermarkPen);
  p.border.pen = fn(p.border.pen);
  p.route.pen = fn(p.route.pen);
  p.grid.pen = fn(p.grid.pen);
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

/**
 * One part of the design that draws with a pen: its name, and how to read and change its pen. The Pens panel lists
 * these as a table so every pen choice can be seen and changed in one place (each part's own group has it too).
 * `group` is the sidebar group the part lives in. A landmark kind with its own pen (an override) can be set back to
 * the landmarks' pen with `undefined`.
 */
export interface PenSlot {
  key: string;
  section: string;
  group: string;
  get: (p: Project) => string | undefined;
  set: (p: Project, id: string | undefined) => void;
  /** set to `undefined` to use the landmarks' pen; shown as that choice */
  inherits?: boolean;
  /** for a part that can follow another: the pen and the part it follows ("landmarks") */
  base?: (p: Project) => { id: string; label: string };
}

/** The parts of the design that draw with a pen, in sidebar order. Switched-off parts are left out. */
export function penSlots(p: Project): PenSlot[] {
  const out: PenSlot[] = [];
  const add = (key: string, section: string, group: string, get: PenSlot['get'], set: (p: Project, id: string) => void) =>
    out.push({ key, section, group, get, set: (q, id) => { if (id !== undefined) set(q, id); } });
  for (const k of [...LAYER_KEYS].reverse()) if (p.layers[k].enabled) add(`layer-${k}`, LAYER_LABELS[k], 'layers', (q) => q.layers[k].pen, (q, id) => { q.layers[k].pen = id; });
  if (p.features.enabled) {
    add('landmarks', 'Landmarks', 'landmarks', (q) => q.features.pens.default, (q, id) => {
      q.features.pens.default = id;
      // an override that now equals the default is no longer an override
      for (const k of Object.keys(q.features.pens.overrides) as FeaturePenKey[]) if (q.features.pens.overrides[k] === id) delete q.features.pens.overrides[k];
    });
    for (const k of Object.keys(p.features.pens.overrides) as FeaturePenKey[]) {
      if (p.features.pens.overrides[k] === undefined) continue;
      out.push({
        key: `landmarks-${k}`, section: FEATURE_PEN_LABELS[k], group: 'landmarks', inherits: true, base: (q) => ({ id: q.features.pens.default, label: 'landmarks' }),
        get: (q) => q.features.pens.overrides[k],
        set: (q, id) => { if (id === undefined || id === q.features.pens.default) delete q.features.pens.overrides[k]; else q.features.pens.overrides[k] = id; },
      });
    }
  }
  if (p.route.enabled) add('route', 'Memory route', 'route', (q) => q.route.pen, (q, id) => { q.route.pen = id; });
  if (p.grid.enabled) add('grid', 'Grid', 'grid', (q) => q.grid.pen, (q, id) => { q.grid.pen = id; });
  if (p.north.enabled) add('north', 'North arrow', 'north', (q) => q.north.pen, (q, id) => { q.north.pen = id; });
  if (p.text.title.visible) {
    add('title', p.text.title.style === 'fill' ? 'Title' : 'Title outline', 'type', (q) => q.text.title.pen, (q, id) => { q.text.title.pen = id; });
    if (p.text.title.style === 'outlineFill') add('titleFill', 'Title fill', 'type', (q) => q.text.title.fillPen, (q, id) => { q.text.title.fillPen = id; });
  }
  if (p.text.location.visible) add('location', 'Location', 'type', (q) => q.text.location.pen, (q, id) => { q.text.location.pen = id; });
  if (p.text.info.visible) add('info', 'Map info', 'type', (q) => q.text.info.pen, (q, id) => { q.text.info.pen = id; });
  if (p.border.enabled) add('border', 'Border', 'border', (q) => q.border.pen, (q, id) => { q.border.pen = id; });
  if (p.showWatermark) add('watermark', 'Attribution', 'export', (q) => q.watermarkPen, (q, id) => { q.watermarkPen = id; });
  return out;
}

/** Which sections of the design use which pen, for the Pens panel. Switched-off sections are left out. */
export function penUsage(p: Project): PenUse[] {
  return penSlots(p).map((s) => ({ penId: s.get(p) ?? s.base!(p).id, section: s.section }));
}
