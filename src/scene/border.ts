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

export interface BorderLayout {
  /** the lines to draw, outermost first */
  rects: { x: number; y: number; w: number; h: number }[];
}

/** How far the border reaches in from the paper edge: out to the outer edge of its innermost line. 0 when it is off. */
export function borderExtent(b: BorderSettings): number {
  if (!b.enabled) return 0;
  return Math.max(0, b.offsetMm) + (b.style === 'double' ? Math.max(0, b.gapMm) : 0) + Math.max(0, b.weightMm) / 2;
}

/**
 * Where the border lines go: the outer line is `offsetMm` (the border margin) from the paper edge and, for a
 * double border, the inner line `gapMm` further in. The page margin is measured from the inside of the border.
 */
export function layoutBorder(W: number, H: number, b: BorderSettings): BorderLayout {
  const half = Math.max(0, b.weightMm) / 2;
  const offsetMm = Math.max(half, b.offsetMm);
  const gapMm = b.style === 'double' ? Math.max(0, b.gapMm) : 0;
  const rect = (inset: number) => ({ x: inset, y: inset, w: W - 2 * inset, h: H - 2 * inset });
  return { rects: gapMm > 0 || b.style === 'double' ? [rect(offsetMm), rect(offsetMm + gapMm)] : [rect(offsetMm)] };
}

const f = (n: number) => +n.toFixed(3);

/** The border as closed stroked rectangles, in the pen's color. */
export function borderPrims(W: number, H: number, b: BorderSettings, color: string): PathPrim[] {
  if (!b.enabled) return [];
  return layoutBorder(W, H, b).rects.map((r) => ({
    kind: 'path',
    d: `M${f(r.x)} ${f(r.y)}H${f(r.x + r.w)}V${f(r.y + r.h)}H${f(r.x)}Z`,
    color, pen: b.pen, mode: 'stroke', widthMm: b.weightMm,
  }));
}
