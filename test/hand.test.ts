import { describe, expect, it } from 'vitest';
import { DRIFT_MM, handLine, handPrim, TREMOR_MM } from '../src/scene/hand';
import { flattenPath } from '../src/export/offset';
import { buildScene, viewOf } from '../src/scene/buildScene';
import { applyLook, lookById } from '../src/scene/looks';
import type { XY } from '../src/geo/clip';
import type { PathPrim } from '../src/scene/types';
import { cityData, cityProject } from './fixture';

const h = (amount: number, seed = 1) => ({ amount, seed });
/** distance from a point to the segment a-b */
const toSeg = ([x, y]: XY, [ax, ay]: XY, [bx, by]: XY) => {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
};
const straight: XY[] = [[10, 50], [190, 50]];

describe('drawing a line by hand', () => {
  it('a steady hand changes nothing', () => {
    expect(handLine(straight, h(0))).toBe(straight);
  });

  it('wobbles, but never further than the drift and tremor allow', () => {
    const out = handLine(straight, h(1));
    const dev = out.map((p) => toSeg(p, straight[0]!, straight[1]!));
    expect(Math.max(...dev)).toBeGreaterThan(0.15);
    expect(Math.max(...dev)).toBeLessThanOrEqual(Math.SQRT2 * DRIFT_MM + TREMOR_MM + 1e-9);
    // a long line is bent along its length, not only moved at its ends
    expect(out.length).toBeGreaterThan(150);
  });

  it('half the hand, about half the wobble', () => {
    const dev = (a: number) => Math.max(...handLine(straight, h(a)).map((p) => toSeg(p, straight[0]!, straight[1]!)));
    expect(dev(0.5)).toBeCloseTo(dev(1) / 2, 1);
  });

  it('the same seed draws the same line; another take draws another', () => {
    expect(handLine(straight, h(1, 3))).toEqual(handLine(straight, h(1, 3)));
    expect(handLine(straight, h(1, 4))).not.toEqual(handLine(straight, h(1, 3)));
  });

  it('streets that meet still meet: without tremor two lines through a point move it the same way', () => {
    const a = handLine([[0, 20], [40, 20]], h(1), false);
    const b = handLine([[20, 0], [20, 40]], h(1), false);
    const mid = (l: XY[]) => l[20]!; // 1 mm steps: both are at (20, 20) on their 21st point
    expect(mid(a)[0]).toBeCloseTo(mid(b)[0], 6);
    expect(mid(a)[1]).toBeCloseTo(mid(b)[1], 6);
  });
});

describe('the map drawn by hand', () => {
  const strokes = (amount: number) => {
    const p = cityProject((q) => { q.hand = { amount, seed: 1 }; });
    return { p, prims: buildScene(p, cityData()).prims };
  };

  it('off by default, and a steady hand leaves the map exactly as it was', () => {
    expect(cityProject().hand.amount).toBe(0);
    expect(strokes(0).prims).toEqual(buildScene(cityProject(), cityData()).prims);
  });

  it('moves the map lines but never the text, the north arrow or the landmarks', () => {
    const steady = strokes(0).prims, shaky = strokes(1).prims;
    const map = (ps: typeof steady) => ps.filter((x) => x.kind === 'path' && ['minor', 'major', 'water', 'parks', 'buildings'].includes(x.part ?? '')).map((x) => (x as PathPrim).d);
    expect(map(shaky)).not.toEqual(map(steady));
    const rest = (ps: typeof steady) => ps.filter((x) => x.kind === 'text' || ['north', 'landmarks', 'title', 'info', 'location'].includes(x.part ?? ''));
    expect(rest(shaky)).toEqual(rest(steady));
  });

  it('nothing wanders off the map', () => {
    const { p, prims } = strokes(1);
    const fr = viewOf(p)!.frame;
    for (const x of prims) {
      if (x.kind !== 'path' || !x.part || ['border', 'north', 'landmarks'].includes(x.part)) continue;
      for (const s of flattenPath(x.d)) for (const [px, py] of s.pts) {
        expect(px).toBeGreaterThanOrEqual(fr.x - 1e-6);
        expect(px).toBeLessThanOrEqual(fr.x + fr.w + 1e-6);
        expect(py).toBeGreaterThanOrEqual(fr.y - 1e-6);
        expect(py).toBeLessThanOrEqual(fr.y + fr.h + 1e-6);
      }
    }
  });

  it('filled areas drift with their outlines but do not tremble', () => {
    const fill: PathPrim = { kind: 'path', d: 'M10 10L60 10L60 60L10 60Z', color: '#000', mode: 'fill' };
    const line: PathPrim = { ...fill, mode: 'stroke', widthMm: 0.3 };
    const a = flattenPath(handPrim(fill, h(1)).d)[0]!.pts;
    const b = flattenPath(handPrim(line, h(1)).d)[0]!.pts;
    // the outline trembles a little either side of the fill's edge, never more than the tremor
    for (const p of b.filter((_, i) => i % 7 === 0)) {
      const near = Math.min(...a.map((q, i) => (i ? toSeg(p, a[i - 1]!, q) : Infinity)));
      expect(near).toBeLessThanOrEqual(TREMOR_MM + 0.05);
    }
  });

  it('Kraft is drawn by hand, the other looks are steady', () => {
    const amountFor = (id: string) => { const p = cityProject(); applyLook(p, lookById(id)!); return p.hand.amount; };
    expect(amountFor('kraft')).toBeGreaterThan(0);
    for (const id of ['classic', 'engraved', 'blueprint', 'nolli', 'minimal']) expect(amountFor(id)).toBe(0);
  });
});
