import type { Pen } from './pens';
import type { PathPrim } from './types';
import type { TitleFrame } from './project';

const f = (n: number) => +n.toFixed(3);
const rect = (x: number, y: number, w: number, h: number) => `M${f(x)} ${f(y)}H${f(x + w)}V${f(y + h)}H${f(x)}Z`;

/**
 * A frame round the title block: a ruled box, a double rule (a heavier outer line and a fine inner one, as on old
 * maps), or ornamental corners (a pair of brackets at each corner). All strokes, so it plots with the title's pen.
 */
export function cartouche(x: number, y: number, w: number, h: number, style: TitleFrame, pen: Pen): PathPrim[] {
  if (style === 'none' || w <= 0 || h <= 0) return [];
  const line = (d: string, widthMm: number): PathPrim => ({ kind: 'path', d, color: pen.color, pen: pen.id, mode: 'stroke', widthMm, round: true });
  if (style === 'box') return [line(rect(x, y, w, h), 0.35)];
  if (style === 'double') return [line(rect(x, y, w, h), 0.6), line(rect(x + 1.2, y + 1.2, w - 2.4, h - 2.4), 0.25)];
  // corners: two nested L brackets at each corner
  const arm = Math.min(12, w * 0.08, h * 0.35);
  let d = '';
  for (const [k, inset] of [[1, 0], [0.6, 1.4]] as const) {
    const a = arm * k;
    const [x0, y0, x1, y1] = [x + inset, y + inset, x + w - inset, y + h - inset];
    d += `M${f(x0)} ${f(y0 + a)}V${f(y0)}H${f(x0 + a)}M${f(x1 - a)} ${f(y0)}H${f(x1)}V${f(y0 + a)}`;
    d += `M${f(x1)} ${f(y1 - a)}V${f(y1)}H${f(x1 - a)}M${f(x0 + a)} ${f(y1)}H${f(x0)}V${f(y1 - a)}`;
  }
  return [line(d, 0.35)];
}
