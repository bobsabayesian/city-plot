import { describe, expect, it } from 'vitest';
import { clipPolyline, simplifyXY, type XY } from '../src/geo/clip';
import { autoInterval } from '../src/topo/contours';
import { decodeTerrarium, latToPx, loadTerrain, lonToPx, pickZoom, pxToLat, pxToLon, TILE, covers } from '../src/topo/terrain';
import { buildScene, viewBBox } from '../src/scene/buildScene';
import { defaultProject, posterMm } from '../src/scene/project';
import { sampleTrack } from '../src/sample';
import { bbox } from '../src/geo/project';

/** Fake tile server: a cone of height 2000 m centered on `center`, 1 m per world-pixel-ish slope. */
const coneFetcher = (center: { lat: number; lon: number }) => async (z: number, tx: number, ty: number) => {
  const cx = lonToPx(center.lon, z);
  const cy = latToPx(center.lat, z);
  const out = new Float32Array(TILE * TILE);
  const slope = 2000 / (2 ** z * TILE * 0.0008); // cone radius ~0.08% of the world circumference at this zoom
  for (let r = 0; r < TILE; r++)
    for (let c = 0; c < TILE; c++) out[r * TILE + c] = Math.max(0, 2000 - slope * Math.hypot(tx * TILE + c - cx, ty * TILE + r - cy));
  return out;
};

describe('terrain', () => {
  it('decodes terrarium rgb', () => {
    expect(decodeTerrarium(128, 0, 0)).toBe(0);
    expect(decodeTerrarium(130, 5, 128)).toBe(2 * 256 + 5 + 0.5);
  });
  it('pixel <-> lat/lon round trips', () => {
    expect(pxToLon(lonToPx(-121.7, 10), 10)).toBeCloseTo(-121.7, 6);
    expect(pxToLat(latToPx(46.8, 10), 10)).toBeCloseTo(46.8, 6);
  });
  it('picks a finer zoom for smaller areas', () => {
    const small = { minLat: 46.8, maxLat: 46.85, minLon: -121.8, maxLon: -121.7 };
    const big = { minLat: 40, maxLat: 50, minLon: -125, maxLon: -115 };
    expect(pickZoom(small)).toBeGreaterThan(pickZoom(big));
    expect(pickZoom(small)).toBeLessThanOrEqual(13);
  });
  it('stitches tiles to cover the requested bbox', async () => {
    const b = { minLat: 46.8, maxLat: 46.9, minLon: -121.8, maxLon: -121.7 };
    const field = await loadTerrain(b, coneFetcher({ lat: 46.85, lon: -121.75 }));
    expect(covers(field, b)).toBe(true);
    expect(field.data.length).toBe(field.w * field.h);
    expect(field.w % TILE).toBe(0);
  });
});

describe('geometry helpers', () => {
  it('clips a polyline to a rect and splits it when it leaves', () => {
    const pts: XY[] = [[-5, 5], [5, 5], [15, 5], [15, -5], [5, -5], [5, 3]];
    const pieces = clipPolyline(pts, { x: 0, y: 0, w: 10, h: 10 });
    for (const piece of pieces) for (const [x, y] of piece) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(10); expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThanOrEqual(10); }
    expect(pieces.length).toBeGreaterThanOrEqual(1);
    expect(clipPolyline([[20, 20], [30, 30]], { x: 0, y: 0, w: 10, h: 10 })).toEqual([]);
  });
  it('simplifies collinear xy points', () => {
    expect(simplifyXY([[0, 0], [1, 0.001], [2, 0], [3, 0]], 0.05)).toHaveLength(2);
  });
  it('simplifies a closed ring without collapsing it', () => {
    const ring: XY[] = Array.from({ length: 101 }, (_, i) => [50 * Math.cos((i / 100) * 2 * Math.PI), 50 * Math.sin((i / 100) * 2 * Math.PI)]);
    ring[100] = ring[0]!; // close exactly, as contour rings are
    const out = simplifyXY(ring, 0.1);
    expect(out.length).toBeGreaterThan(20);
    expect(out[0]).toEqual(out[out.length - 1]);
  });
  it('autoInterval gives a nice number', () => {
    expect(autoInterval(1500, 4400)).toBe(200);
    expect(autoInterval(0, 50)).toBe(5);
  });
});

describe('contours in the scene', () => {
  it('draws contour lines (regular + heavier index) that stay inside the frame', async () => {
    const p = { ...defaultProject(), points: sampleTrack() };
    const need = viewBBox(p)!;
    const c = bbox(p.points);
    const field = await loadTerrain(need, coneFetcher({ lat: (c.minLat + c.maxLat) / 2, lon: (c.minLon + c.maxLon) / 2 }));
    const scene = buildScene(p, field);
    const strokes = scene.prims.filter((x) => x.kind === 'path' && x.mode === 'stroke' && x.widthMm! <= 0.3);
    expect(strokes.length).toBeGreaterThanOrEqual(2); // regular + index
    const { w, h } = posterMm(p);
    const nums = strokes.flatMap((s) => (s.kind === 'path' ? s.d.match(/-?\d+(\.\d+)?/g)!.map(Number) : []));
    expect(Math.min(...nums)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...nums)).toBeLessThanOrEqual(Math.max(w, h));
    // contours are drawn under the route
    const idxContour = scene.prims.findIndex((x) => x.kind === 'path' && x.widthMm === p.terrain.weightMm);
    const idxRoute = scene.prims.findIndex((x) => x.kind === 'path' && x.widthMm === p.route.weightMm);
    expect(idxContour).toBeGreaterThanOrEqual(0);
    expect(idxContour).toBeLessThan(idxRoute);
  });
  it('terrain can be switched off', async () => {
    const p = { ...defaultProject(), points: sampleTrack() };
    p.terrain.enabled = false;
    const field = await loadTerrain(viewBBox(p)!, coneFetcher({ lat: 46.8, lon: -121.7 }));
    expect(buildScene(p, field).prims.some((x) => x.kind === 'path' && x.widthMm === p.terrain.weightMm)).toBe(false);
  });
});
