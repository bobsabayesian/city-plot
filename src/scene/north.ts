import type { Rect } from '../geo/clip';
import type { Prim } from './types';
import type { Corner, NorthStyle } from './project';

export interface NorthOpts {
  style: NorthStyle;
  corner: Corner;
  sizeMm: number;
  color: string;
  /** pen id, carried onto the drawn lines */
  pen?: string;
  weightMm: number;
  fontFamily: string;
  fontKey: 'sans' | 'serif';
}

const f = (n: number) => +n.toFixed(2);
const poly = (pts: [number, number][], close = true) =>
  pts.map(([x, y], i) => `${i ? 'L' : 'M'}${f(x)} ${f(y)}`).join('') + (close ? 'Z' : '');
const circle = (cx: number, cy: number, r: number) =>
  `M${f(cx - r)} ${f(cy)}a${f(r)} ${f(r)} 0 1 0 ${f(2 * r)} 0a${f(r)} ${f(r)} 0 1 0 ${f(-2 * r)} 0Z`;

/** Top-left of the s x s box for a corner of the frame (inset so it doesn't sit on the frame edge). */
export function northBox(frame: Rect, corner: Corner, s: number): { x: number; y: number } {
  const pad = Math.max(3, s * 0.15);
  const left = corner === 'tl' || corner === 'bl';
  const top = corner === 'tl' || corner === 'tr';
  return {
    x: left ? frame.x + pad : frame.x + frame.w - pad - s,
    y: top ? frame.y + pad : frame.y + frame.h - pad - s,
  };
}

/**
 * A north indicator inside an s x s box. Maps are drawn north-up, so it always points up.
 * Outlines are strokes and only the north point is filled, so plotter mode (strokes only) keeps it legible.
 */
export function northPrims(frame: Rect, o: NorthOpts): Prim[] {
  const s = o.sizeMm;
  const { x: x0, y: y0 } = northBox(frame, o.corner, s);
  const cx = x0 + s / 2;
  const prims: Prim[] = [];
  const line = (d: string) => prims.push({ kind: 'path', d, color: o.color, pen: o.pen, mode: 'stroke', widthMm: o.weightMm, round: true });
  const fill = (d: string) => prims.push({ kind: 'path', d, color: o.color, pen: o.pen, mode: 'fill' });
  const label = (t: string, x: number, baseline: number, size: number) =>
    prims.push({
      kind: 'text', text: t, x, y: baseline, anchor: 'middle', sizeMm: size, trackingMm: 0,
      fontFamily: o.fontFamily, fontKey: o.fontKey, color: o.color, pen: o.pen,
    });

  switch (o.style) {
    case 'arrow': {
      label('N', cx, y0 + s * 0.27, s * 0.3);
      const head: [number, number][] = [[cx, y0 + s * 0.36], [cx + s * 0.15, y0 + s * 0.64], [cx - s * 0.15, y0 + s * 0.64]];
      fill(poly(head));
      line(poly(head));
      line(poly([[cx, y0 + s * 0.64], [cx, y0 + s]], false));
      break;
    }
    case 'circle': {
      label('N', cx, y0 + s * 0.25, s * 0.28);
      const cy = y0 + s * 0.64;
      const r = s * 0.36;
      line(circle(cx, cy, r));
      const kite: [number, number][] = [[cx, cy - r * 0.75], [cx + r * 0.38, cy + r * 0.6], [cx, cy + r * 0.28], [cx - r * 0.38, cy + r * 0.6]];
      fill(poly(kite));
      line(poly(kite));
      break;
    }
    case 'compass': {
      const cy = y0 + s / 2;
      const r = s * 0.27;
      line(circle(cx, cy, r));
      const n: [number, number][] = [[cx, cy - r * 0.95], [cx + r * 0.22, cy], [cx - r * 0.22, cy]];
      const south: [number, number][] = [[cx, cy + r * 0.95], [cx + r * 0.22, cy], [cx - r * 0.22, cy]];
      fill(poly(n));
      line(poly(n));
      line(poly(south));
      const ls = s * 0.17;
      const d = s * 0.4;
      label('N', cx, cy - d + ls * 0.36, ls * 1.15);
      label('S', cx, cy + d + ls * 0.36, ls);
      label('E', cx + d, cy + ls * 0.36, ls);
      label('W', cx - d, cy + ls * 0.36, ls);
      break;
    }
    case 'rose': {
      label('N', cx, y0 + s * 0.2, s * 0.22);
      const cy = y0 + s * 0.6;
      const long = s * 0.38;
      const short = s * 0.22;
      const inner = s * 0.08;
      const at = (i: number, r: number): [number, number] => {
        const a = (i * 22.5 * Math.PI) / 180;
        return [cx + Math.sin(a) * r, cy - Math.cos(a) * r];
      };
      const star: [number, number][] = [];
      for (let i = 0; i < 16; i++) star.push(at(i, i % 2 ? inner : i % 4 === 0 ? long : short));
      line(poly(star));
      fill(poly([at(0, long), at(1, inner), at(15, inner)])); // north point solid
      break;
    }
  }
  return prims;
}
