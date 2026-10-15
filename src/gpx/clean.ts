import { haversine } from '../geo/project';
import type { TrackPoint } from './types';

const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1]!;

/** Replace single-sample elevation spikes: median filter, then reject implausible slopes. */
export function removeElevationSpikes(pts: TrackPoint[], window = 5, maxSlope = 1.5): TrackPoint[] {
  const half = window >> 1;
  const out = pts.map((p) => ({ ...p }));
  for (let i = 0; i < pts.length; i++) {
    const p = out[i]!;
    if (p.ele === undefined) continue;
    const near: number[] = [];
    for (let j = Math.max(0, i - half); j <= Math.min(pts.length - 1, i + half); j++) {
      const e = pts[j]!.ele;
      if (e !== undefined) near.push(e);
    }
    const m = median(near);
    const prev = out[i - 1];
    const dist = prev ? haversine(prev.lat, prev.lon, p.lat, p.lon) : 0;
    const jump = prev?.ele === undefined ? 0 : Math.abs(p.ele - prev.ele);
    // A jump steeper than maxSlope (rise/run) between neighbors is not a real hill.
    if (jump > 3 && jump > maxSlope * Math.max(dist, 1)) p.ele = m;
    else if (Math.abs(p.ele - m) > 30) p.ele = m;
  }
  return out;
}

/** Collapse runs of points that stay within `radius` meters of the run's first point (lunch-stop drift). */
export function collapseStationary(pts: TrackPoint[], radius = 8): TrackPoint[] {
  const out: TrackPoint[] = [];
  let i = 0;
  while (i < pts.length) {
    const anchor = pts[i]!;
    let j = i + 1;
    while (j < pts.length && haversine(anchor.lat, anchor.lon, pts[j]!.lat, pts[j]!.lon) < radius) j++;
    const run = pts.slice(i, j);
    if (run.length > 3) {
      const lat = run.reduce((s, p) => s + p.lat, 0) / run.length;
      const lon = run.reduce((s, p) => s + p.lon, 0) / run.length;
      out.push({ ...anchor, lat, lon });
    } else out.push(...run);
    i = j;
  }
  // always keep the true end of the track
  const last = pts[pts.length - 1]!;
  if (out[out.length - 1] !== last && out.length > 0) out.push(last);
  return out;
}

/** Douglas-Peucker in local meters (equirectangular); iterative to survive long tracks. */
export function douglasPeucker(pts: TrackPoint[], toleranceM: number): TrackPoint[] {
  if (pts.length < 3 || toleranceM <= 0) return pts;
  const lat0 = pts[0]!.lat * (Math.PI / 180);
  const kx = 111320 * Math.cos(lat0);
  const ky = 110540;
  const xy = pts.map((p) => [p.lon * kx, p.lat * ky] as const);
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = xy[a]!;
    const [bx, by] = xy[b]!;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let worst = -1;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = xy[i]!;
      let d: number;
      if (len2 === 0) d = Math.hypot(px - ax, py - ay);
      else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      }
      if (d > worst) {
        worst = d;
        idx = i;
      }
    }
    if (worst > toleranceM && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Full pipeline. `toleranceM` should be ~0.1 mm on paper (metersPerMm * 0.1). */
export function cleanTrack(pts: TrackPoint[], toleranceM: number): TrackPoint[] {
  return douglasPeucker(collapseStationary(removeElevationSpikes(pts)), toleranceM);
}
