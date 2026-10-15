import { describe, expect, it } from 'vitest';
import { flattenPath, offsetPath, offsetPolyline, passCount, passOffsets, type Pt } from '../src/export/offset';
import { prepareScene, PLOTTER_PEN_MM, type FontSet } from '../src/export/outlines';
import { sceneToSvg } from '../src/export/svg';
import { buildScene } from '../src/scene/buildScene';
import { defaultProject } from '../src/scene/project';
import { sampleTrack } from '../src/sample';
import type { PathPrim, Scene } from '../src/scene/types';

const fake = { unitsPerEm: 1000, charToGlyph: () => ({ advanceWidth: 500, getPath: () => ({ toPathData: () => 'M0 0L1 1', commands: [{ type: 'M', x: 0, y: 0 }, { type: 'L', x: 1, y: 1 }] }) }) };
const fonts = { sans: fake, serif: fake } as unknown as FontSet;
const colorOf = (p: ReturnType<typeof defaultProject>, id: string) => p.pens.find((x) => x.id === id)!.color;
const paths = (s: Scene) => s.prims.filter((p): p is PathPrim => p.kind === 'path');
const nums = (d: string) => (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);

describe('passes for a heavy line', () => {
  it('a line no heavier than ~1.5 pens is one pass', () => {
    expect(passCount(0.3, 0.3)).toBe(1);
    expect(passCount(0.12, 0.3)).toBe(1); // thinner than the pen: still one pass, at the pen width
    expect(passCount(0.4, 0.3)).toBe(1);
  });
  it('heavier lines are repeated passes', () => {
    expect(passCount(0.9, 0.3)).toBe(3);
    expect(passCount(0.6, 0.3)).toBe(2);
    expect(passCount(0.9, 0.2)).toBe(5);
  });
  it('offsets are centered, evenly spaced, and cover the original width without gaps', () => {
    expect(passOffsets(0.9, 0.3).map((v) => +v.toFixed(6))).toEqual([-0.3, 0, 0.3]);
    expect(passOffsets(0.3, 0.3)).toEqual([0]);
    for (const [w, pen] of [[0.9, 0.3], [0.6, 0.3], [0.9, 0.25], [1.5, 0.4], [0.7, 0.2]] as const) {
      const o = passOffsets(w, pen);
      expect(o.reduce((a, b) => a + b, 0)).toBeCloseTo(0, 9); // symmetric
      if (o.length > 1) {
        const pitch = o[1]! - o[0]!;
        expect(pitch).toBeLessThanOrEqual(pen + 1e-9); // passes overlap, so no gaps
        expect(o[o.length - 1]! - o[0]! + pen).toBeLessThanOrEqual(w + 1e-9); // never wider than the original
      }
    }
  });
});

describe('flattenPath', () => {
  it('reads absolute and relative lines, h/v, and closing', () => {
    const [s] = flattenPath('M10 10h10v10H10Z');
    expect(s!.closed).toBe(true);
    expect(s!.pts).toEqual([[10, 10], [20, 10], [20, 20], [10, 20]]);
  });
  it('treats extra coordinate pairs after M as line-tos, and keeps separate sub-paths apart', () => {
    const subs = flattenPath('M0 0 5 5 10 0M20 20L30 30');
    expect(subs).toHaveLength(2);
    expect(subs[0]!.pts).toEqual([[0, 0], [5, 5], [10, 0]]);
  });
  it('flattens circles drawn with two arcs onto the right radius', () => {
    const [s] = flattenPath('M8 10a2 2 0 1 0 4 0a2 2 0 1 0 -4 0Z'); // circle r=2 centered (10, 10)
    expect(s!.pts.length).toBeGreaterThan(16);
    for (const [x, y] of s!.pts) expect(Math.hypot(x - 10, y - 10)).toBeCloseTo(2, 3);
  });
  it('flattens cubic and quadratic curves through their end points', () => {
    const c = flattenPath('M0 0C0 10 10 10 10 0')[0]!.pts;
    expect(c[0]).toEqual([0, 0]);
    expect(c[c.length - 1]![0]).toBeCloseTo(10, 6);
    expect(Math.max(...c.map((p) => p[1]))).toBeGreaterThan(6); // it bulges
    const q = flattenPath('M0 0Q5 10 10 0')[0]!.pts;
    expect(q[q.length - 1]).toEqual([10, 0]);
  });
  it('ignores empty or odd input without throwing', () => {
    expect(flattenPath('')).toEqual([]);
    expect(flattenPath('M5 5')).toEqual([]);
    expect(() => flattenPath('M0 0L')).not.toThrow();
  });
});

describe('offsetPolyline', () => {
  it('moves a horizontal line straight up/down, and keeps its length', () => {
    const a = offsetPolyline([[0, 10], [10, 10]], 0.3, false);
    expect(a).toEqual([[0, 9.7], [10, 9.7]]); // left of travel (east) is up on screen
    const b = offsetPolyline([[0, 10], [10, 10]], -0.3, false);
    expect(b).toEqual([[0, 10.3], [10, 10.3]]);
  });
  it('mitres a right-angle corner so the offset stays parallel to both sides', () => {
    const o = offsetPolyline([[0, 0], [10, 0], [10, 10]], 1, false);
    expect(o).toHaveLength(3);
    expect(o[1]![0]).toBeCloseTo(11, 6); // moved out by exactly the offset on both axes
    expect(o[1]![1]).toBeCloseTo(-1, 6);
  });
  it('bevels a hairpin instead of shooting a spike off', () => {
    const o = offsetPolyline([[0, 0], [10, 0], [0, 0.2]], 0.3, false);
    for (const [x] of o) expect(x).toBeLessThan(10 + 0.3 * 2 + 1e-6); // no miter spike past 2x the offset
  });
  it('offsets a closed ring concentrically', () => {
    const ring: Pt[] = Array.from({ length: 73 }, (_, i) => [50 + 10 * Math.cos((i / 72) * 2 * Math.PI), 50 + 10 * Math.sin((i / 72) * 2 * Math.PI)]);
    const out = offsetPolyline(ring, 0.5, true);
    const radii = out.map(([x, y]) => Math.hypot(x - 50, y - 50));
    const mean = radii.reduce((a, b) => a + b, 0) / radii.length;
    expect(Math.abs(mean - 10)).toBeCloseTo(0.5, 1); // 9.5 or 10.5 depending on direction
    expect(Math.max(...radii) - Math.min(...radii)).toBeLessThan(0.05); // still round
  });
  it('is a no-op at zero offset, and survives repeated points', () => {
    expect(offsetPolyline([[0, 0], [5, 0]], 0, false)).toEqual([[0, 0], [5, 0]]);
    expect(() => offsetPolyline([[0, 0], [0, 0], [5, 0]], 0.3, false)).not.toThrow();
  });
  it('offsetPath keeps sub-paths and closed shapes', () => {
    const d = offsetPath('M0 0L10 0M20 0L30 0', 0.3);
    expect(d.match(/M/g)).toHaveLength(2);
    expect(offsetPath('M0 0h10v10h-10Z', 0.3).endsWith('Z')).toBe(true);
  });
});

describe('plotter export draws heavy lines as passes of one pen', () => {
  const base = () => ({ ...defaultProject(), points: sampleTrack() });
  const routeWidth = (p = base()) => p.route.weightMm;

  it('every plotted stroke is exactly the pen width', () => {
    const out = prepareScene(buildScene(base()), 'plotter', fonts);
    expect(paths(out).every((p) => p.mode === 'stroke' && p.widthMm === PLOTTER_PEN_MM)).toBe(true);
  });
  it('the 0.9 mm route becomes 3 passes with a 0.3 mm pen, in the same color', () => {
    const p = base();
    const scene = buildScene(p);
    const before = paths(scene).filter((x) => x.widthMm === routeWidth(p) && x.color === colorOf(p, p.route.pen)).length;
    const out = prepareScene(scene, 'plotter', fonts);
    const after = paths(out).filter((x) => x.color === colorOf(p, p.route.pen)).length;
    expect(after).toBe(before * 3);
  });
  it('the passes lie side by side: they never touch the original width limits', () => {
    const p = base();
    p.route.style = 'solid';
    const out = prepareScene(buildScene(p), 'plotter', fonts);
    const lines = paths(out).filter((x) => x.color === colorOf(p, p.route.pen));
    expect(lines).toHaveLength(3);
    const firstY = lines.map((l) => nums(l.d)[1]!);
    expect(new Set(firstY.map((v) => +v.toFixed(2))).size).toBe(3); // three distinct tracks
  });
  it('a different pen changes the pass count', () => {
    const scene = buildScene(base());
    const count = (penMm: number) => paths(prepareScene(scene, 'plotter', fonts, { penMm })).filter((x) => x.color === colorOf(base(), base().route.pen)).length;
    const one = count(0.9);
    expect(count(0.3)).toBe(one * 3);
    expect(count(0.2)).toBe(Math.round((0.9 / 0.2)) * one);
    expect(paths(prepareScene(scene, 'plotter', fonts, { penMm: 0.5 })).every((x) => x.widthMm === 0.5)).toBe(true);
  });
  it('dashes carry over to each pass', () => {
    const p = base();
    p.route.style = 'dashed';
    const out = prepareScene(buildScene(p), 'plotter', fonts);
    const route = paths(out).filter((x) => x.color === colorOf(p, p.route.pen));
    expect(route.length).toBe(3);
    expect(route.every((x) => x.dash && x.dash.length === 2)).toBe(true);
  });
  it('layers collapse to one per color at the pen width, and each layer is one pen', () => {
    const svg = sceneToSvg(prepareScene(buildScene(base()), 'plotter', fonts));
    const ids = [...svg.matchAll(/<g id="(layer-[^"]+)"/g)].map((m) => m[1]!);
    expect(ids).toHaveLength(2);
    expect(ids.every((i) => i.endsWith('-0.3mm'))).toBe(true);
    expect(svg).not.toContain('stroke-width="0.9"');
  });
  it('print mode is untouched: no extra passes, original widths kept', () => {
    const scene = buildScene(base());
    const out = prepareScene(scene, 'print', fonts);
    expect(paths(out).filter((x) => x.mode === 'stroke').map((x) => x.widthMm)).toContain(0.9);
    expect(paths(out).length).toBe(paths(scene).length + scene.prims.filter((x) => x.kind === 'text').length);
  });
  it('a pen thicker than a line only raises that line to the pen (it cannot draw thinner)', () => {
    const scene = buildScene(base());
    const thin = paths(scene).find((x) => x.mode === 'stroke' && (x.widthMm ?? 1) < 0.5 && x.widthMm! > 0)!;
    expect(passCount(thin.widthMm!, 0.3)).toBe(1);
  });
});
