import { clipPolygon, type XY } from '../geo/clip';
import type { Box } from './select';

/** A clear zone: the box, plus `r` mm of margin on every side. `fills`: filled areas are cut away too, not only lines. */
export interface Halo { box: Box; r: number; fills?: true }

const FAR = 1e5;

/**
 * A filled area with the clear zones that ask for it (`fills`) cut out, as pieces that together cover the rest.
 * Around each zone the area is split into the strips left of it, right of it, and above and below it.
 */
export function cutRingOutOfHalos(ring: XY[], halos: Halo[]): XY[][] {
  let pieces = [ring];
  for (const h of halos) {
    if (!h.fills) continue;
    const c = Math.cos(h.box.ang), s = Math.sin(h.box.ang);
    const toLocal = ([x, y]: XY): XY => [(x - h.box.cx) * c + (y - h.box.cy) * s, -(x - h.box.cx) * s + (y - h.box.cy) * c];
    const toWorld = ([x, y]: XY): XY => [h.box.cx + x * c - y * s, h.box.cy + x * s + y * c];
    const hw = h.box.w / 2 + h.r, hh = h.box.h / 2 + h.r;
    const strips = [
      { x: -FAR, y: -FAR, w: FAR - hw, h: 2 * FAR },
      { x: hw, y: -FAR, w: FAR - hw, h: 2 * FAR },
      { x: -hw, y: -FAR, w: 2 * hw, h: FAR - hh },
      { x: -hw, y: hh, w: 2 * hw, h: FAR - hh },
    ];
    pieces = pieces.flatMap((r) => {
      const local = r.map(toLocal);
      // an area wholly clear of the zone stays as it is
      if (local.every(([x]) => x >= hw) || local.every(([x]) => x <= -hw) || local.every(([, y]) => y >= hh) || local.every(([, y]) => y <= -hh)) return [r];
      return strips.map((st) => clipPolygon(local, st)).filter((p) => p.length >= 3).map((p) => p.map(toWorld));
    });
  }
  return pieces;
}

const inside = (p: XY, h: Halo): boolean => {
  const c = Math.cos(h.box.ang), s = Math.sin(h.box.ang);
  const dx = p[0] - h.box.cx, dy = p[1] - h.box.cy;
  const lx = dx * c + dy * s, ly = -dx * s + dy * c;
  return Math.abs(lx) <= h.box.w / 2 + h.r && Math.abs(ly) <= h.box.h / 2 + h.r;
};

const STEP_MM = 0.25;

/**
 * Cut lines wherever they pass through a clear zone, so a label has room around it (map lines and the outlines of buildings). Segments that stay far from every
 * zone are copied as they are; near one, the segment is sampled every 0.25 mm and the part inside is dropped.
 */
export function cutOutHalos(lines: XY[][], halos: Halo[]): XY[][] {
  const live = halos.filter((h) => h.r > 0 || (h.box.w > 0 && h.box.h > 0));
  if (!live.length) return lines;
  const reach = live.map((h) => Math.hypot(h.box.w, h.box.h) / 2 + h.r);
  /** does the segment a-b come within reach of any zone? */
  const near = (a: XY, b: XY) => live.some((h, i) => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((h.box.cx - a[0]) * dx + (h.box.cy - a[1]) * dy) / l2)) : 0;
    return Math.hypot(a[0] + t * dx - h.box.cx, a[1] + t * dy - h.box.cy) <= reach[i]!;
  });
  const out: XY[][] = [];
  for (const line of lines) {
    let run: XY[] = [];
    const flush = () => { if (run.length > 1) out.push(run); run = []; };
    for (let i = 0; i < line.length; i++) {
      const b = line[i]!;
      if (i === 0) {
        if (!live.some((h) => inside(b, h))) run.push(b);
        continue;
      }
      const a = line[i - 1]!;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (!near(a, b)) { run.push(b); continue; }
      const n = Math.max(1, Math.ceil(len / STEP_MM));
      for (let k = 1; k <= n; k++) {
        const p: XY = [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n];
        if (live.some((h) => inside(p, h))) flush();
        else run.push(p);
      }
    }
    flush();
  }
  return out;
};
