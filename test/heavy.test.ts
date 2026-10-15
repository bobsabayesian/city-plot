import { describe, expect, it } from 'vitest';
import { passCount, passOffsets, summarizePasses } from '../src/export/offset';
import { tipFor } from '../src/export/outlines';
import { buildScene } from '../src/scene/buildScene';
import { cityData, cityProject } from './fixture';

describe('forced passes', () => {
  it('a thin line asked for two passes gets two, centered and overlapping by 20%', () => {
    const o = passOffsets(0.25, 0.3, 2);
    expect(o).toHaveLength(2);
    expect(o[0]).toBeCloseTo(-o[1]!, 9);
    expect(o[1]! - o[0]!).toBeCloseTo(0.24, 9);
  });
  it('a minimum never reduces the passes a heavy line already needs', () => {
    expect(passCount(0.78, 0.3, 2)).toBe(3);
    expect(passOffsets(0.78, 0.3, 2)).toHaveLength(3);
    expect(passCount(0.12, 0.3, 2)).toBe(2);
    expect(passCount(0.12, 0.3)).toBe(1);
  });
});

describe('summarizePasses (for the pens panel)', () => {
  it('lists each heavy width once, with its passes', () => {
    const prims = [
      { kind: 'path', mode: 'stroke', widthMm: 0.12 },
      { kind: 'path', mode: 'stroke', widthMm: 0.25, minPasses: 2 },
      { kind: 'path', mode: 'stroke', widthMm: 0.78 },
      { kind: 'path', mode: 'stroke', widthMm: 0.78 },
      { kind: 'path', mode: 'fill' },
      { kind: 'text' },
    ];
    expect(summarizePasses(prims, 0.3)).toEqual([
      { widthMm: 0.25, passes: 2, forced: true },
      { widthMm: 0.78, passes: 3, forced: false },
    ]);
  });
  it('lists nothing when every line is a single pass', () => {
    expect(summarizePasses([{ kind: 'path', mode: 'stroke', widthMm: 0.12 }], 0.3)).toEqual([]);
  });
  it('for a real design, lists the thick street layers with the passes of their own pens', () => {
    const p = cityProject();
    const scene = buildScene(p, cityData());
    const list = summarizePasses(scene.prims, (x) => tipFor(x as { pen?: string }, { pens: p.pens }));
    expect(list).toEqual([
      { widthMm: 0.54, passes: 2, forced: false },
      { widthMm: 0.78, passes: 3, forced: false },
    ]);
  });
});
