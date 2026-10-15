import { describe, expect, it } from 'vitest';
import { effectiveWidth, flattenPath, offsetPath, offsetPolyline, PASS_OVERLAP, passCount, passOffsets, passWidth, type Pt } from '../src/export/offset';
import { prepareScene, PLOTTER_PEN_MM, type FontSet } from '../src/export/outlines';
import { sceneToSvg } from '../src/export/svg';
import { buildScene } from '../src/scene/buildScene';
import type { Project } from '../src/scene/project';
import { cityProject, cityData } from './fixture';
import type { PathPrim, Scene } from '../src/scene/types';

const fake = { unitsPerEm: 1000, charToGlyph: () => ({ advanceWidth: 500, getPath: () => ({ toPathData: () => 'M0 0L1 1', commands: [{ type: 'M', x: 0, y: 0 }, { type: 'L', x: 1, y: 1 }] }) }) };
const fonts = { sans: fake, serif: fake } as unknown as FontSet;
const paths = (s: Scene) => s.prims.filter((p): p is PathPrim => p.kind === 'path');
const nums = (d: string) => (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);

describe('passes for a heavy line', () => {
  it('a line no heavier than the pen is one pass, at the pen width', () => {
    expect(passCount(0.3, 0.3)).toBe(1);
    expect(passCount(0.12, 0.3)).toBe(1); // thinner than the pen: still one pass
    expect(passCount(0.4, 0.3)).toBe(1);
  });
  it('N passes overlap by 20% of the pen, so they draw 0.3, 0.54, 0.78, 1.02 mm with a 0.3 mm pen', () => {
    expect(PASS_OVERLAP).toBe(0.2);
    expect([1, 2, 3, 4].map((n) => +passWidth(n, 0.3).toFixed(6))).toEqual([0.3, 0.54, 0.78, 1.02]);
    expect([0.3, 0.54, 0.78, 1.02].map((w) => passCount(w, 0.3))).toEqual([1, 2, 3, 4]);
    expect(passWidth(3, 0.5)).toBeCloseTo(1.3, 9);
  });
  it('a width in between is the nearest whole number of passes', () => {
    expect(passCount(0.45, 0.3)).toBe(2);
    expect(passCount(0.6, 0.3)).toBe(2);
    expect(passCount(0.7, 0.3)).toBe(3);
    expect(passCount(0.9, 0.3)).toBe(4);
    expect(passCount(0.78, 0.2)).toBe(5);
    expect(passCount(2, 0.3)).toBe(8);
  });
  it('effectiveWidth is what the passes really draw, and drawing it again changes nothing', () => {
    expect(effectiveWidth(0.7, 0.3)).toBeCloseTo(0.78, 9);
    expect(effectiveWidth(0.1, 0.3)).toBe(0.3);
    for (const [w, pen] of [[0.9, 0.3], [0.6, 0.25], [1.5, 0.4], [0.7, 0.2], [0.05, 0.5]] as const) {
      const e = effectiveWidth(w, pen);
      expect(passCount(e, pen)).toBe(passCount(w, pen));
      expect(effectiveWidth(e, pen)).toBeCloseTo(e, 9);
    }
  });
  it('a minimum raises the count of a thin line and never lowers a heavy one', () => {
    expect(passCount(0.12, 0.3, 2)).toBe(2);
    expect(passCount(0.78, 0.3, 2)).toBe(3);
  });
  it('offsets are centered, and neighbours are 80% of a pen apart so they overlap by 20%', () => {
    expect(passOffsets(0.78, 0.3).map((v) => +v.toFixed(6))).toEqual([-0.24, 0, 0.24]);
    expect(passOffsets(0.3, 0.3)).toEqual([0]);
    for (const [w, pen] of [[0.9, 0.3], [0.6, 0.3], [0.9, 0.25], [1.5, 0.4], [0.7, 0.2]] as const) {
      const o = passOffsets(w, pen);
      expect(o.length).toBe(passCount(w, pen));
      expect(o.reduce((a, b) => a + b, 0)).toBeCloseTo(0, 9); // symmetric
      if (o.length > 1) {
        expect(o[1]! - o[0]!).toBeCloseTo(0.8 * pen, 9);
        expect(o[o.length - 1]! - o[0]! + pen).toBeCloseTo(passWidth(o.length, pen), 9); // together they span exactly the line
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
  /** Only map lines: no text, landmarks or fills, so every black stroke belongs to a street or a building. */
  const base = (edit: (p: Project) => void = () => {}) => cityProject((p) => {
    p.features.enabled = false; p.text.title.visible = false; p.text.location.visible = false; p.text.info.visible = false; p.showWatermark = false;
    p.layers.parks.fill = 'off'; p.layers.water.fill = 'off';
    edit(p);
  });
  const black = (p: Project) => p.pens.find((x) => x.id === 'black')!.color;
  const blackStrokes = (out: Scene, p: Project) => paths(out).filter((x) => x.color === black(p));

  it('every plotted stroke is exactly the pen width', () => {
    const out = prepareScene(buildScene(base(), cityData()), 'plotter', fonts);
    expect(paths(out).every((p) => p.mode === 'stroke' && p.widthMm === PLOTTER_PEN_MM)).toBe(true);
  });
  it('the preview draws each line as thick as its passes make it', () => {
    const p = base();
    p.layers.major.weightMm = 0.7; // between 2 and 3 passes: 3 is nearer
    const widths = paths(buildScene(p, cityData())).map((x) => x.widthMm);
    expect(widths).toContain(0.78);
    expect(widths).not.toContain(0.7);
  });
  it('a 0.78 mm road is 3 passes, a 0.54 mm street 2, a 0.3 mm one 1: all the same pen and color', () => {
    const p = base();
    const scene = buildScene(p, cityData());
    expect(blackStrokes(scene, p).map((x) => x.widthMm).sort()).toEqual([0.3, 0.3, 0.54, 0.78]); // buildings, minor, secondary, major
    const out = prepareScene(scene, 'plotter', fonts);
    expect(blackStrokes(out, p)).toHaveLength(1 + 1 + 2 + 3);
  });
  it('the passes lie side by side, 0.24 mm apart for a 0.3 mm pen', () => {
    const p = base((q) => { for (const k of ['parks', 'water', 'buildings', 'minor', 'secondary'] as const) q.layers[k].enabled = false; });
    const out = prepareScene(buildScene(p, cityData()), 'plotter', fonts);
    const lines = blackStrokes(out, p);
    expect(lines).toHaveLength(3);
    // the road runs diagonally, so passes are shifted in both x and y: compare the distance from the middle one
    const [a, b, c] = lines.map((l) => nums(l.d).slice(0, 2));
    const gap = (u: number[], v: number[]) => Math.hypot(u[0]! - v[0]!, u[1]! - v[1]!);
    expect(gap(a!, b!)).toBeCloseTo(0.24, 1);
    expect(gap(b!, c!)).toBeCloseTo(0.24, 1);
  });
  it('a finer pen needs more passes for the same line, a coarser one fewer', () => {
    const count = (tipMm: number) => {
      const p = base((q) => { q.pens[0]!.tipMm = tipMm; });
      return blackStrokes(prepareScene(buildScene(p, cityData()), 'plotter', fonts, { pens: p.pens }), p).length;
    };
    expect(count(0.2)).toBeGreaterThan(count(0.3));
    expect(count(0.5)).toBeLessThan(count(0.3));
  });
  it('the pass count follows the layer\'s own pen', () => {
    const p = base((q) => { q.layers.major.pen = 'green'; q.pens[1]!.tipMm = 0.2; q.layers.parks.enabled = false; });
    const major = paths(prepareScene(buildScene(p, cityData()), 'plotter', fonts, { pens: p.pens })).filter((x) => x.pen === 'green' && x.widthMm === 0.2);
    expect(major).toHaveLength(passCount(effectiveWidth(0.78, 0.2), 0.2));
  });
  it('dashes carry over to each pass', () => {
    const p = base((q) => { q.layers.paths = { enabled: true, pen: 'black', weightMm: 0.54, fill: 'off', style: 'dashed' }; });
    const d = cityData();
    d.layers.paths = { covers: d.layers.major!.covers, ways: [{ id: 'p', closed: false, pts: [47.6, -122.34, 47.61, -122.33] }] };
    const dashed = paths(prepareScene(buildScene(p, d), 'plotter', fonts)).filter((x) => x.dash);
    expect(dashed).toHaveLength(2);
    expect(dashed.every((x) => x.dash!.length === 2)).toBe(true);
  });
  it('layers collapse to one per pen at the pen width', () => {
    const p = base();
    const svg = sceneToSvg(prepareScene(buildScene(p, cityData()), 'plotter', fonts));
    const ids = [...svg.matchAll(/<g id="(layer-[^"]+)"/g)].map((m) => m[1]!);
    expect(ids).toHaveLength(3); // black, green, blue
    expect(ids.every((i) => i.endsWith('-0.3mm'))).toBe(true);
    expect(svg).not.toContain('stroke-width="0.78"');
  });
  it('print mode is untouched: no extra passes, the original widths kept', () => {
    const p = base();
    const scene = buildScene(p, cityData());
    const out = prepareScene(scene, 'print', fonts);
    expect(paths(out).filter((x) => x.mode === 'stroke').map((x) => x.widthMm)).toContain(0.78);
    expect(paths(out).length).toBe(paths(scene).length + scene.prims.filter((x) => x.kind === 'text').length);
  });
});
