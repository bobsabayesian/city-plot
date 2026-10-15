import { describe, expect, it } from 'vitest';
import { borderExtent, borderPrims, defaultBorder, layoutBorder, type BorderSettings } from '../src/scene/border';
import { defaultProject, posterMm, type Project } from '../src/scene/project';
import { buildScene, composeScene, viewOf } from '../src/scene/buildScene';
import { prepareScene, type FontSet } from '../src/export/outlines';
import { sceneToSvg } from '../src/export/svg';
import { penUsage } from '../src/scene/pens';
import { cityProject, cityData } from './fixture';
import type { PathPrim } from '../src/scene/types';

const fake = { unitsPerEm: 1000, charToGlyph: () => ({ advanceWidth: 500, getPath: () => ({ toPathData: () => 'M0 0L1 1', commands: [{ type: 'M', x: 0, y: 0 }, { type: 'L', x: 1, y: 1 }] }) }) };
const fonts = { sans: fake, serif: fake } as unknown as FontSet;
const W = 400;
const H = 600;
const margins = { top: 30, right: 30, bottom: 30, left: 30 };
const on = (e: Partial<BorderSettings> = {}): BorderSettings => ({ ...defaultBorder('black'), enabled: true, ...e });
/** A border pass: a closed four-cornered rectangle (centered pass keeps H/V, shifted passes are four L's). */
const isRect = (d: string) => /^M[\d.]+ [\d.]+H[\d.]+V[\d.]+H[\d.]+Z$/.test(d) || /^M[\d.]+ [\d.]+(L[\d.]+ [\d.]+){3,4}Z$/.test(d);
const base = (edit: (p: Project) => void = () => {}): Project => {
  const p = cityProject();
  edit(p);
  return p;
};
const borders = (p: Project) => buildScene(p).prims.filter((x): x is PathPrim => x.kind === 'path' && x.widthMm === p.border.weightMm && x.pen === p.border.pen && /^M[\d.]+ [\d.]+H[\d.]+V[\d.]+H[\d.]+Z$/.test(x.d));

describe('border layout', () => {
  it('is off by default and draws nothing', () => {
    expect(defaultProject().border.enabled).toBe(false);
    expect(borderPrims(W, H, defaultBorder('black'), '#000')).toEqual([]);
    expect(borders(base())).toHaveLength(0);
    expect(borderExtent(defaultBorder('black'))).toBe(0);
  });
  it('a single border is one rectangle inset from the paper edge by the border margin', () => {
    expect(layoutBorder(W, H, on({ offsetMm: 12 })).rects).toEqual([{ x: 12, y: 12, w: W - 24, h: H - 24 }]);
  });
  it('a double border is two rectangles, the inner one the gap further in', () => {
    const l = layoutBorder(W, H, on({ style: 'double', offsetMm: 10, gapMm: 3 }));
    expect(l.rects).toEqual([{ x: 10, y: 10, w: W - 20, h: H - 20 }, { x: 13, y: 13, w: W - 26, h: H - 26 }]);
  });
  it('never goes negative or off the paper, even with no margin at all', () => {
    const l = layoutBorder(W, H, on({ offsetMm: -5, weightMm: 1 }));
    for (const r of l.rects) {
      expect(r.x).toBeGreaterThanOrEqual(0.5 - 1e-9);
      expect(r.w).toBeLessThanOrEqual(W);
    }
  });
  it('its reach is the margin, plus the gap for a double border, plus half the line', () => {
    expect(borderExtent(on({ offsetMm: 12, weightMm: 0.5 }))).toBeCloseTo(12.25, 9);
    expect(borderExtent(on({ style: 'double', offsetMm: 10, gapMm: 3, weightMm: 0.5 }))).toBeCloseTo(13.25, 9);
  });
});

describe('border margin and page margin are separate', () => {
  const frame = (edit: (q: Project) => void) => composeScene(base(edit)).view!.frame;
  it('the page margin is measured from the paper edge when there is no border', () => {
    const f = frame((q) => { Object.assign(q.page.margins, { top: 20, right: 20, bottom: 20, left: 20 }); });
    expect(f.x).toBeCloseTo(20, 6);
  });
  it('with a border, the page margin starts inside it: content sits border margin + page margin from the edge', () => {
    const f = frame((q) => { Object.assign(q.page.margins, { top: 20, right: 20, bottom: 20, left: 20 }); q.border = on({ offsetMm: 12, weightMm: 0.5 }); });
    expect(f.x).toBeCloseTo(20 + 12.25, 6);
  });
  it('changing the border margin moves the border and the content together, keeping the page margin', () => {
    const at = (off: number) => {
      const p = base((q) => { Object.assign(q.page.margins, { top: 20, right: 20, bottom: 20, left: 20 }); q.border = on({ offsetMm: off }); });
      const b = +borders(p)[0]!.d.match(/^M([\d.]+)/)![1]!;
      return { border: b, content: composeScene(p).view!.frame.x };
    };
    const [a, c] = [at(10), at(20)];
    expect(c.border - a.border).toBeCloseTo(10, 6);
    expect(c.content - a.content).toBeCloseTo(10, 6);
    expect(a.content - a.border).toBeCloseTo(c.content - c.border, 6);
  });
  it('a double border pushes the content in by its gap too', () => {
    const single = frame((q) => { q.border = on({ offsetMm: 12 }); });
    const double = frame((q) => { q.border = on({ offsetMm: 12, style: 'double', gapMm: 3 }); });
    expect(double.x - single.x).toBeCloseTo(3, 6);
  });
  it('the content never collapses, however big the margins', () => {
    const f = frame((q) => { Object.assign(q.page.margins, { top: 500, right: 500, bottom: 500, left: 500 }); q.border = on({ offsetMm: 200 }); });
    expect(f.w).toBeGreaterThan(0);
    expect(f.h).toBeGreaterThan(0);
  });
});

describe('the border in the poster', () => {
  it('draws one closed line, in the border pen at the chosen weight', () => {
    const p = base((q) => { q.border = on({ offsetMm: 12, weightMm: 0.6, pen: 'green' }); });
    const b = borders(p);
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ mode: 'stroke', widthMm: 0.6, pen: 'green', color: '#1e7a3c' });
    const { w, h } = posterMm(p);
    expect(b[0]!.d).toBe(`M12 12H${+(w - 12).toFixed(3)}V${+(h - 12).toFixed(3)}H12Z`);
  });
  it('a double border draws two lines', () => {
    expect(borders(base((q) => { q.border = on({ style: 'double' }); }))).toHaveLength(2);
  });
  it('is drawn first, under everything else', () => {
    const p = base((q) => { q.border = on(); });
    const prims = buildScene(p).prims;
    expect(prims[0]).toMatchObject({ kind: 'path', pen: 'black', widthMm: 0.5, mode: 'stroke' });
    expect((prims[0] as PathPrim).d).toMatch(/^M12 12H[\d.]+V[\d.]+H12Z$/);
  });
  it('follows its pen: recoloring the pen recolors the border', () => {
    const p = base((q) => { q.border = on({ pen: 'blue' }); q.pens.find((x) => x.id === 'blue')!.color = '#112233'; });
    expect(borders(p)[0]!.color).toBe('#112233');
  });
  it('is listed among the pen users only when on', () => {
    expect(penUsage(base()).some((u) => u.section === 'Border')).toBe(false);
    expect(penUsage(base((q) => { q.border = on({ pen: 'green' }); })).find((u) => u.section === 'Border')).toEqual({ penId: 'green', section: 'Border' });
  });
});

describe('labels stay inside the border', () => {
  const summit = (edit: (p: Project) => void) => {
    const p = base((q) => {
      Object.assign(q.page.margins, { top: 34, right: 34, bottom: 34, left: 34 });
      // a landmark named Summit at the right edge of the map
      const v = viewOf(q)!;
      const [lat, lon] = v.fit.fromMm(v.frame.x + v.frame.w - 0.5, v.frame.y + v.frame.h / 2);
      q.custom = [{ id: 'custom-1', name: 'Summit', kind: 'custom', lat, lon }];
      edit(q);
    });
    return { p, label: buildScene(p).prims.find((x) => x.kind === 'text' && x.text === 'Summit') as { x: number; anchor: string } | undefined };
  };
  it('a label that would run past the border is moved to the other side of its marker', () => {
    const none = summit(() => {});
    const framed = summit((q) => { Object.assign(q.page.margins, { top: 6, right: 6, bottom: 6, left: 6 }); q.border = on({ offsetMm: 28 }); }); // content edge about where it was
    expect(none.label?.anchor).toBe('start'); // fits in the margin when there is no border
    expect(framed.label).toBeDefined();
    expect(framed.label!.anchor).not.toBe('start'); // would have crossed the border
  });
  it('no label is written past the inner border line', () => {
    const { p } = summit((q) => { Object.assign(q.page.margins, { top: 4, right: 4, bottom: 4, left: 4 }); q.border = on({ offsetMm: 28, style: 'double', gapMm: 2 }); });
    const { w } = posterMm(p);
    const inner = layoutBorder(w, posterMm(p).h, p.border).rects.at(-1)!.x + p.border.weightMm / 2 + 1.5;
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
    expect(svg).toContain('id="layer-111111-0.77mm"');
    expect(svg).toContain('stroke-linejoin="round"');
  });
  it('plotter: a heavy border becomes passes of its pen, each a closed rectangle', () => {
    const p = base((q) => { q.border = on({ weightMm: 0.78 }); });
    const out = prepareScene(buildScene(p), 'plotter', fonts, { pens: p.pens });
    const closed = out.prims.filter((x): x is PathPrim => x.kind === 'path' && isRect(x.d) && x.widthMm === 0.3);
    expect(closed.length).toBeGreaterThanOrEqual(3); // 0.78 = 3 passes of a 0.3 mm pen (the north arrow is off)
  });
  it('plotter: a double border is twice the passes of a single one', () => {
    const count = (style: 'single' | 'double') => {
      const p = base((q) => { q.border = on({ style, weightMm: 0.78 }); q.features.enabled = false; });
      return prepareScene(buildScene(p), 'plotter', fonts, { pens: p.pens }).prims.filter((x) => x.kind === 'path' && isRect(x.d) && x.widthMm === 0.3).length;
    };
    expect(count('double')).toBe(2 * count('single'));
  });
  it('plotter: the passes of a thin border are a single line at the pen width', () => {
    const p = base((q) => { q.border = on({ weightMm: 0.3 }); q.features.enabled = false; });
    const closed = prepareScene(buildScene(p), 'plotter', fonts, { pens: p.pens }).prims.filter((x) => x.kind === 'path' && isRect(x.d));
    expect(closed).toHaveLength(1);
  });
  it('print: unchanged by the pen tip', () => {
    const p = base((q) => { q.border = on({ weightMm: 0.78 }); });
    const out = prepareScene(buildScene(p), 'print', fonts, { pens: p.pens });
    expect(out.prims.filter((x) => x.kind === 'path' && x.widthMm === 0.78 && x.d.endsWith('Z') && x.pen === 'black')).toHaveLength(1);
  });
});
