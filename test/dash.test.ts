import { describe, expect, it } from 'vitest';
import { dashPath, DOT_MM, flattenPath } from '../src/export/offset';

const pieces = (d: string) => flattenPath(d).map((s) => s.pts);
const len = (pts: [number, number][]) => pts.reduce((a, p, i) => (i ? a + Math.hypot(p[0] - pts[i - 1]![0], p[1] - pts[i - 1]![1]) : 0), 0);

describe('cutting a line into dashes for the plotter', () => {
  it('dash 2, gap 1 along a 10 mm line: dashes at 0-2, 3-5, 6-8, 9-10', () => {
    const p = pieces(dashPath('M0 0L10 0', [2, 1]));
    expect(p.map((x) => [x[0]![0], x.at(-1)![0]])).toEqual([[0, 2], [3, 5], [6, 8], [9, 10]]);
  });

  it('the pattern runs on round corners, as SVG draws it', () => {
    const p = pieces(dashPath('M0 0L3 0L3 3', [4, 1]));
    expect(p[0]).toEqual([[0, 0], [3, 0], [3, 1]]);
    expect(len(p[0]!)).toBeCloseTo(4);
  });

  it('a dot pattern taps the pen down at every step', () => {
    const p = pieces(dashPath('M0 0L10 0', [0, 2.5]));
    expect(p.map((x) => x[0]![0])).toEqual([0, 2.5, 5, 7.5, 10]);
    for (const x of p) expect(len(x)).toBeCloseTo(DOT_MM);
  });

  it('closed shapes are dashed all the way round', () => {
    const total = pieces(dashPath('M0 0L10 0L10 10L0 10Z', [1, 1])).reduce((a, x) => a + len(x), 0);
    expect(total).toBeCloseTo(20);
  });

  it('an empty or zero pattern leaves the line whole', () => {
    expect(dashPath('M0 0L10 0', [])).toBe('M0 0L10 0');
    expect(dashPath('M0 0L10 0', [0, 0])).toBe('M0 0L10 0');
  });
});
