import { describe, expect, it } from 'vitest';
import { DEFAULT_SPEED, formatClock, formatDuration, formatLength, loadSpeed, planPlot, sortStrokes, SPEED_KEY } from '../src/export/plan';
import { prepareScene, type FontSet } from '../src/export/outlines';
import { flattenPath } from '../src/export/offset';
import { buildScene } from '../src/scene/buildScene';
import type { Pen } from '../src/scene/pens';
import type { PathPrim, Scene } from '../src/scene/types';
import { cityData, cityProject } from './fixture';

const pen = (id: string): Pen => ({ id, name: id, color: '#111111', tipMm: 0.3, kind: 'technical' });
const line = (d: string, penId: string): PathPrim => ({ kind: 'path', d, color: '#111111', pen: penId, mode: 'stroke', widthMm: 0.3 });
const scene = (...prims: PathPrim[]): Scene => ({ widthMm: 100, heightMm: 100, paper: '#fff', prims });
const L = (...xy: number[]) => Float64Array.from(xy);

describe('sorting lines for the plotter', () => {
  it('goes to the nearest line end next, drawing a line backwards when its far end is nearer', () => {
    const out = sortStrokes([L(50, 0, 60, 0), L(30, 0, 20, 0), L(1, 0, 10, 0)]);
    expect(out.map((l) => [...l])).toEqual([[1, 0, 10, 0], [20, 0, 30, 0], [50, 0, 60, 0]]);
  });
  it('uses every line exactly once', () => {
    const lines = Array.from({ length: 500 }, (_, i) => L((i * 37) % 300, (i * 91) % 400, ((i * 37) % 300) + 3, ((i * 91) % 400) + 2));
    const out = sortStrokes(lines);
    expect(out).toHaveLength(500);
    const key = (l: Float64Array) => [l[0], l[1], l[2], l[3]].join() ;
    const seen = new Set(out.map((l) => (l[0]! <= l[2]! ? key(l) : key(L(l[2]!, l[3]!, l[0]!, l[1]!)))));
    expect(seen.size).toBe(500);
  });
});

describe('the plot plan', () => {
  const speed = { drawMmS: 10, travelMmS: 100, liftS: 1, swapS: 5 };

  it('times every move: travel and lift, drawing, a pen swap, and the trip home', () => {
    const plan = planPlot(scene(line('M10 0L20 0', 'a'), line('M20 0L30 0', 'a'), line('M0 10L0 20', 'b')), [pen('a'), pen('b')], speed);
    const hop = Math.hypot(30, 10);
    expect(plan.swaps).toBe(1);
    expect(plan.lifts).toBe(2); // the second line of pen a starts where the first ends: no lift
    expect(plan.drawMm).toBeCloseTo(30);
    expect(plan.travelMm).toBeCloseTo(10 + hop + 20);
    expect(plan.totalS).toBeCloseTo((10 / 100 + 1) + 1 + 1 + 5 + (hop / 100 + 1) + 1 + 20 / 100);
    const [a, b] = plan.pens;
    expect(a!.strokes.map((s) => [s.t0, s.t1])).toEqual([[1.1, 2.1], [2.1, 3.1]].map(([x, y]) => [expect.closeTo(x!), expect.closeTo(y!)]));
    expect(b!.start).toBeCloseTo(8.1);
  });

  it('goes through the pens in palette order and skips pens with nothing to draw', () => {
    const plan = planPlot(scene(line('M0 0L1 0', 'c'), line('M0 0L1 0', 'a')), [pen('a'), pen('b'), pen('c')]);
    expect(plan.pens.map((p) => p.pen.id)).toEqual(['a', 'c']);
    expect(plan.swaps).toBe(1);
  });

  it('closed shapes are drawn all the way round', () => {
    const plan = planPlot(scene(line('M0 0L10 0L10 10Z', 'a')), [pen('a')]);
    expect(plan.drawMm).toBeCloseTo(20 + Math.hypot(10, 10));
  });

  it('a real map: sorting cuts pen-up travel well below drawing the lines in the order they come', () => {
    const fake = { unitsPerEm: 1000, charToGlyph: () => ({ advanceWidth: 500, getPath: () => ({ toPathData: () => 'M0 0L1 1', commands: [] }) }) };
    const p = cityProject();
    const out = prepareScene(buildScene(p, cityData()), 'plotter', { sans: fake, serif: fake } as unknown as FontSet, { pens: p.pens });
    const plan = planPlot(out, p.pens);
    expect(plan.drawMm).toBeGreaterThan(1000);
    expect(plan.totalS).toBeGreaterThan(plan.drawMm / DEFAULT_SPEED.drawMmS);
    let naive = 0, pos = [0, 0];
    for (const x of out.prims) if (x.kind === 'path') for (const s of flattenPath(x.d)) { naive += Math.hypot(s.pts[0]![0] - pos[0]!, s.pts[0]![1] - pos[1]!); pos = s.pts[s.closed ? 0 : s.pts.length - 1]!; }
    expect(plan.travelMm).toBeLessThan(naive * 0.6);
  });
});

describe('plotter speed settings', () => {
  it('start from the defaults and keep only sensible saved values', () => {
    expect(loadSpeed({ getItem: () => null })).toEqual(DEFAULT_SPEED);
    expect(loadSpeed({ getItem: () => '{"drawMmS":25,"travelMmS":-4,"liftS":"x"}' })).toEqual({ ...DEFAULT_SPEED, drawMmS: 25 });
    expect(loadSpeed({ getItem: () => 'not json' })).toEqual(DEFAULT_SPEED);
    expect(loadSpeed({ getItem: (k) => (k === SPEED_KEY ? '{"swapS":30}' : null) }).swapS).toBe(30);
  });
});

describe('formatting', () => {
  it('durations, clocks and lengths', () => {
    expect(formatDuration(20)).toBe('under a minute');
    expect(formatDuration(47 * 60 + 10)).toBe('about 47 min');
    expect(formatDuration(2 * 3600 + 5 * 60)).toBe('about 2 h 05 min');
    expect(formatClock(65)).toBe('1:05');
    expect(formatClock(3725)).toBe('1:02:05');
    expect(formatLength(820)).toBe('820 mm');
    expect(formatLength(38_400)).toBe('38 m');
    expect(formatLength(2_450)).toBe('2.5 m');
  });
});
