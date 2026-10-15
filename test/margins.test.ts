import { describe, expect, it } from 'vitest';
import { clampMargins, DEFAULT_MARGIN_MM, defaultProject, posterMm, type Project } from '../src/scene/project';
import { composeScene } from '../src/scene/buildScene';
import { marginFromUnits, marginToUnits } from '../src/ui/PagePanel';
import { sampleTrack } from '../src/sample';
import type { TextPrim } from '../src/scene/types';

const base = (edit: (p: Project) => void = () => {}): Project => {
  const p = { ...defaultProject(), points: sampleTrack() };
  edit(p);
  return p;
};
const setMargins = (p: Project, m: Partial<Project['page']['margins']>) => { Object.assign(p.page.margins, m); p.page.linked = false; };
const text = (p: Project, t: string) => composeScene(p).scene.prims.find((x): x is TextPrim => x.kind === 'text' && x.text === t)!;

describe('margin defaults', () => {
  it('start at 1.25 in on every side, linked', () => {
    const p = defaultProject();
    expect(p.page.margins).toEqual({ top: 31.75, right: 31.75, bottom: 31.75, left: 31.75 });
    expect(DEFAULT_MARGIN_MM).toBeCloseTo(1.25 * 25.4, 6);
    expect(p.page.linked).toBe(true);
  });
  it('are close to the old 7% layout on an 18x24 print', () => {
    expect(Math.abs(DEFAULT_MARGIN_MM - 0.07 * posterMm(defaultProject()).w)).toBeLessThan(0.5);
  });
});

describe('clampMargins', () => {
  it('leaves sensible margins alone', () => {
    expect(clampMargins({ top: 20, right: 30, bottom: 40, left: 10 }, 400, 600)).toEqual({ top: 20, right: 30, bottom: 40, left: 10 });
  });
  it('treats negative and invalid values as zero', () => {
    expect(clampMargins({ top: -5, right: NaN, bottom: Infinity, left: 3 }, 400, 600)).toEqual({ top: 0, right: 0, bottom: 0, left: 3 });
  });
  it('keeps at least 20% of the page for content, scaling both sides of an axis together', () => {
    const m = clampMargins({ top: 10, right: 300, bottom: 10, left: 300 }, 400, 600);
    expect(400 - m.left - m.right).toBeCloseTo(80, 6); // 20% of 400
    expect(m.left).toBeCloseTo(m.right, 6); // proportions kept
    const v = clampMargins({ top: 500, right: 10, bottom: 100, left: 10 }, 400, 600);
    expect(600 - v.top - v.bottom).toBeCloseTo(120, 6);
    expect(v.top / v.bottom).toBeCloseTo(5, 6);
  });
  it('the two axes are independent', () => {
    const m = clampMargins({ top: 20, right: 300, bottom: 20, left: 300 }, 400, 600);
    expect(m.top).toBe(20);
    expect(m.bottom).toBe(20);
  });
});

describe('the layout follows the margins', () => {
  it('left-aligned text starts at the left margin; right-aligned ends at the right margin', () => {
    const left = base((p) => { setMargins(p, { left: 50, right: 10 }); p.text.align = 'left'; });
    expect(text(left, 'WALK OF FRAME').x).toBeCloseTo(50, 6);
    const right = base((p) => { setMargins(p, { left: 50, right: 10 }); p.text.align = 'right'; });
    expect(text(right, 'WALK OF FRAME').x).toBeCloseTo(posterMm(right).w - 10, 6);
  });
  it('centered text is centered between the margins, not on the page', () => {
    const p = base((q) => { setMargins(q, { left: 80, right: 20 }); q.text.align = 'center'; });
    expect(text(p, 'WALK OF FRAME').x).toBeCloseTo((80 + posterMm(p).w - 20) / 2, 6);
  });
  it('the map frame sits inside the margins', () => {
    const p = base((q) => setMargins(q, { top: 40, right: 25, bottom: 35, left: 15 }));
    const { w } = posterMm(p);
    const f = composeScene(p).view!.frame;
    expect(f.x).toBeCloseTo(15, 6);
    expect(f.w).toBeCloseTo(w - 15 - 25, 6);
    expect(f.y).toBeGreaterThanOrEqual(40 - 1e-6);
  });
  it('the top margin is where top-placed text starts, the bottom margin where the watermark ends', () => {
    const p = base((q) => { setMargins(q, { top: 60, bottom: 45 }); q.text.title.placement = 'top'; });
    const { h } = posterMm(p);
    expect(text(p, 'WALK OF FRAME').y).toBeGreaterThanOrEqual(60);
    expect(text(p, 'WALK OF FRAME').y).toBeLessThan(60 + 60 * 25.4 / 72 * 0.8);
    const wm = composeScene(p).scene.prims.find((x): x is TextPrim => x.kind === 'text' && x.text.startsWith('Generated with'))!;
    expect(wm.y).toBeCloseTo(h - 45, 6);
  });
  it('more margin means a smaller map; less means a larger one', () => {
    const f = (m: number) => composeScene(base((p) => setMargins(p, { top: m, right: m, bottom: m, left: m }))).view!.frame;
    expect(f(60).w).toBeLessThan(f(30).w);
    expect(f(60).h).toBeLessThan(f(30).h);
    expect(f(10).w).toBeGreaterThan(f(30).w);
  });
  it('margins stay the same when the poster size changes', () => {
    const a = composeScene(base((p) => { p.sizeId = '12x16'; })).view!.frame;
    const b = composeScene(base((p) => { p.sizeId = '24x36'; })).view!.frame;
    expect(a.x).toBe(b.x);
    expect(a.x).toBeCloseTo(31.75, 6);
  });
  it('info columns span the content width between the margins', () => {
    const p = base((q) => { setMargins(q, { left: 60, right: 40 }); q.text.align = 'left'; });
    const { w } = posterMm(p);
    const xs = composeScene(p).scene.prims.filter((x): x is TextPrim => x.kind === 'text' && /DISTANCE|ELEVATION GAIN|DATE/.test(x.text)).map((x) => x.x);
    expect(Math.min(...xs)).toBeCloseTo(60, 6);
    expect(Math.max(...xs)).toBeLessThan(w - 40);
  });
  it('the corner elevation profile ends at the right margin', () => {
    const p = base((q) => { setMargins(q, { right: 70 }); q.profile.position = 'corner'; });
    const { w } = posterMm(p);
    const scene = composeScene(p).scene;
    const xs = scene.prims.flatMap((x) => (x.kind === 'path' && x.mode === 'fill' ? (x.d.match(/-?\d+(\.\d+)?/g) ?? []).filter((_, i) => i % 2 === 0).map(Number) : []));
    expect(Math.max(...xs)).toBeCloseTo(w - 70, 1);
  });
  it('absurd margins are clamped, not allowed to collapse the layout', () => {
    const p = base((q) => setMargins(q, { top: 5000, right: 5000, bottom: 5000, left: 5000 }));
    const f = composeScene(p).view!.frame;
    const { w } = posterMm(p);
    expect(f.w).toBeGreaterThanOrEqual(w * 0.2 - 1e-6);
    expect(Number.isFinite(f.h)).toBe(true);
  });
  it('zero margins put content right at the edge without breaking', () => {
    const p = base((q) => setMargins(q, { top: 0, right: 0, bottom: 0, left: 0 }));
    const f = composeScene(p).view!.frame;
    expect(f.x).toBe(0);
    expect(f.w).toBeCloseTo(posterMm(p).w, 6);
  });
});

describe('margin units in the editor', () => {
  it('shows inches or millimeters to match the poster', () => {
    expect(marginToUnits(31.75, 'imperial')).toBe(1.25);
    expect(marginToUnits(31.75, 'metric')).toBe(31.8);
    expect(marginToUnits(25.4, 'imperial')).toBe(1);
  });
  it('converts what the user types back to mm, never negative', () => {
    expect(marginFromUnits(1.25, 'imperial')).toBeCloseTo(31.75, 6);
    expect(marginFromUnits(30, 'metric')).toBe(30);
    expect(marginFromUnits(-3, 'metric')).toBe(0);
    expect(marginFromUnits(NaN, 'imperial')).toBe(0);
  });
});
