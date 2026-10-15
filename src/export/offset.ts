/**
 * Draw a heavy line with a thin pen: repeat the path several times, shifted sideways, so the passes together
 * cover the original width. Used by the plotter export so every line can be drawn with one pen per color.
 */
export type Pt = [number, number];
export interface Sub { pts: Pt[]; closed: boolean }

/** How many passes of a `penMm` pen it takes to cover a `widthMm` line (at least `minPasses`, and at least one). */
export const passCount = (widthMm: number, penMm: number, minPasses = 1) => Math.max(1, minPasses, Math.round(widthMm / penMm));

/**
 * Sideways shift of each pass, centered on the original line. The passes overlap (the pitch never exceeds the
 * pen width, so there are no gaps) and are spaced at least 0.6 pen apart, so a forced extra pass on a thin line
 * still reads as clearly heavier than a single pass.
 */
export function passOffsets(widthMm: number, penMm: number, minPasses = 1): number[] {
  const n = passCount(widthMm, penMm, minPasses);
  if (n === 1) return [0];
  const pitch = Math.min(penMm, Math.max(0.6 * penMm, (widthMm - penMm) / (n - 1)));
  return Array.from({ length: n }, (_, k) => (k - (n - 1) / 2) * pitch);
}

/** The line weights in a scene that the plotter export draws as several passes, for the export panel. */
export function summarizePasses<P extends { kind: string; mode?: string; widthMm?: number; minPasses?: number }>(
  prims: P[],
  /** one tip width for everything, or a function giving each primitive its pen's tip */
  tip: number | ((p: P) => number),
): { widthMm: number; passes: number; forced: boolean }[] {
  const seen = new Map<string, { widthMm: number; passes: number; forced: boolean }>();
  for (const p of prims) {
    if (p.kind !== 'path' || p.mode !== 'stroke') continue;
    const widthMm = +(p.widthMm ?? 0.5).toFixed(2);
    const penMm = typeof tip === 'number' ? tip : tip(p);
    const passes = passCount(widthMm, penMm, p.minPasses);
    if (passes > 1) seen.set(`${widthMm}|${passes}`, { widthMm, passes, forced: passCount(widthMm, penMm) < passes });
  }
  return [...seen.values()].sort((a, b) => a.widthMm - b.widthMm);
}

const ARITY: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

/** Turn SVG path data into polylines. Curves and arcs are flattened finely enough for a 0.1 mm pen. */
export function flattenPath(d: string): Sub[] {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  const subs: Sub[] = [];
  let cur: Sub | undefined;
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  let i = 0;
  let cmd = '';
  const start = (px: number, py: number) => {
    cur = { pts: [[px, py]], closed: false };
    subs.push(cur);
    x = sx = px;
    y = sy = py;
  };
  const lineTo = (px: number, py: number) => {
    if (!cur) start(x, y);
    cur!.pts.push([px, py]);
    x = px;
    y = py;
  };
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i]!)) cmd = tokens[i++]!;
    const up = cmd.toUpperCase();
    const rel = cmd !== up;
    if (up === 'Z') {
      if (cur) { cur.closed = true; x = sx; y = sy; cur = undefined; }
      if (i < tokens.length && !/[a-zA-Z]/.test(tokens[i]!)) i++; // stray number after Z
      continue;
    }
    const n = ARITY[up];
    if (n === undefined || i + n > tokens.length) break;
    const a = tokens.slice(i, i + n).map(Number);
    i += n;
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    switch (up) {
      case 'M': start(a[0]! + ox, a[1]! + oy); cmd = rel ? 'l' : 'L'; break; // further pairs are line-tos
      case 'L': lineTo(a[0]! + ox, a[1]! + oy); break;
      case 'H': lineTo(a[0]! + (rel ? x : 0), y); break;
      case 'V': lineTo(x, a[0]! + (rel ? y : 0)); break;
      case 'C': bezier([x, y], [a[0]! + ox, a[1]! + oy], [a[2]! + ox, a[3]! + oy], [a[4]! + ox, a[5]! + oy], lineTo); break;
      case 'Q': {
        const p0: Pt = [x, y];
        const q: Pt = [a[0]! + ox, a[1]! + oy];
        const p2: Pt = [a[2]! + ox, a[3]! + oy];
        bezier(p0, [p0[0] + (2 / 3) * (q[0] - p0[0]), p0[1] + (2 / 3) * (q[1] - p0[1])], [p2[0] + (2 / 3) * (q[0] - p2[0]), p2[1] + (2 / 3) * (q[1] - p2[1])], p2, lineTo);
        break;
      }
      case 'A': arc(x, y, a[0]!, a[1]!, a[2]!, !!a[3], !!a[4], a[5]! + ox, a[6]! + oy, lineTo); break;
      default: lineTo(a[a.length - 2]! + ox, a[a.length - 1]! + oy); // S/T: approximate as a straight segment
    }
  }
  return subs.filter((s) => s.pts.length > 1);
}

function bezier(p0: Pt, p1: Pt, p2: Pt, p3: Pt, to: (x: number, y: number) => void) {
  const steps = 12;
  for (let k = 1; k <= steps; k++) {
    const t = k / steps;
    const u = 1 - t;
    to(
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    );
  }
}

/** SVG elliptical arc (endpoint form) -> line segments, following the SVG implementation notes. */
function arc(x1: number, y1: number, rxIn: number, ryIn: number, rotDeg: number, large: boolean, sweep: boolean, x2: number, y2: number, to: (x: number, y: number) => void) {
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (!rx || !ry || (x1 === x2 && y1 === y2)) return to(x2, y2);
  const phi = (rotDeg * Math.PI) / 180;
  const c = Math.cos(phi);
  const s = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = c * dx + s * dy;
  const y1p = -s * dx + c * dy;
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const co = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (co * rx * y1p) / ry;
  const cyp = (-co * ry * x1p) / rx;
  const cx = c * cxp - s * cyp + (x1 + x2) / 2;
  const cy = s * cxp + c * cyp + (y1 + y2) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const th1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dth = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dth > 0) dth -= 2 * Math.PI;
  if (sweep && dth < 0) dth += 2 * Math.PI;
  const steps = Math.max(8, Math.ceil(Math.abs(dth) / (Math.PI / 18)));
  for (let k = 1; k <= steps; k++) {
    const t = th1 + (dth * k) / steps;
    to(cx + rx * Math.cos(t) * c - ry * Math.sin(t) * s, cy + rx * Math.cos(t) * s + ry * Math.sin(t) * c);
  }
}

const MITER_LIMIT = 2;

/** One polyline moved sideways by `d` (positive = to the left of travel). Sharp corners are beveled, not spiked. */
export function offsetPolyline(input: Pt[], d: number, closed: boolean): Pt[] {
  const pts = input.filter((p, i) => i === 0 || Math.hypot(p[0] - input[i - 1]![0], p[1] - input[i - 1]![1]) > 1e-9);
  if (closed && pts.length > 1 && Math.hypot(pts[0]![0] - pts[pts.length - 1]![0], pts[0]![1] - pts[pts.length - 1]![1]) < 1e-9) pts.pop();
  const n = pts.length;
  if (n < 2 || d === 0) return input;
  const seg = (i: number): Pt => {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(b[1] - a[1]) / len, -(b[0] - a[0]) / len]; // left normal in screen coordinates (y down)
  };
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i]!;
    const hasPrev = closed || i > 0;
    const hasNext = closed || i < n - 1;
    const n1 = hasPrev ? seg((i - 1 + n) % n) : seg(i);
    const n2 = hasNext ? seg(i) : seg(i - 1);
    const dot = n1[0] * n2[0] + n1[1] * n2[1];
    const factor = Math.sqrt(2 / Math.max(1 + dot, 1e-9));
    if (factor > MITER_LIMIT) {
      out.push([p[0] + d * n1[0], p[1] + d * n1[1]], [p[0] + d * n2[0], p[1] + d * n2[1]]);
    } else {
      const k = d / (1 + dot);
      out.push([p[0] + k * (n1[0] + n2[0]), p[1] + k * (n1[1] + n2[1])]);
    }
  }
  if (closed) out.push(out[0]!);
  return out;
}

const f = (v: number) => +v.toFixed(3);

/** Path data for `d` moved sideways by `offset` mm. */
export function offsetPath(d: string, offset: number): string {
  return flattenPath(d)
    .map((s) => {
      const pts = offsetPolyline(s.pts, offset, s.closed);
      return pts.map(([x, y], i) => `${i ? 'L' : 'M'}${f(x)} ${f(y)}`).join('') + (s.closed ? 'Z' : '');
    })
    .join('');
}
