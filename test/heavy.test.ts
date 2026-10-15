import { describe, expect, it } from 'vitest';
import { passCount, passOffsets, summarizePasses } from '../src/export/offset';
import { prepareScene, PLOTTER_PEN_MM, type FontSet } from '../src/export/outlines';
import { sceneToSvg } from '../src/export/svg';
import { buildScene, viewBBox } from '../src/scene/buildScene';
import { defaultProject } from '../src/scene/project';
import { sampleTrack } from '../src/sample';
import { loadTerrain, latToPx, lonToPx, TILE } from '../src/topo/terrain';
import type { PathPrim, Scene } from '../src/scene/types';

const fake = { unitsPerEm: 1000, charToGlyph: () => ({ advanceWidth: 500, getPath: () => ({ toPathData: () => 'M0 0L1 1', commands: [{ type: 'M', x: 0, y: 0 }, { type: 'L', x: 1, y: 1 }] }) }) };
const fonts = { sans: fake, serif: fake } as unknown as FontSet;
const cone = async (z: number, tx: number, ty: number) => {
  const cx = lonToPx(-121.7, z);
  const cy = latToPx(46.82, z);
  const out = new Float32Array(TILE * TILE);
  const slope = 2000 / (2 ** z * TILE * 0.0008);
  for (let r = 0; r < TILE; r++) for (let c = 0; c < TILE; c++) out[r * TILE + c] = Math.max(0, 2000 - slope * Math.hypot(tx * TILE + c - cx, ty * TILE + r - cy));
  return out;
};
const build = async (edit: (p: ReturnType<typeof defaultProject>) => void = () => {}) => {
  const p = { ...defaultProject(), points: sampleTrack() };
  p.terrain.intervalM = 100;
  p.terrain.indexEvery = 2; // the cone only spans a few hundred meters, so a heavy line has to come often
  p.features.enabled = false;
  edit(p);
  const terrain = await loadTerrain(viewBBox(p)!, cone);
  return { p, scene: buildScene(p, terrain) };
};
const colorOf = (p: ReturnType<typeof defaultProject>, id: string) => p.pens.find((x) => x.id === id)!.color;
const paths = (s: Scene) => s.prims.filter((x): x is PathPrim => x.kind === 'path');
const subs = (d: string) => (d.match(/M/g) ?? []).length;

describe('forced passes', () => {
  it('a thin line asked for two passes gets two, clearly apart but overlapping', () => {
    const o = passOffsets(0.25, 0.3, 2);
    expect(o).toHaveLength(2);
    expect(o[0]).toBeCloseTo(-o[1]!, 9); // centered
    const pitch = o[1]! - o[0]!;
    expect(pitch).toBeGreaterThanOrEqual(0.6 * 0.3 - 1e-9); // reads as heavier than one pass
    expect(pitch).toBeLessThanOrEqual(0.3 + 1e-9); // no gap between the passes
  });
  it('a minimum never reduces the passes a heavy line already needs', () => {
    expect(passCount(0.9, 0.3, 2)).toBe(3);
    expect(passOffsets(0.9, 0.3, 2)).toHaveLength(3);
    expect(passCount(0.12, 0.3, 2)).toBe(2);
    expect(passCount(0.12, 0.3)).toBe(1);
  });
  it('the ordinary rule is unchanged when nothing is forced', () => {
    expect(passOffsets(0.9, 0.3).map((v) => +v.toFixed(6))).toEqual([-0.3, 0, 0.3]);
    expect(passOffsets(0.3, 0.3)).toEqual([0]);
  });
});

describe('summarizePasses (for the export panel)', () => {
  it('lists the forced heavy line as heavier-than-the-rest', () => {
    const prims = [
      { kind: 'path', mode: 'stroke', widthMm: 0.12 },
      { kind: 'path', mode: 'stroke', widthMm: 0.25, minPasses: 2 },
      { kind: 'path', mode: 'stroke', widthMm: 0.9 },
      { kind: 'path', mode: 'fill' },
      { kind: 'text' },
    ];
    expect(summarizePasses(prims, 0.3)).toEqual([
      { widthMm: 0.25, passes: 2, forced: true },
      { widthMm: 0.9, passes: 3, forced: false },
    ]);
  });
  it('lists nothing when every line is a single pass', () => {
    expect(summarizePasses([{ kind: 'path', mode: 'stroke', widthMm: 0.12 }], 0.3)).toEqual([]);
  });
});

describe('heavy contours in the plotter export', () => {
  it('the heavy contour line asks for two passes; the regular one does not', async () => {
    const { p, scene } = await build();
    const heavy = paths(scene).find((x) => x.widthMm === p.terrain.indexWeightMm)!;
    const regular = paths(scene).find((x) => x.widthMm === p.terrain.weightMm)!;
    expect(heavy.minPasses).toBe(2);
    expect(regular.minPasses).toBeUndefined();
  });
  it('are drawn as two passes of the pen, while regular contours stay a single pass', async () => {
    const { p, scene } = await build();
    const out = prepareScene(scene, 'plotter', fonts);
    const count = (w: number, s: Scene) => paths(s).filter((x) => x.widthMm === w && x.color === colorOf(p, p.terrain.pen)).length;
    const heavyBefore = paths(scene).filter((x) => x.widthMm === p.terrain.indexWeightMm).length;
    const regularBefore = paths(scene).filter((x) => x.widthMm === p.terrain.weightMm).length;
    expect(heavyBefore).toBeGreaterThan(0);
    expect(regularBefore).toBeGreaterThan(0);
    // after: every stroke is the pen width, so count the prims that came from each
    const total = paths(out).filter((x) => x.color === colorOf(p, p.terrain.pen)).length;
    const profileLine = paths(scene).filter((x) => x.color === colorOf(p, p.terrain.pen) && x.widthMm !== p.terrain.weightMm && x.widthMm !== p.terrain.indexWeightMm).length;
    expect(total).toBeGreaterThanOrEqual(regularBefore + heavyBefore * 2);
    expect(count(PLOTTER_PEN_MM, out)).toBe(total);
    expect(profileLine).toBeGreaterThan(0);
  });
  it('the two passes run side by side, about 0.6 to 1 pen apart', async () => {
    const { p, scene } = await build();
    const heavy = paths(scene).find((x) => x.widthMm === p.terrain.indexWeightMm)!;
    const out = prepareScene({ ...scene, prims: [heavy] }, 'plotter', fonts);
    const [a, b] = paths(out);
    expect(paths(out)).toHaveLength(2);
    const first = (d: string): [number, number] => { const m = d.match(/M(-?[\d.]+) (-?[\d.]+)/)!; return [+m[1]!, +m[2]!]; };
    const gap = Math.hypot(first(a!.d)[0] - first(b!.d)[0], first(a!.d)[1] - first(b!.d)[1]);
    expect(gap).toBeGreaterThan(0.6 * PLOTTER_PEN_MM * 0.8); // near the line's normal; allow for the corner angle
    expect(gap).toBeLessThan(PLOTTER_PEN_MM * 1.2);
    expect(subs(a!.d)).toBe(subs(b!.d)); // same shape twice
    expect(subs(a!.d)).toBe(subs(heavy.d));
  });
  it('every plotted stroke is still the pen width, and no forced-pass flag leaks out', async () => {
    const { scene } = await build();
    const out = prepareScene(scene, 'plotter', fonts);
    expect(paths(out).every((x) => x.mode === 'stroke' && x.widthMm === PLOTTER_PEN_MM && x.minPasses === undefined)).toBe(true);
  });
  it('layers stay one per color', async () => {
    const { scene } = await build();
    const ids = [...sceneToSvg(prepareScene(scene, 'plotter', fonts)).matchAll(/<g id="(layer-[^"]+)"/g)].map((m) => m[1]!);
    expect(new Set(ids.map((i) => i.split('-')[1])).size).toBe(ids.length);
    expect(ids.every((i) => i.endsWith(`-${PLOTTER_PEN_MM}mm`))).toBe(true);
  });
  it('the heavy line stays heavier than the regular one with a finer or a coarser pen', async () => {
    const { p, scene } = await build();
    const heavy = paths(scene).find((x) => x.widthMm === p.terrain.indexWeightMm)!;
    const regular = paths(scene).find((x) => x.widthMm === p.terrain.weightMm)!;
    for (const penMm of [0.12, 0.2, 0.3, 0.5]) {
      const h = paths(prepareScene({ ...scene, prims: [heavy] }, 'plotter', fonts, { penMm })).length;
      const r = paths(prepareScene({ ...scene, prims: [regular] }, 'plotter', fonts, { penMm })).length;
      expect(h).toBeGreaterThan(r);
    }
  });
  it('works with elevation numbers: the gaps are drawn in both passes', async () => {
    const { p, scene } = await build((q) => { q.terrain.labels.enabled = true; q.terrain.labels.density = 'dense'; });
    const heavy = paths(scene).find((x) => x.widthMm === p.terrain.indexWeightMm)!;
    const out = paths(prepareScene({ ...scene, prims: [heavy] }, 'plotter', fonts));
    expect(out).toHaveLength(2);
    expect(subs(out[0]!.d)).toBe(subs(heavy.d));
    expect(subs(heavy.d)).toBeGreaterThan(1);
  });
  it('print mode is untouched: one heavy line at its real width', async () => {
    const { p, scene } = await build();
    const out = prepareScene(scene, 'print', fonts);
    expect(paths(out).filter((x) => x.widthMm === p.terrain.indexWeightMm)).toHaveLength(1);
  });
});
