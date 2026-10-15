import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'opentype.js';
import { HATCH_ANGLE_DEG, HATCH_FACTOR, hatchPath } from '../src/export/hatch';
import { flattenPath, type Pt } from '../src/export/offset';
import { textToPath, type FontSet } from '../src/export/outlines';
import type { TextPrim } from '../src/scene/types';

type Seg = { a: Pt; b: Pt };
const segs = (d: string): Seg[] => flattenPath(d).map((s) => ({ a: s.pts[0]!, b: s.pts[1]! }));
const len = (s: Seg) => Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
const total = (d: string) => segs(d).reduce((a, s) => a + len(s), 0);
const square = (x: number, y: number, w: number, h = w) => `M${x} ${y}h${w}v${h}h${-w}Z`;
const area = (d: string) => flattenPath(d).reduce((a, s) => {
  let sum = 0;
  for (let i = 0; i < s.pts.length; i++) { const [x1, y1] = s.pts[i]!; const [x2, y2] = s.pts[(i + 1) % s.pts.length]!; sum += x1 * y2 - x2 * y1; }
  return a + Math.abs(sum) / 2;
}, 0);

describe('hatchPath', () => {
  it('fills a square with parallel lines at the spacing: total length is about area / spacing', () => {
    const d = hatchPath(square(0, 0, 10), 0.5, 0);
    expect(segs(d)).toHaveLength(20);
    expect(total(d)).toBeCloseTo(200, 3);
    for (const s of segs(d)) { expect(s.a[1]).toBeCloseTo(s.b[1], 6); expect(len(s)).toBeCloseTo(10, 6); }
  });
  it('lines are exactly one spacing apart', () => {
    const ys = segs(hatchPath(square(0, 0, 10), 0.5, 0)).map((s) => s.a[1]).sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i++) expect(ys[i]! - ys[i - 1]!).toBeCloseTo(0.5, 6);
  });
  it('runs at the angle asked for (45 degrees by default)', () => {
    expect(HATCH_ANGLE_DEG).toBe(45);
    for (const s of segs(hatchPath(square(0, 0, 10), 0.7))) {
      expect(Math.abs(s.b[0] - s.a[0])).toBeCloseTo(Math.abs(s.b[1] - s.a[1]), 2);
    }
    const flat = segs(hatchPath(square(0, 0, 10), 0.7, 90));
    for (const s of flat) expect(s.a[0]).toBeCloseTo(s.b[0], 6); // vertical
  });
  it('covers the area at any angle: total length * spacing is about the area', () => {
    for (const angle of [0, 30, 45, 90, 135]) expect((total(hatchPath(square(0, 0, 20, 12), 0.4, angle)) * 0.4) / 240).toBeCloseTo(1, 1);
  });
  it('leaves a hole empty (even-odd)', () => {
    const d = `${square(0, 0, 20)}${square(5, 5, 10)}`; // a 10 mm hole in a 20 mm square
    expect(total(hatchPath(d, 0.5, 0)) * 0.5).toBeCloseTo(400 - 100, 0);
    for (const s of segs(hatchPath(d, 0.5, 0))) {
      const midY = s.a[1];
      const insideHole = midY > 5 && midY < 15;
      if (insideHole) expect(len(s)).toBeCloseTo(5, 3); // two pieces either side of the hole, 5 mm each
    }
  });
  it('stays inside a concave shape', () => {
    const l = 'M0 0H20V8H8V20H0Z'; // an L
    expect((total(hatchPath(l, 0.4, 0)) * 0.4) / area(l)).toBeCloseTo(1, 1);
    for (const s of segs(hatchPath(l, 0.4, 0))) {
      for (const [x, y] of [s.a, s.b]) expect(x <= 20 + 1e-6 && x >= -1e-6 && y >= -1e-6 && y <= 20 + 1e-6).toBe(true);
      if (s.a[1] > 8) expect(Math.max(s.a[0], s.b[0])).toBeLessThanOrEqual(8 + 1e-6);
    }
  });
  it('a wider spacing gives fewer lines', () => {
    expect(segs(hatchPath(square(0, 0, 10), 2, 0)).length).toBeLessThan(segs(hatchPath(square(0, 0, 10), 0.5, 0)).length);
  });
  it('gives nothing for empty input, a line, or a bad spacing', () => {
    expect(hatchPath('', 0.5)).toBe('');
    expect(hatchPath('M0 0L10 10', 0.5)).toBe('');
    expect(hatchPath(square(0, 0, 10), 0)).toBe('');
    expect(hatchPath(square(0, 0, 10), -1)).toBe('');
  });
  it('density: solid overlaps a little, light is a tint', () => {
    expect(HATCH_FACTOR.solid).toBeLessThan(1);
    expect(HATCH_FACTOR.medium).toBeGreaterThan(HATCH_FACTOR.solid);
    expect(HATCH_FACTOR.light).toBeGreaterThan(HATCH_FACTOR.medium);
  });
});

describe('hatching real letters', () => {
  const b = readFileSync('node_modules/@fontsource/inter/files/inter-latin-400-normal.woff');
  const font = parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  const fonts = { sans: font, serif: font } as unknown as FontSet;
  const word = (text: string): TextPrim => ({ kind: 'text', text, x: 10, y: 60, anchor: 'start', sizeMm: 40, trackingMm: 0, fontFamily: 'x', fontKey: 'sans', color: '#000' });

  it('an O is hatched around its counter, not through it', () => {
    const d = textToPath(word('O'), fonts);
    const lines = hatchPath(d, 0.3, 0);
    expect(total(lines) * 0.3).toBeLessThan(area(d)); // area() sums both contours of the O, so it overstates the ink
    // a line through the middle of the O has a gap in it
    const mid = segs(lines).filter((s) => Math.abs(s.a[1] - 40) < 0.2);
    expect(mid.length).toBeGreaterThanOrEqual(2); // left wall and right wall
  });
  it('a solid-hatched letter covers about its inked area', () => {
    const d = textToPath(word('I'), fonts);
    expect((total(hatchPath(d, 0.2, 0)) * 0.2) / area(d)).toBeCloseTo(1, 1);
  });
  it('every hatch line stays within the letters\' bounding box', () => {
    const d = textToPath(word('AVE'), fonts);
    const pts = flattenPath(d).flatMap((s) => s.pts);
    const [x0, x1] = [Math.min(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[0]))];
    const [y0, y1] = [Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[1]))];
    for (const s of segs(hatchPath(d, 0.4))) for (const [x, y] of [s.a, s.b]) {
      expect(x).toBeGreaterThanOrEqual(x0 - 0.01); expect(x).toBeLessThanOrEqual(x1 + 0.01);
      expect(y).toBeGreaterThanOrEqual(y0 - 0.01); expect(y).toBeLessThanOrEqual(y1 + 0.01);
    }
  });
});

describe('closed letter outlines', () => {
  const b = readFileSync('node_modules/@fontsource/inter/files/inter-latin-400-normal.woff');
  const font = parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  const fonts = { sans: font, serif: font } as unknown as FontSet;
  const word = (text: string, rotate?: number): TextPrim => ({ kind: 'text', text, x: 10, y: 60, anchor: 'start', sizeMm: 40, trackingMm: 0, fontFamily: 'x', fontKey: 'sans', color: '#000', ...(rotate ? { rotate } : {}) });
  it('every contour of every letter is closed, so a stroked outline has no gap', () => {
    for (const rotate of [undefined, 30]) {
      const d = textToPath(word('OKR8', rotate), fonts);
      const contours = d.split('M').length - 1;
      expect(contours).toBeGreaterThanOrEqual(8);
      expect((d.match(/Z/g) ?? []).length).toBe(contours);
      expect(flattenPath(d).every((s) => s.closed)).toBe(true);
    }
  });
  it('each close comes before the next contour starts', () => {
    expect(textToPath(word('OO'), fonts)).toMatch(/^(M[^MZ]*Z)+$/);
  });
});
