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
