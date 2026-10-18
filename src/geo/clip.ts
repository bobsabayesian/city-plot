export type XY = [number, number];
export interface Rect { x: number; y: number; w: number; h: number }

/** Clip a polyline to a rectangle (Liang-Barsky per segment); returns the pieces that survive. */
export function clipPolyline(pts: XY[], r: Rect): XY[][] {
  const out: XY[][] = [];
  let cur: XY[] = [];
  const x1 = r.x + r.w;
  const y1 = r.y + r.h;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1]!;
    const [bx, by] = pts[i]!;
    const dx = bx - ax;
    const dy = by - ay;
    let t0 = 0;
    let t1 = 1;
    const p = [-dx, dx, -dy, dy];
    const q = [ax - r.x, x1 - ax, ay - r.y, y1 - ay];
    let inside = true;
    for (let k = 0; k < 4; k++) {
      if (p[k] === 0) {
        if (q[k]! < 0) { inside = false; break; }
      } else {
        const t = q[k]! / p[k]!;
        if (p[k]! < 0) { if (t > t1) { inside = false; break; } if (t > t0) t0 = t; }
        else { if (t < t0) { inside = false; break; } if (t < t1) t1 = t; }
      }
    }
    if (!inside) {
      if (cur.length > 1) out.push(cur);
      cur = [];
      continue;
    }
    const s: XY = [ax + t0 * dx, ay + t0 * dy];
    const e: XY = [ax + t1 * dx, ay + t1 * dy];
    const last = cur[cur.length - 1];
    if (!last || last[0] !== s[0] || last[1] !== s[1]) {
      if (cur.length > 1) out.push(cur);
      cur = [s];
    }
    cur.push(e);
    if (t1 < 1) {
      out.push(cur);
      cur = [];
    }
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

/** Douglas-Peucker on plain x/y (mm). */
export function simplifyXY(pts: XY[], tol: number): XY[] {
  if (pts.length < 3) return pts;
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  if (first[0] === last[0] && first[1] === last[1]) {
    // Closed ring: the chord is degenerate, so split at the point farthest from the start first.
    let k = 1;
    let far = -1;
    for (let i = 1; i < pts.length - 1; i++) {
      const d = Math.hypot(pts[i]![0] - first[0], pts[i]![1] - first[1]);
      if (d > far) { far = d; k = i; }
    }
    return [...simplifyXY(pts.slice(0, k + 1), tol), ...simplifyXY(pts.slice(k), tol).slice(1)];
  }
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a]!;
    const [bx, by] = pts[b]!;
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    let worst = -1;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i]![0] - ax) * dy - (pts[i]![1] - ay) * dx) / len;
      if (d > worst) { worst = d; idx = i; }
    }
    if (worst > tol) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Clip a ring to a rectangle (Sutherland-Hodgman). The result is a closed ring without the repeated end point; may be empty. */
export function clipPolygon(ring: XY[], r: Rect): XY[] {
  const x1 = r.x + r.w;
  const y1 = r.y + r.h;
  const edges: { inside: (p: XY) => boolean; cut: (a: XY, b: XY) => XY }[] = [
    { inside: (p) => p[0] >= r.x, cut: (a, b) => [r.x, a[1] + ((b[1] - a[1]) * (r.x - a[0])) / (b[0] - a[0])] },
    { inside: (p) => p[0] <= x1, cut: (a, b) => [x1, a[1] + ((b[1] - a[1]) * (x1 - a[0])) / (b[0] - a[0])] },
    { inside: (p) => p[1] >= r.y, cut: (a, b) => [a[0] + ((b[0] - a[0]) * (r.y - a[1])) / (b[1] - a[1]), r.y] },
    { inside: (p) => p[1] <= y1, cut: (a, b) => [a[0] + ((b[0] - a[0]) * (y1 - a[1])) / (b[1] - a[1]), y1] },
  ];
  let out = ring.length > 1 && ring[0]![0] === ring[ring.length - 1]![0] && ring[0]![1] === ring[ring.length - 1]![1] ? ring.slice(0, -1) : ring;
  for (const e of edges) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i]!;
      const prev = input[(i + input.length - 1) % input.length]!;
      if (e.inside(cur)) {
        if (!e.inside(prev)) out.push(e.cut(prev, cur));
        out.push(cur);
      } else if (e.inside(prev)) out.push(e.cut(prev, cur));
    }
    if (!out.length) break;
  }
  return out.length >= 3 ? out : [];
}

/** True if (x, y) is inside the ring (even-odd). */
export function pointInRing(x: number, y: number, ring: XY[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The part of segment a→b inside a convex polygon (any winding), as [t0, t1] along the segment, or undefined. Cyrus-Beck. */
function segmentInConvex(a: XY, b: XY, poly: XY[], sign: number): [number, number] | undefined {
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    const ex = q[0] - p[0];
    const ey = q[1] - p[1];
    // inside is where `cross` is >= 0 (after the winding sign)
    const at = sign * (ex * (a[1] - p[1]) - ey * (a[0] - p[0]));
    const along = sign * (ex * dy - ey * dx);
    if (along === 0) { if (at < 0) return undefined; continue; }
    const t = -at / along;
    if (along > 0) { if (t > t0) t0 = t; } else if (t < t1) t1 = t;
    if (t0 > t1) return undefined;
  }
  return [t0, t1];
}

const windingSign = (poly: XY[]) => {
  let area = 0;
  for (let i = 0; i < poly.length; i++) { const [x1, y1] = poly[i]!; const [x2, y2] = poly[(i + 1) % poly.length]!; area += x1 * y2 - x2 * y1; }
  return area >= 0 ? 1 : -1;
};

/**
 * Clip a polyline to a convex polygon. `safe` is a rectangle known to lie inside the polygon: segments with both ends
 * in it skip the polygon test, which keeps big maps fast.
 */
export function clipPolylineConvex(pts: XY[], poly: XY[], safe?: Rect): XY[][] {
  const sign = windingSign(poly);
  const inSafe = (p: XY) => !!safe && p[0] >= safe.x && p[0] <= safe.x + safe.w && p[1] >= safe.y && p[1] <= safe.y + safe.h;
  const out: XY[][] = [];
  let cur: XY[] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const hit: [number, number] | undefined = inSafe(a) && inSafe(b) ? [0, 1] : segmentInConvex(a, b, poly, sign);
    if (!hit) { if (cur.length > 1) out.push(cur); cur = []; continue; }
    const [t0, t1] = hit;
    const s: XY = t0 === 0 ? a : [a[0] + t0 * (b[0] - a[0]), a[1] + t0 * (b[1] - a[1])];
    const e: XY = t1 === 1 ? b : [a[0] + t1 * (b[0] - a[0]), a[1] + t1 * (b[1] - a[1])];
    const last = cur[cur.length - 1];
    if (!last || last[0] !== s[0] || last[1] !== s[1]) {
      if (cur.length > 1) out.push(cur);
      cur = [s];
    }
    cur.push(e);
    if (t1 < 1) { out.push(cur); cur = []; }
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

/** Clip a ring to a convex polygon (Sutherland-Hodgman). Closed result without the repeated end point; may be empty. */
export function clipPolygonConvex(ring: XY[], poly: XY[]): XY[] {
  const sign = windingSign(poly);
  let out = ring.length > 1 && ring[0]![0] === ring[ring.length - 1]![0] && ring[0]![1] === ring[ring.length - 1]![1] ? ring.slice(0, -1) : ring;
  for (let i = 0; i < poly.length && out.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    const side = (v: XY) => sign * ((q[0] - p[0]) * (v[1] - p[1]) - (q[1] - p[1]) * (v[0] - p[0]));
    const input = out;
    out = [];
    for (let k = 0; k < input.length; k++) {
      const cur = input[k]!;
      const prev = input[(k + input.length - 1) % input.length]!;
      const [sc, sp] = [side(cur), side(prev)];
      if (sc >= 0) {
        if (sp < 0) out.push(lerp(prev, cur, sp / (sp - sc)));
        out.push(cur);
      } else if (sp >= 0) out.push(lerp(prev, cur, sp / (sp - sc)));
    }
  }
  return out.length >= 3 ? out : [];
}
const lerp = (a: XY, b: XY, t: number): XY => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/** A circle as a polygon. */
export function circlePolygon(cx: number, cy: number, r: number, n = 180): XY[] {
  return Array.from({ length: n }, (_, i) => [cx + r * Math.cos((i / n) * 2 * Math.PI), cy + r * Math.sin((i / n) * 2 * Math.PI)] as XY);
}

/** A rectangle with rounded corners as a polygon (radius is kept within half the shorter side). */
export function roundRectPolygon(r: Rect, radius: number, perCorner = 16): XY[] {
  const rad = Math.max(0, Math.min(radius, r.w / 2, r.h / 2));
  if (rad === 0) return [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];
  const out: XY[] = [];
  const corners: [number, number, number][] = [[r.x + r.w - rad, r.y + rad, -90], [r.x + r.w - rad, r.y + r.h - rad, 0], [r.x + rad, r.y + r.h - rad, 90], [r.x + rad, r.y + rad, 180]];
  for (const [cx, cy, start] of corners) for (let i = 0; i <= perCorner; i++) {
    const a = ((start + (i / perCorner) * 90) * Math.PI) / 180;
    out.push([cx + rad * Math.cos(a), cy + rad * Math.sin(a)]);
  }
  return out;
}
