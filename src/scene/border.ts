import type { Margins } from './project';
import type { PathPrim } from './types';

export type BorderStyle = 'single' | 'double';

export interface BorderSettings {
  enabled: boolean;
  style: BorderStyle;
  /** paper edge to the outer line, mm */
  offsetMm: number;
  /** between the two lines of a double border, mm */
  gapMm: number;
  weightMm: number;
  pen: string;
}

export const defaultBorder = (pen: string): BorderSettings => ({ enabled: false, style: 'single', offsetMm: 12, gapMm: 2.5, weightMm: 0.5, pen });

/** Space kept clear between the border and the content, mm. */
export const BORDER_CLEARANCE_MM = 1;

export interface BorderLayout {
  /** the lines to draw, outermost first */
  rects: { x: number; y: number; w: number; h: number }[];
  /** the offset and gap actually used, which may be less than asked for */
  offsetMm: number;
  gapMm: number;
  /** true if the border had to be pulled in so it fits inside the margin */
  clamped: boolean;
}

/**
 * Where the border lines go. The border sits inside the margin, so the outer line is `offsetMm` from the paper
 * edge and (for a double border) the inner line `gapMm` further in. If that would reach the content, the offset
 * and then the gap are reduced until everything fits inside the smallest margin.
 */
export function layoutBorder(W: number, H: number, b: BorderSettings, margins: Margins): BorderLayout {
  const half = Math.max(0, b.weightMm) / 2;
  const double = b.style === 'double';
  const room = Math.max(half * 2, Math.min(margins.top, margins.right, margins.bottom, margins.left) - BORDER_CLEARANCE_MM);
  let offsetMm = Math.max(half, b.offsetMm);
  let gapMm = double ? Math.max(0, b.gapMm) : 0;
  const reach = () => offsetMm + gapMm + half;
  if (reach() > room) offsetMm = Math.max(half, room - gapMm - half);
  if (reach() > room) gapMm = Math.max(double ? b.weightMm : 0, room - offsetMm - half);
  const clamped = Math.abs(offsetMm - b.offsetMm) > 1e-9 || (double && Math.abs(gapMm - b.gapMm) > 1e-9);
  const rect = (inset: number) => ({ x: inset, y: inset, w: W - 2 * inset, h: H - 2 * inset });
  return { rects: double ? [rect(offsetMm), rect(offsetMm + gapMm)] : [rect(offsetMm)], offsetMm, gapMm, clamped };
}

const f = (n: number) => +n.toFixed(3);

/** The border as closed stroked rectangles, in the pen's color. */
export function borderPrims(W: number, H: number, b: BorderSettings, margins: Margins, color: string): PathPrim[] {
  if (!b.enabled) return [];
  return layoutBorder(W, H, b, margins).rects.map((r) => ({
    kind: 'path',
    d: `M${f(r.x)} ${f(r.y)}H${f(r.x + r.w)}V${f(r.y + r.h)}H${f(r.x)}Z`,
    color, pen: b.pen, mode: 'stroke', widthMm: b.weightMm,
  }));
}
