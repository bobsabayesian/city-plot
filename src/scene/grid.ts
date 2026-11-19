import { clipPolyline, clipPolylineConvex, type Rect, type XY } from '../geo/clip';
import type { Fit } from '../geo/project';

/**
 * A kilometre grid, as on military and survey maps: lines of the UTM grid every so many kilometres, with the
 * grid numbers (the kilometre's last two digits) in the margin where each line meets the edge of the map. A
 * six-figure grid reference is read straight off them.
 *
 * UTM (Universal Transverse Mercator) splits the world into 6° zones; within one, eastings and northings are metres
 * on a transverse Mercator projection. The grid lines are straight in UTM, so on this map (Web Mercator, maybe
 * turned) they lean very slightly away from north: the grid is drawn as the true UTM lines, not as north-up lines.
 */
export interface GridSettings {
  enabled: boolean;
  /** kilometres between lines; 0 = chosen from the map's scale */
  spacingKm: number;
  pen: string;
  /** the grid numbers in the margin */
  labels: boolean;
  labelSizePt: number;
}
export const defaultGrid = (pen: string): GridSettings => ({ enabled: false, spacingKm: 0, pen, labels: true, labelSizePt: 7 });

const A = 6378137;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const EP2 = E2 / (1 - E2);
const K0 = 0.9996;
const RAD = Math.PI / 180;

/** The UTM zone (1-60) a longitude is in. (The Norway and Svalbard exceptions are not applied.) */
export const utmZone = (lon: number) => Math.min(60, Math.max(1, Math.floor((lon + 180) / 6) + 1));
/** The latitude band letter, C (80° S) to X (84° N). */
export const utmBand = (lat: number) => 'CDEFGHJKLMNPQRSTUVWXX'[Math.min(20, Math.max(0, Math.floor((lat + 80) / 8)))]!;

/** Latitude, longitude -> UTM easting, northing (metres) in the given zone; southern-hemisphere northings start at 10,000 km. */
export function toUtm(lat: number, lon: number, zone: number, south = lat < 0): XY {
  const phi = lat * RAD;
  const lam0 = ((zone - 1) * 6 - 180 + 3) * RAD;
  const sin = Math.sin(phi), cos = Math.cos(phi), tan = Math.tan(phi);
  const N = A / Math.sqrt(1 - E2 * sin * sin);
  const T = tan * tan, C = EP2 * cos * cos, Aa = cos * (lon * RAD - lam0);
  const e4 = E2 * E2, e6 = e4 * E2;
  const M = A * ((1 - E2 / 4 - (3 * e4) / 64 - (5 * e6) / 256) * phi
    - ((3 * E2) / 8 + (3 * e4) / 32 + (45 * e6) / 1024) * Math.sin(2 * phi)
    + ((15 * e4) / 256 + (45 * e6) / 1024) * Math.sin(4 * phi)
    - ((35 * e6) / 3072) * Math.sin(6 * phi));
  const x = K0 * N * (Aa + ((1 - T + C) * Aa ** 3) / 6 + ((5 - 18 * T + T * T + 72 * C - 58 * EP2) * Aa ** 5) / 120) + 500000;
  const y = K0 * (M + N * tan * ((Aa * Aa) / 2 + ((5 - T + 9 * C + 4 * C * C) * Aa ** 4) / 24 + ((61 - 58 * T + T * T + 600 * C - 330 * EP2) * Aa ** 6) / 720));
  return [x, south ? y + 1e7 : y];
}

/** UTM easting, northing -> latitude, longitude, by Newton's method from a nearby starting point (exact to well under a millimetre). */
export function fromUtm(e: number, n: number, zone: number, south: boolean, guess: [number, number]): [number, number] {
  let [lat, lon] = guess;
  for (let i = 0; i < 8; i++) {
    const [x, y] = toUtm(lat, lon, zone, south);
    const dx = e - x, dy = n - y;
    if (Math.abs(dx) < 1e-4 && Math.abs(dy) < 1e-4) break;
    const h = 1e-6;
    const [xa, ya] = toUtm(lat + h, lon, zone, south);
    const [xo, yo] = toUtm(lat, lon + h, zone, south);
    // the Jacobian d(x, y) / d(lat, lon), inverted
    const j11 = (xa - x) / h, j12 = (xo - x) / h, j21 = (ya - y) / h, j22 = (yo - y) / h;
    const det = j11 * j22 - j12 * j21;
    lat += (j22 * dx - j12 * dy) / det;
    lon += (-j21 * dx + j11 * dy) / det;
  }
  return [lat, lon];
}

/** Kilometres between grid lines for a map at 1:scale: the smallest round spacing that keeps lines at least 15 mm apart. */
export function autoSpacingKm(scale: number): number {
  const mmPerKm = 1e6 / scale;
  return [1, 2, 5, 10, 20, 50].find((k) => k * mmPerKm >= 15) ?? 100;
}

export interface GridLine { axis: 'e' | 'n'; km: number; pts: XY[] }
export interface GridLabel { text: string; x: number; y: number; anchor: 'start' | 'middle' | 'end'; edge: 'top' | 'bottom' | 'left' | 'right' }

/** The grid lines across the frame (in poster mm, not yet clipped), for the UTM zone of the map's centre. */
export function gridLines(fit: Fit, frame: Rect, spacingKm: number): { zone: number; band: string; lines: GridLine[] } {
  const c = fit.fromMm(frame.x + frame.w / 2, frame.y + frame.h / 2);
  const zone = utmZone(c[1]);
  const south = c[0] < 0;
  const corners = [[frame.x, frame.y], [frame.x + frame.w, frame.y], [frame.x, frame.y + frame.h], [frame.x + frame.w, frame.y + frame.h]]
    .map(([x, y]) => { const [la, lo] = fit.fromMm(x!, y!); return toUtm(la, lo, zone, south); });
  const step = spacingKm * 1000;
  const e0 = Math.floor(Math.min(...corners.map((p) => p[0])) / step) * step, e1 = Math.max(...corners.map((p) => p[0]));
  const n0 = Math.floor(Math.min(...corners.map((p) => p[1])) / step) * step, n1 = Math.max(...corners.map((p) => p[1]));
  const lines: GridLine[] = [];
  const SAMPLES = 32;
  const toMm = (e: number, n: number): XY => { const [la, lo] = fromUtm(e, n, zone, south, c); return fit.toMm(la, lo); };
  // a line runs a step past the frame at both ends, so it crosses the whole map whatever the turn
  for (let e = e0; e <= e1 + step && lines.length < 400; e += step) {
    lines.push({ axis: 'e', km: Math.round(e / 1000), pts: Array.from({ length: SAMPLES + 1 }, (_, i) => toMm(e, n0 - step + ((n1 - n0 + 2 * step) * i) / SAMPLES)) });
  }
  for (let n = n0; n <= n1 + step && lines.length < 800; n += step) {
    lines.push({ axis: 'n', km: Math.round(n / 1000), pts: Array.from({ length: SAMPLES + 1 }, (_, i) => toMm(e0 - step + ((e1 - e0 + 2 * step) * i) / SAMPLES, n)) });
  }
  return { zone, band: utmBand(c[0]), lines };
}

/** The lines cut to the map, and a grid number in the margin wherever one meets the frame's edge. */
export function gridGeometry(lines: GridLine[], frame: Rect, clip: { poly: XY[]; safe: Rect } | undefined, labelGapMm: number, labelSizeMm: number): { pieces: XY[][]; labels: GridLabel[] } {
  const pieces: XY[][] = [];
  const labels: GridLabel[] = [];
  const eps = 1e-6;
  for (const l of lines) {
    const cut = clip ? clipPolylineConvex(l.pts, clip.poly, clip.safe) : clipPolyline(l.pts, frame);
    pieces.push(...cut);
    if (clip) continue; // a coaster's round edge has no margin to write in
    const text = String(((l.km % 100) + 100) % 100).padStart(2, '0');
    // a line is numbered only on the edges it meets head-on: an upright line at the top and bottom, a level one at the
    // sides (as maps number eastings along the top and bottom, northings up the sides), so one that leans out
    // through a side edge near a corner is not numbered there among the others
    const [a, b] = [l.pts[0]!, l.pts[l.pts.length - 1]!];
    const upright = Math.abs(b[1] - a[1]) >= Math.abs(b[0] - a[0]);
    for (const piece of cut) {
      for (const [x, y] of [piece[0]!, piece[piece.length - 1]!]) {
        if (upright !== (Math.abs(y - frame.y) < eps || Math.abs(y - frame.y - frame.h) < eps)) continue;
        if (Math.abs(y - frame.y) < eps) labels.push({ text, x, y: y - labelGapMm, anchor: 'middle', edge: 'top' });
        else if (Math.abs(y - frame.y - frame.h) < eps) labels.push({ text, x, y: y + labelGapMm + labelSizeMm * 0.72, anchor: 'middle', edge: 'bottom' });
        else if (Math.abs(x - frame.x) < eps) labels.push({ text, x: x - labelGapMm, y: y + labelSizeMm * 0.36, anchor: 'end', edge: 'left' });
        else if (Math.abs(x - frame.x - frame.w) < eps) labels.push({ text, x: x + labelGapMm, y: y + labelSizeMm * 0.36, anchor: 'start', edge: 'right' });
      }
    }
  }
  // labels too close along the same edge (a line meeting a corner) would print on top of each other
  const kept: GridLabel[] = [];
  for (const lb of labels) if (!kept.some((k) => k.edge === lb.edge && Math.hypot(k.x - lb.x, k.y - lb.y) < labelSizeMm * 1.6)) kept.push(lb);
  return { pieces, labels: kept };
}
