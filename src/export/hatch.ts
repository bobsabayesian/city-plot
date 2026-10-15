import { flattenPath, type Pt } from './offset';

/** How densely a fill is hatched, as a multiple of the pen tip: solid leaves a little overlap, light a tint. */
export type HatchDensity = 'solid' | 'medium' | 'light';
export const HATCH_FACTOR: Record<HatchDensity, number> = { solid: 0.9, medium: 2, light: 4 };
export const HATCH_ANGLE_DEG = 45;

const f = (n: number) => +n.toFixed(3);

/**
 * Fill a shape with parallel lines, for a pen plotter (which can only draw lines). Every sub-path of `d` is
 * treated as closed and the even-odd rule decides what is inside, so holes (the middle of an O) stay empty.
 * Returns path data of `M x y L x y` segments, or '' if there is nothing to fill.
 */
export function hatchPath(d: string, spacingMm: number, angleDeg = HATCH_ANGLE_DEG): string {
  if (!(spacingMm > 0)) return '';
  const subs = flattenPath(d).filter((s) => s.pts.length >= 3);
  if (!subs.length) return '';
  // work in a frame where the hatch lines are horizontal
  const a = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const toLocal = ([x, y]: Pt): Pt => [x * cos + y * sin, -x * sin + y * cos];
  const toWorld = ([x, y]: Pt): Pt => [x * cos - y * sin, x * sin + y * cos];
  const polys = subs.map((s) => s.pts.map(toLocal));
  let minY = Infinity;
  let maxY = -Infinity;
  for (const poly of polys) for (const [, y] of poly) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }

  const out: string[] = [];
  // start half a spacing in, so lines do not run along a flat top or bottom edge
  for (let y = minY + spacingMm / 2; y < maxY; y += spacingMm) {
    const xs: number[] = [];
    for (const poly of polys) {
      for (let i = 0; i < poly.length; i++) {
        const [x1, y1] = poly[i]!;
        const [x2, y2] = poly[(i + 1) % poly.length]!; // the closing edge counts too
        // half-open rule: an edge counts when the line is at or above its lower end and below its upper end
        if ((y1 <= y && y < y2) || (y2 <= y && y < y1)) xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
      }
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      if (xs[i + 1]! - xs[i]! < 0.02) continue;
      const [ax, ay] = toWorld([xs[i]!, y]);
      const [bx, by] = toWorld([xs[i + 1]!, y]);
      out.push(`M${f(ax)} ${f(ay)}L${f(bx)} ${f(by)}`);
    }
  }
  return out.join('');
}
