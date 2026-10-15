import { describe, expect, it } from 'vitest';
import { arcOfNearest, cutIntervals, formatLevel, pathsWithGaps, placeContourLabels, type LabelOptions } from '../src/topo/contourLabels';
import type { ContourPiece } from '../src/topo/contours';
import type { XY } from '../src/geo/clip';
import { buildScene } from '../src/scene/buildScene';
import { defaultProject } from '../src/scene/project';
import { loadTerrain, latToPx, lonToPx, TILE } from '../src/topo/terrain';
import { viewBBox } from '../src/scene/buildScene';
import { sampleTrack } from '../src/sample';

const frame = { x: 0, y: 0, w: 300, h: 300 };
const base: LabelOptions = {
  intervalM: 250, indexEvery: 1, every: 1, density: 'normal', gap: true, sizePt: 8,
  format: (m) => String(m), frame, obstacles: [], route: [],
};
const line = (level: number, y: number, x0 = 20, x1 = 280, heavy = true): ContourPiece => ({ level, heavy, pts: [[x0, y], [x1, y]] });

describe('formatLevel', () => {
  it('writes meters or feet with thousands separators', () => {
    expect(formatLevel(1850, 'metric')).toBe('1,850');
    expect(formatLevel(1850, 'imperial')).toBe('6,070'); // 6069.9 ft
    expect(formatLevel(250, 'metric')).toBe('250');
    expect(formatLevel(0, 'imperial')).toBe('0');
  });
});

describe('cutIntervals', () => {
  const l: XY[] = [[0, 0], [100, 0]];
  it('takes a gap out of the middle', () => {
    const r = cutIntervals(l, [[40, 60]]);
    expect(r).toHaveLength(2);
    expect(r[0]![0]).toEqual([0, 0]);
    expect(r[0]!.at(-1)![0]).toBeCloseTo(40, 6);
    expect(r[1]![0]![0]).toBeCloseTo(60, 6);
    expect(r[1]!.at(-1)).toEqual([100, 0]);
  });
  it('keeps the vertices that lie in the kept parts', () => {
    const r = cutIntervals([[0, 0], [30, 0], [30, 30], [30, 100]], [[40, 60]]);
    expect(r[0]!.some((p) => p[0] === 30 && p[1] === 0)).toBe(true);
  });
  it('a cut at the start or end leaves one piece; a cut over everything leaves none', () => {
    expect(cutIntervals(l, [[-5, 20]])).toHaveLength(1);
    expect(cutIntervals(l, [[80, 120]])).toHaveLength(1);
    expect(cutIntervals(l, [[-5, 120]])).toHaveLength(0);
  });
  it('merges overlapping cuts and handles several', () => {
    expect(cutIntervals(l, [[30, 50], [45, 60]])).toHaveLength(2);
    expect(cutIntervals(l, [[10, 20], [40, 50], [70, 80]])).toHaveLength(4);
  });
  it('no cuts leaves the line alone', () => {
    expect(cutIntervals(l, [])).toEqual([l]);
  });
  it('the total length removed is the cut length', () => {
    const len = (r: XY[][]) => r.reduce((a, f) => a + f.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - f[i]![0], p[1] - f[i]![1]), 0), 0);
    expect(len(cutIntervals(l, [[40, 60]]))).toBeCloseTo(80, 6);
  });
});

describe('arcOfNearest', () => {
  it('measures how far along the line a point is', () => {
    expect(arcOfNearest([[0, 0], [100, 0]], [30, 5])).toBeCloseTo(30, 6);
    expect(arcOfNearest([[0, 0], [10, 0], [10, 10]], [11, 4])).toBeCloseTo(14, 6);
  });
});

describe('placeContourLabels', () => {
  const lines = [line(1000, 50), line(1250, 150), line(1500, 250)];

  it('puts a number centered on each heavy line, level, with its text', () => {
    const r = placeContourLabels(lines, { ...base, density: 'sparse' });
    expect(r.map((l) => l.text).sort()).toEqual(['1000', '1250', '1500']);
    for (const l of r) {
      expect(l.angle).toBeCloseTo(0, 5);
      expect(l.x).toBeGreaterThan(100);
      expect(l.x).toBeLessThan(200);
    }
  });
  it('never labels regular (non-heavy) lines', () => {
    expect(placeContourLabels([line(1000, 50, 20, 280, false)], base)).toHaveLength(0);
  });
  it('density controls how many numbers a line gets', () => {
    const n = (density: 'sparse' | 'normal' | 'dense') => placeContourLabels([line(1000, 150)], { ...base, density }).length;
    expect(n('sparse')).toBeLessThanOrEqual(n('normal'));
    expect(n('normal')).toBeLessThan(n('dense'));
    expect(n('sparse')).toBeGreaterThanOrEqual(1);
  });
  it('numbers on one level keep their minimum distance apart', () => {
    const r = placeContourLabels([line(1000, 150)], { ...base, density: 'normal' });
    const min = 300 * 0.35;
    for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++)
      expect(Math.hypot(r[i]!.x - r[j]!.x, r[i]!.y - r[j]!.y)).toBeGreaterThanOrEqual(min - 1e-6);
  });
  it('"every 2nd heavy line" skips alternate lines', () => {
    const r = placeContourLabels(lines, { ...base, every: 2, density: 'sparse' });
    expect(r.map((l) => l.text).sort()).toEqual(['1000', '1500']); // 1250 is the odd one out
  });
  it('skips a stretch squeezed between neighboring lines, but not one with room', () => {
    const crowded = [line(1000, 100), { level: 1250, heavy: false, pts: [[20, 101.2], [280, 101.2]] } as ContourPiece];
    expect(placeContourLabels(crowded, { ...base, density: 'sparse' })).toHaveLength(0);
    const roomy = [line(1000, 100), { level: 1250, heavy: false, pts: [[20, 115], [280, 115]] } as ContourPiece];
    expect(placeContourLabels(roomy, { ...base, density: 'sparse' })).toHaveLength(1);
  });
  it('is not stopped by its own line, even a doubled-back part far along it', () => {
    expect(placeContourLabels([line(1000, 100)], base).length).toBeGreaterThan(0);
  });
  it('stays clear of obstacles (a landmark label, the north arrow)', () => {
    const wall = { cx: 150, cy: 150, w: 120, h: 30, ang: 0 };
    const r = placeContourLabels([line(1000, 150)], { ...base, obstacles: [wall], density: 'dense' });
    for (const l of r) expect(Math.abs(l.x - 150) > 60 || Math.abs(l.y - 150) > 15).toBe(true);
    expect(r.length).toBeGreaterThan(0);
    expect(placeContourLabels([line(1000, 150)], { ...base, obstacles: [{ cx: 150, cy: 150, w: 600, h: 40, ang: 0 }] })).toHaveLength(0);
  });
  it('stays off the route', () => {
    const route: XY[] = [[150, 100], [150, 200]]; // crosses the line mid-way
    const r = placeContourLabels([line(1000, 150)], { ...base, route, density: 'dense' });
    expect(r.length).toBeGreaterThan(0);
    for (const l of r) expect(Math.abs(l.x - 150)).toBeGreaterThan(l.w / 2); // the number's box clears the route
  });
  it('keeps numbers off the edge of the map', () => {
    expect(placeContourLabels([line(1000, 1)], base)).toHaveLength(0); // a line along the very edge
    for (const l of placeContourLabels([line(1000, 150, 0, 300)], { ...base, density: 'dense' })) {
      expect(l.x).toBeGreaterThan(10);
      expect(l.x).toBeLessThan(290);
    }
  });
  it('skips a line too short to hold its number', () => {
    expect(placeContourLabels([line(1000, 150, 100, 108)], base)).toHaveLength(0);
  });
  it('writes along the line, upright, whichever way it runs', () => {
    for (const pts of [[[20, 280], [280, 20]], [[280, 280], [20, 20]], [[150, 20], [150, 280]], [[280, 150], [20, 150]]] as XY[][]) {
      const r = placeContourLabels([{ level: 1000, heavy: true, pts }], { ...base, density: 'sparse' });
      expect(r.length).toBeGreaterThanOrEqual(1);
      for (const l of r) expect(Math.cos(l.angle)).toBeGreaterThanOrEqual(-1e-9);
    }
    const diag = placeContourLabels([{ level: 1000, heavy: true, pts: [[20, 280], [280, 20]] }], base)[0]!;
    expect((diag.angle * 180) / Math.PI).toBeCloseTo(-45, 3);
  });
  it('without a gap, the number sits above the line instead of on it', () => {
    const r = placeContourLabels([line(1000, 150)], { ...base, gap: false, density: 'sparse' });
    expect(r).toHaveLength(1);
  });
});

describe('pathsWithGaps', () => {
  const pieces = [line(1000, 100), line(1250, 200), line(750, 50, 20, 280, false)];
  const count = (d: string) => (d.match(/M/g) ?? []).length;
  it('cuts a gap out of a heavy line behind its number, and nothing else', () => {
    const labels = placeContourLabels([pieces[0]!], { ...base, density: 'sparse' });
    const labelsOnFirst = labels.map((l) => ({ ...l, piece: 0 }));
    const out = pathsWithGaps(pieces, labelsOnFirst, 8);
    expect(count(out.index)).toBe(3); // line 1 split in two, line 2 whole
    expect(count(out.regular)).toBe(1); // the regular line is untouched
  });
  it('removes about the width of the number plus a margin', () => {
    const l = { level: 1000, text: '1,000', x: 150, y: 100, angle: 0, piece: 0, arc: 130, w: 12 };
    const out = pathsWithGaps([line(1000, 100)], [l], 8);
    const xs = (out.index.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
    // pieces end and start either side of the cut: 130 -/+ (6 + margin)
    expect(xs).toContain(20);
    expect(xs).toContain(280);
    const cutHalf = 12 / 2 + 8 * (25.4 / 72) * 0.5;
    expect(xs.some((v) => Math.abs(v - (150 - cutHalf)) < 0.05)).toBe(true);
    expect(xs.some((v) => Math.abs(v - (150 + cutHalf)) < 0.05)).toBe(true);
  });
  it('with no numbers, the paths are as before', () => {
    const out = pathsWithGaps(pieces, [], 8);
    expect(count(out.index)).toBe(2);
    expect(count(out.regular)).toBe(1);
  });
});

describe('contour numbers in the poster', () => {
  const cone = async (z: number, tx: number, ty: number) => {
    const cx = lonToPx(-121.7, z);
    const cy = latToPx(46.82, z);
    const out = new Float32Array(TILE * TILE);
    const slope = 2000 / (2 ** z * TILE * 0.0008);
    for (let r = 0; r < TILE; r++) for (let c = 0; c < TILE; c++) out[r * TILE + c] = Math.max(0, 2000 - slope * Math.hypot(tx * TILE + c - cx, ty * TILE + r - cy));
    return out;
  };
  const make = async (edit: (p: ReturnType<typeof defaultProject>) => void = () => {}) => {
    const p = { ...defaultProject(), points: sampleTrack() };
    p.terrain.indexEvery = 2;
    p.terrain.intervalM = 100;
    p.features.enabled = false;
    edit(p);
    const terrain = await loadTerrain(viewBBox(p)!, cone);
    return { p, scene: buildScene(p, terrain) };
  };
  const numbers = (s: ReturnType<typeof buildScene>) => s.prims.filter((x) => x.kind === 'text' && /^[\d,]+$/.test(x.text));
  const indexPath = (s: ReturnType<typeof buildScene>, w: number) => s.prims.find((x) => x.kind === 'path' && x.widthMm === w) as { d: string } | undefined;

  it('are off by default', async () => {
    const { scene } = await make();
    expect(numbers(scene)).toHaveLength(0);
  });
  it('appear on the heavy lines when switched on, tilted along them, in feet by default', async () => {
    const { scene } = await make((p) => { p.terrain.labels.enabled = true; p.terrain.labels.density = 'dense'; });
    const n = numbers(scene);
    expect(n.length).toBeGreaterThan(2);
    for (const t of n) {
      const v = +(t as { text: string }).text.replace(/,/g, '');
      expect(Math.round((v / 3.280839895) / 200 - 0) % 1).toBeLessThan(0.05 + 1); // a heavy level is a multiple of 200 m, shown in feet
    }
    expect(n.some((t) => (t as { rotate?: number }).rotate !== undefined && (t as { rotate?: number }).rotate !== 0)).toBe(true);
  });
  it('use meters when the poster is metric', async () => {
    const { scene } = await make((p) => { p.terrain.labels.enabled = true; p.terrain.labels.density = 'dense'; p.units = 'metric'; });
    const vals = numbers(scene).map((t) => +(t as { text: string }).text.replace(/,/g, ''));
    expect(vals.length).toBeGreaterThan(0);
    for (const v of vals) expect(v % 200).toBe(0);
  });
  it('can be switched off per option: no heavy lines means nothing to number', async () => {
    const { scene } = await make((p) => { p.terrain.labels.enabled = true; p.terrain.indexEvery = 0; });
    expect(numbers(scene)).toHaveLength(0);
  });
  it('the line is broken behind each number by default, and left whole when not', async () => {
    const off = await make();
    const gap = await make((p) => { p.terrain.labels.enabled = true; p.terrain.labels.density = 'dense'; });
    const noGap = await make((p) => { p.terrain.labels.enabled = true; p.terrain.labels.density = 'dense'; p.terrain.labels.gap = false; });
    const w = off.p.terrain.indexWeightMm;
    const subs = (r: typeof off) => (indexPath(r.scene, w)?.d.match(/M/g) ?? []).length;
    expect(subs(gap)).toBeGreaterThan(subs(off));
    expect(subs(noGap)).toBe(subs(off));
  });
  it('more density, more numbers', async () => {
    const n = async (density: 'sparse' | 'normal' | 'dense') => numbers((await make((p) => { p.terrain.labels.enabled = true; p.terrain.labels.density = density; })).scene).length;
    expect(await n('sparse')).toBeLessThanOrEqual(await n('normal'));
    expect(await n('normal')).toBeLessThanOrEqual(await n('dense'));
  });
  it('do not displace landmark labels, which are placed first', async () => {
    const osm = { landmarks: [{ id: 'n1', name: 'Little Peak', kind: 'peak' as const, lat: 46.82, lon: -121.7, ele: 1900 }], water: [], covers: { minLat: 46, maxLat: 47, minLon: -122, maxLon: -121 } };
    const words = async (on: boolean) => {
      const p = { ...defaultProject(), points: sampleTrack() };
      p.terrain.indexEvery = 2; p.terrain.intervalM = 100;
      p.terrain.labels.enabled = on; p.terrain.labels.density = 'dense';
      const terrain = await loadTerrain(viewBBox(p)!, cone);
      return buildScene(p, terrain, osm).prims.flatMap((x) => (x.kind === 'text' && !/^[\d,]+$/.test(x.text) ? [x.text] : []));
    };
    expect(await words(true)).toEqual(await words(false));
  });
  it('take the text color and size they were given', async () => {
    const { scene } = await make((p) => { p.terrain.labels.enabled = true; p.pens[0]!.color = '#336699'; p.terrain.labels.sizePt = 12; });
    const t = numbers(scene)[0] as { color: string; sizeMm: number };
    expect(t.color).toBe('#336699');
    expect(t.sizeMm).toBeCloseTo((12 * 25.4) / 72, 6);
  });
});
