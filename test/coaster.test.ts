import { describe, expect, it } from 'vitest';
import { circlePolygon, clipPolygonConvex, clipPolylineConvex, roundRectPolygon, type XY } from '../src/geo/clip';
import { coasterPreset, posterMm, PRINT_SIZES, sizeShape } from '../src/scene/project';
import { buildScene, composeScene, viewOf } from '../src/scene/buildScene';
import { sceneToSvg } from '../src/export/svg';
import { cityData, cityProject } from './fixture';

const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) < tol;
const square: XY[] = [[0, 0], [10, 0], [10, 10], [0, 10]];

describe('clipping to a convex shape', () => {
  it('keeps what is inside, cuts what crosses, drops what is outside', () => {
    expect(clipPolylineConvex([[1, 5], [9, 5]], square)).toEqual([[[1, 5], [9, 5]]]);
    expect(clipPolylineConvex([[-5, 5], [15, 5]], square)).toEqual([[[0, 5], [10, 5]]]);
    expect(clipPolylineConvex([[-5, -5], [-1, -1]], square)).toEqual([]);
  });
  it('works for either winding of the polygon', () => {
    expect(clipPolylineConvex([[-5, 5], [15, 5]], [...square].reverse())).toEqual([[[0, 5], [10, 5]]]);
  });
  it('a line through a circle is cut at the circle', () => {
    const c = circlePolygon(50, 50, 10, 360);
    const [piece] = clipPolylineConvex([[0, 50], [100, 50]], c);
    expect(near(piece![0]![0], 40, 0.01)).toBe(true);
    expect(near(piece![piece!.length - 1]![0], 60, 0.01)).toBe(true);
  });
  it('a path that leaves and comes back is two pieces', () => {
    const out = clipPolylineConvex([[1, 1], [20, 1], [20, 9], [1, 9]], square);
    expect(out.length).toBe(2);
  });
  it('the safe rectangle skips the test but gives the same answer', () => {
    const c = circlePolygon(50, 50, 20, 180);
    const safe = { x: 50 - 14, y: 50 - 14, w: 28, h: 28 };
    const line: XY[] = [[40, 40], [45, 55], [60, 60], [90, 50]];
    expect(clipPolylineConvex(line, c, safe)).toEqual(clipPolylineConvex(line, c));
  });
  it('rings are cut to the shape, and a ring around it becomes the shape', () => {
    const ring: XY[] = [[-5, -5], [15, -5], [15, 15], [-5, 15]];
    expect(clipPolygonConvex(ring, square)).toHaveLength(4);
    const half = clipPolygonConvex([[5, -5], [15, -5], [15, 15], [5, 15]], square);
    expect(Math.min(...half.map((p) => p[0]))).toBeCloseTo(5, 9);
    expect(Math.max(...half.map((p) => p[0]))).toBeCloseTo(10, 9);
    expect(clipPolygonConvex([[20, 20], [30, 20], [30, 30]], square)).toEqual([]);
  });
  it('a rounded rectangle polygon stays inside its box and cuts the corners', () => {
    const r = { x: 0, y: 0, w: 40, h: 30 };
    const poly = roundRectPolygon(r, 8);
    for (const [x, y] of poly) { expect(x).toBeGreaterThanOrEqual(-1e-9); expect(x).toBeLessThanOrEqual(40 + 1e-9); expect(y).toBeGreaterThanOrEqual(-1e-9); expect(y).toBeLessThanOrEqual(30 + 1e-9); }
    expect(clipPolylineConvex([[0.5, 0.5], [1.5, 1.5]], poly)).toEqual([]); // inside the cut-off corner
    expect(clipPolylineConvex([[20, 0.2], [20, 29.8]], poly)).toHaveLength(1);
  });
});

describe('coaster sizes', () => {
  it('there is a circle and a rounded rectangle, 4 in on the long side', () => {
    const sizes = PRINT_SIZES.filter((s) => s.group === 'Coasters');
    expect(sizes.map((s) => s.shape).sort()).toEqual(['circle', 'roundrect']);
    for (const s of sizes) expect(Math.max(s.wMm, s.hMm)).toBeCloseTo(101.6, 6);
    const circle = sizes.find((s) => s.shape === 'circle')!;
    expect(circle.wMm).toBe(circle.hMm);
  });
  it('ordinary sizes have no shape', () => {
    expect(sizeShape({ sizeId: '18x24' })).toBeUndefined();
    expect(sizeShape({ sizeId: 'coaster-circle' })?.shape).toBe('circle');
  });
  it('the preset gives small margins and clears the text that would not fit', () => {
    const p = cityProject();
    p.sizeId = 'coaster-circle';
    coasterPreset(p);
    expect(p.page.margins.top).toBe(5);
    expect([p.text.title.visible, p.text.location.visible, p.text.info.visible, p.showWatermark]).toEqual([false, false, false, false]);
    expect(p.layers.buildings.enabled).toBe(false);
    expect(p.features.sizePt).toBe(6);
    expect(p.layers.major.weightMm).toBeLessThanOrEqual(0.54);
  });
  it('landscape turns the rectangle', () => {
    const p = cityProject();
    p.sizeId = 'coaster-roundrect';
    expect(posterMm(p).w).toBeCloseTo(76.2);
    p.landscape = true;
    expect(posterMm(p).w).toBeCloseTo(101.6);
  });
});

describe('a coaster scene', () => {
  const coaster = (id: 'coaster-circle' | 'coaster-roundrect', edit: (p: ReturnType<typeof cityProject>) => void = () => {}) =>
    cityProject((p) => { p.sizeId = id; coasterPreset(p); p.region!.widthKm = 1.2; edit(p); });
  const pts = (d: string) => { const n = (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number); return Array.from({ length: n.length >> 1 }, (_, i) => [n[2 * i]!, n[2 * i + 1]!] as XY); };

  it('the scene carries the paper shape', () => {
    expect(buildScene(coaster('coaster-circle'), cityData()).shape).toEqual({ kind: 'circle' });
    expect(buildScene(coaster('coaster-roundrect'), cityData()).shape).toEqual({ kind: 'roundrect', radiusMm: 8 });
    expect(buildScene(cityProject(), cityData()).shape).toBeUndefined();
  });
  it('everything the map draws stays inside the circle', () => {
    const p = coaster('coaster-circle');
    const sc = buildScene(p, cityData());
    const f = viewOf(p)!.frame;
    const [cx, cy, r] = [f.x + f.w / 2, f.y + f.h / 2, Math.min(f.w, f.h) / 2];
    let n = 0;
    for (const x of sc.prims) {
      if (x.kind !== 'path' || x.d.includes('a')) continue;
      for (const [px, py] of pts(x.d)) { expect(Math.hypot(px - cx, py - cy)).toBeLessThanOrEqual(r + 0.02); n++; }
    }
    expect(n).toBeGreaterThan(10);
  });
  it('and inside the rounded rectangle, which has cut corners', () => {
    const p = coaster('coaster-roundrect');
    const f = viewOf(p)!.frame;
    const rad = 8 - 5;
    for (const x of buildScene(p, cityData()).prims) {
      if (x.kind !== 'path' || x.d.includes('a')) continue;
      for (const [px, py] of pts(x.d)) {
        const dx = Math.max(f.x + rad - px, px - (f.x + f.w - rad), 0);
        const dy = Math.max(f.y + rad - py, py - (f.y + f.h - rad), 0);
        expect(Math.hypot(dx, dy)).toBeLessThanOrEqual(rad + 0.02);
      }
    }
  });
  it('the paper outline is a circle or a rounded rectangle in the SVG', () => {
    expect(sceneToSvg(buildScene(coaster('coaster-circle'), cityData()), { paper: true })).toMatch(/<circle id="paper"/);
    expect(sceneToSvg(buildScene(coaster('coaster-roundrect'), cityData()), { paper: true })).toMatch(/<rect id="paper"[^>]* rx="8"/);
    expect(sceneToSvg(buildScene(cityProject(), cityData()), { paper: true })).toMatch(/<rect id="paper" width="[\d.]+" height="[\d.]+" fill/);
  });
  it('landmarks outside the circle are not drawn, and ones inside are', () => {
    const p = coaster('coaster-circle', (q) => {
      q.custom = [
        { id: 'custom-1', name: 'Centre', kind: 'custom', lat: 47.6062, lon: -122.3321 },
        { id: 'custom-2', name: 'Corner', kind: 'custom', lat: 47.6062 + 0.0075, lon: -122.3321 + 0.0075 }, // in the frame's corner, outside the circle
      ];
    });
    const v = viewOf(p)!;
    const [cx, cy] = v.fit.toMm(47.6062 + 0.0075, -122.3321 + 0.0075);
    const f = v.frame;
    expect(Math.hypot(cx - (f.x + f.w / 2), cy - (f.y + f.h / 2))).toBeGreaterThan(Math.min(f.w, f.h) / 2); // really outside
    const names = composeScene(p, cityData()).scene.prims.flatMap((x) => (x.kind === 'text' ? [x.text] : []));
    expect(names).toContain('Centre');
    expect(names).not.toContain('Corner');
  });
  it('the north arrow sits inside the circle', () => {
    const p = coaster('coaster-circle', (q) => { q.north.enabled = true; q.north.sizeMm = 12; });
    const f = viewOf(p)!.frame;
    const [cx, cy, r] = [f.x + f.w / 2, f.y + f.h / 2, Math.min(f.w, f.h) / 2];
    const nTxt = buildScene(p, cityData()).prims.find((x) => x.kind === 'text' && x.text === 'N') as { x: number; y: number };
    expect(Math.hypot(nTxt.x - cx, nTxt.y - cy)).toBeLessThan(r);
  });
});
