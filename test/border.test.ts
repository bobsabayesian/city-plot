import { describe, expect, it } from 'vitest';
import { BORDER_CLEARANCE_MM, borderPrims, defaultBorder, layoutBorder, type BorderSettings } from '../src/scene/border';
import { defaultProject, posterMm, type Project } from '../src/scene/project';
import { buildScene, composeScene } from '../src/scene/buildScene';
import { prepareScene, type FontSet } from '../src/export/outlines';
import { sceneToSvg } from '../src/export/svg';
import { penUsage } from '../src/scene/pens';
import { sampleTrack, sampleWaypoints } from '../src/sample';
import type { PathPrim } from '../src/scene/types';

const fake = { unitsPerEm: 1000, charToGlyph: () => ({ advanceWidth: 500, getPath: () => ({ toPathData: () => 'M0 0L1 1', commands: [{ type: 'M', x: 0, y: 0 }, { type: 'L', x: 1, y: 1 }] }) }) };
const fonts = { sans: fake, serif: fake } as unknown as FontSet;
const W = 400;
const H = 600;
const margins = { top: 30, right: 30, bottom: 30, left: 30 };
const on = (e: Partial<BorderSettings> = {}): BorderSettings => ({ ...defaultBorder('ink'), enabled: true, ...e });
/** A border pass: a closed four-cornered rectangle (centered pass keeps H/V, shifted passes are four L's). */
const isRect = (d: string) => /^M[\d.]+ [\d.]+H[\d.]+V[\d.]+H[\d.]+Z$/.test(d) || /^M[\d.]+ [\d.]+(L[\d.]+ [\d.]+){3,4}Z$/.test(d);
const base = (edit: (p: Project) => void = () => {}): Project => {
  const p = { ...defaultProject(), points: sampleTrack() };
  edit(p);
  return p;
};
const borders = (p: Project) => buildScene(p).prims.filter((x): x is PathPrim => x.kind === 'path' && x.widthMm === p.border.weightMm && x.pen === p.border.pen && /^M[\d.]+ [\d.]+H[\d.]+V[\d.]+H[\d.]+Z$/.test(x.d));

describe('border layout', () => {
  it('is off by default and draws nothing', () => {
    expect(defaultProject().border.enabled).toBe(false);
    expect(borderPrims(W, H, defaultBorder('ink'), margins, '#000')).toEqual([]);
    expect(borders(base())).toHaveLength(0);
  });
  it('a single border is one rectangle inset from the paper edge', () => {
    const l = layoutBorder(W, H, on({ offsetMm: 12 }), margins);
    expect(l.rects).toEqual([{ x: 12, y: 12, w: W - 24, h: H - 24 }]);
    expect(l.clamped).toBe(false);
  });
  it('a double border is two rectangles, the inner one the gap further in', () => {
    const l = layoutBorder(W, H, on({ style: 'double', offsetMm: 10, gapMm: 3 }), margins);
    expect(l.rects).toEqual([{ x: 10, y: 10, w: W - 20, h: H - 20 }, { x: 13, y: 13, w: W - 26, h: H - 26 }]);
  });
  it('the offset and gap are respected exactly when there is room', () => {
    const l = layoutBorder(W, H, on({ style: 'double', offsetMm: 8, gapMm: 4 }), { top: 40, right: 40, bottom: 40, left: 40 });
    expect(l.offsetMm).toBe(8);
    expect(l.gapMm).toBe(4);
  });
  it('stays inside the smallest margin: a too-large offset is pulled in', () => {
    const l = layoutBorder(W, H, on({ offsetMm: 80 }), { top: 40, right: 25, bottom: 40, left: 40 });
    expect(l.clamped).toBe(true);
    expect(l.offsetMm + 0.25).toBeLessThanOrEqual(25 - BORDER_CLEARANCE_MM + 1e-9); // outer edge of the line is clear of the content
  });
  it('for a double border the whole thing fits, shrinking the offset first and then the gap', () => {
    const m = { top: 20, right: 20, bottom: 20, left: 20 };
    const l = layoutBorder(W, H, on({ style: 'double', offsetMm: 30, gapMm: 5, weightMm: 0.5 }), m);
    expect(l.clamped).toBe(true);
    expect(l.offsetMm + l.gapMm + 0.25).toBeLessThanOrEqual(20 - BORDER_CLEARANCE_MM + 1e-9);
    expect(l.gapMm).toBeCloseTo(5, 6); // there was room for the gap once the offset came in
    const tight = layoutBorder(W, H, on({ style: 'double', offsetMm: 30, gapMm: 20, weightMm: 0.5 }), m);
    expect(tight.offsetMm + tight.gapMm + 0.25).toBeLessThanOrEqual(20 - BORDER_CLEARANCE_MM + 1e-9);
    expect(tight.gapMm).toBeLessThan(20);
    expect(tight.offsetMm).toBeGreaterThanOrEqual(0.25); // never pushed off the paper
  });
  it('never goes negative or off the paper, even with no margin at all', () => {
    const l = layoutBorder(W, H, on({ offsetMm: -5, weightMm: 1 }), { top: 0, right: 0, bottom: 0, left: 0 });
    for (const r of l.rects) {
      expect(r.x).toBeGreaterThanOrEqual(0.5 - 1e-9);
      expect(r.w).toBeLessThanOrEqual(W);
    }
  });
  it('the smallest margin is the one that limits it', () => {
    const wide = layoutBorder(W, H, on({ offsetMm: 40 }), { top: 80, right: 80, bottom: 80, left: 80 });
    const narrow = layoutBorder(W, H, on({ offsetMm: 40 }), { top: 80, right: 80, bottom: 80, left: 14 });
    expect(wide.clamped).toBe(false);
    expect(narrow.clamped).toBe(true);
    expect(narrow.offsetMm).toBeLessThan(14);
  });
});

describe('the border in the poster', () => {
  it('draws one closed line, in the border pen at the chosen weight', () => {
    const p = base((q) => { q.border = on({ offsetMm: 12, weightMm: 0.6, pen: 'red' }); });
    const b = borders(p);
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ mode: 'stroke', widthMm: 0.6, pen: 'red', color: '#b4441f' });
    const { w, h } = posterMm(p);
    expect(b[0]!.d).toBe(`M12 12H${+(w - 12).toFixed(3)}V${+(h - 12).toFixed(3)}H12Z`);
  });
  it('a double border draws two lines', () => {
    expect(borders(base((q) => { q.border = on({ style: 'double' }); }))).toHaveLength(2);
  });
  it('is drawn first, under everything else', () => {
    const p = base((q) => { q.border = on(); });
    const prims = buildScene(p).prims;
    expect(prims[0]).toMatchObject({ kind: 'path', pen: 'ink', widthMm: 0.5, mode: 'stroke' });
    expect((prims[0] as PathPrim).d).toMatch(/^M12 12H[\d.]+V[\d.]+H12Z$/);
  });
  it('does not change the layout of the map or text', () => {
    const off = composeScene(base()).view!.frame;
    const single = composeScene(base((q) => { q.border = on(); })).view!.frame;
    const double = composeScene(base((q) => { q.border = on({ style: 'double' }); })).view!.frame;
    expect(single).toEqual(off);
    expect(double).toEqual(off);
  });
  it('follows its pen: recoloring the pen recolors the border', () => {
    const p = base((q) => { q.border = on({ pen: 'blue' }); q.pens.find((x) => x.id === 'blue')!.color = '#112233'; });
    expect(borders(p)[0]!.color).toBe('#112233');
  });
  it('stays inside the margin when the margin shrinks', () => {
    const p = base((q) => { q.border = on({ offsetMm: 30 }); Object.assign(q.page.margins, { top: 10, right: 10, bottom: 10, left: 10 }); });
    const x = +borders(p)[0]!.d.match(/^M([\d.]+)/)![1]!;
    expect(x + 0.25).toBeLessThan(10);
  });
  it('is listed among the pen users only when on', () => {
    expect(penUsage(base()).some((u) => u.section === 'Border')).toBe(false);
    expect(penUsage(base((q) => { q.border = on({ pen: 'red' }); })).find((u) => u.section === 'Border')).toEqual({ penId: 'red', section: 'Border' });
  });
});

describe('labels stay inside the border', () => {
  const summit = (edit: (p: Project) => void) => {
    const p = base((q) => {
      q.waypoints = sampleWaypoints(q.points).slice(0, 1); // the summit, at the right edge of the map
      q.features.kinds.waypoint = true;
      Object.assign(q.page.margins, { top: 34, right: 34, bottom: 34, left: 34 });
      edit(q);
    });
    return { p, label: buildScene(p).prims.find((x) => x.kind === 'text' && x.text === 'Summit') as { x: number; anchor: string } | undefined };
  };
  it('a label that would run past the border is moved to the other side of its marker', () => {
    const none = summit(() => {});
    const framed = summit((q) => { q.border = on({ offsetMm: 28 }); });
    expect(none.label?.anchor).toBe('start'); // fits in the margin when there is no border
    expect(framed.label).toBeDefined();
    expect(framed.label!.anchor).not.toBe('start'); // would have crossed the border
  });
  it('no label is written past the inner border line', () => {
    const { p } = summit((q) => { q.border = on({ offsetMm: 28, style: 'double', gapMm: 2 }); });
    const { w } = posterMm(p);
    const inner = layoutBorder(w, posterMm(p).h, p.border, p.page.margins).rects.at(-1)!.x + p.border.weightMm / 2 + 1.5;
    for (const t of buildScene(p).prims) {
      if (t.kind !== 'text' || t.text.startsWith('Generated') || t.text === t.text.toUpperCase()) continue;
      const width = t.text.length * t.sizeMm * 0.56;
      const x1 = t.anchor === 'start' ? t.x + width : t.anchor === 'end' ? t.x : t.x + width / 2;
      expect(x1).toBeLessThanOrEqual(w - inner + 0.5);
    }
  });
});

describe('the border in the exports', () => {
  it('SVG: the border is a stroked, round-joined closed path in its own layer when it has its own weight', () => {
    const svg = sceneToSvg(buildScene(base((q) => { q.border = on({ weightMm: 0.77 }); })));
    expect(svg).toContain('stroke-width="0.77"');
    expect(svg).toContain('id="layer-1f2a24-0.77mm"');
    expect(svg).toContain('stroke-linejoin="round"');
  });
  it('plotter: a heavy border becomes passes of its pen, each a closed rectangle', () => {
    const p = base((q) => { q.border = on({ weightMm: 0.9 }); });
    const out = prepareScene(buildScene(p), 'plotter', fonts, { pens: p.pens });
    const closed = out.prims.filter((x): x is PathPrim => x.kind === 'path' && isRect(x.d) && x.widthMm === 0.3);
    expect(closed.length).toBeGreaterThanOrEqual(3); // 0.9 / 0.3 = 3 passes (the north arrow is off)
  });
  it('plotter: a double border is twice the passes of a single one', () => {
    const count = (style: 'single' | 'double') => {
      const p = base((q) => { q.border = on({ style, weightMm: 0.9 }); q.profile.enabled = false; q.features.enabled = false; });
      return prepareScene(buildScene(p), 'plotter', fonts, { pens: p.pens }).prims.filter((x) => x.kind === 'path' && isRect(x.d) && x.widthMm === 0.3).length;
    };
    expect(count('double')).toBe(2 * count('single'));
  });
  it('plotter: the passes of a thin border are a single line at the pen width', () => {
    const p = base((q) => { q.border = on({ weightMm: 0.3 }); q.profile.enabled = false; q.features.enabled = false; });
    const closed = prepareScene(buildScene(p), 'plotter', fonts, { pens: p.pens }).prims.filter((x) => x.kind === 'path' && isRect(x.d));
    expect(closed).toHaveLength(1);
  });
  it('print: unchanged by the pen tip', () => {
    const p = base((q) => { q.border = on({ weightMm: 0.9 }); });
    const out = prepareScene(buildScene(p), 'print', fonts, { pens: p.pens });
    expect(out.prims.filter((x) => x.kind === 'path' && x.widthMm === 0.9 && x.d.endsWith('Z') && x.pen === 'ink')).toHaveLength(1);
  });
});
