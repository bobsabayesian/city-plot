import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'opentype.js';
import { composeScene, buildScene } from '../src/scene/buildScene';
import { defaultProject, posterMm, type Project } from '../src/scene/project';
import { penUsage } from '../src/scene/pens';
import { prepareScene, textToPath, type FontSet } from '../src/export/outlines';
import { flattenPath } from '../src/export/offset';
import { HATCH_FACTOR } from '../src/export/hatch';
import { sceneToSvg } from '../src/export/svg';
import { sampleTrack } from '../src/sample';
import type { PathPrim, TextPrim } from '../src/scene/types';

const b = readFileSync('node_modules/@fontsource/inter/files/inter-latin-400-normal.woff');
const font = parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const fonts = { sans: font, serif: font } as unknown as FontSet;
const base = (edit: (p: Project) => void = () => {}): Project => {
  const p = { ...defaultProject(), points: sampleTrack() };
  p.features.enabled = false;
  edit(p);
  return p;
};
const TITLE = 'WALK OF FRAME';
const titles = (p: Project) => buildScene(p).prims.filter((x): x is TextPrim => x.kind === 'text' && x.text === TITLE);
const setMargins = (p: Project, m: Partial<Project['page']['margins']>) => { Object.assign(p.page.margins, m); p.page.linked = false; };
const extent = (d: string) => {
  const pts = flattenPath(d).flatMap((s) => s.pts);
  return { x0: Math.min(...pts.map((q) => q[0])), x1: Math.max(...pts.map((q) => q[0])), y0: Math.min(...pts.map((q) => q[1])), y1: Math.max(...pts.map((q) => q[1])) };
};
const paths = (s: { prims: unknown[] }) => (s.prims as { kind: string }[]).filter((x) => x.kind === 'path') as PathPrim[];

describe('title defaults', () => {
  it('filled letters, aligned like the rest, outline and fill pens ink', () => {
    const t = defaultProject().text.title;
    expect(t).toMatchObject({ align: 'inherit', style: 'fill', outlineMm: 0.35, fillPen: 'ink', fillDensity: 'solid' });
  });
  it('a default title is one plain text prim, as before', () => {
    const [t] = titles(base());
    expect(titles(base())).toHaveLength(1);
    expect(t!.mode).toBeUndefined();
    expect(t!.fitWidthMm).toBeUndefined();
  });
});

describe('title alignment', () => {
  const at = (edit: (p: Project) => void) => { const p = base((q) => { setMargins(q, { left: 50, right: 20 }); edit(q); }); return { p, t: titles(p)[0]! }; };
  it('"same as the other text" follows the text alignment', () => {
    for (const align of ['left', 'center', 'right'] as const) {
      const a = at((q) => { q.text.align = align; });
      const b = at((q) => { q.text.align = align; q.text.title.align = align; });
      expect(a.t.x).toBeCloseTo(b.t.x, 6);
      expect(a.t.anchor).toBe(b.t.anchor);
    }
  });
  it('can differ from the rest of the text', () => {
    const { p, t } = at((q) => { q.text.align = 'left'; q.text.title.align = 'right'; });
    expect(t.anchor).toBe('end');
    expect(t.x).toBeCloseTo(posterMm(p).w - 20, 6);
    const other = composeScene(p).scene.prims.find((x): x is TextPrim => x.kind === 'text' && /^Walk|Pierce|DISTANCE/.test(x.text) || (x.kind === 'text' && x.text === 'DISTANCE'));
    expect(other?.anchor).toBe('start'); // the info labels stay left
  });
  it('center is between the margins; left starts at the left margin', () => {
    const c = at((q) => { q.text.title.align = 'center'; });
    expect(c.t.anchor).toBe('middle');
    expect(c.t.x).toBeCloseTo((50 + posterMm(c.p).w - 20) / 2, 6);
    const l = at((q) => { q.text.title.align = 'left'; });
    expect(l.t.x).toBeCloseTo(50, 6);
  });
  it('justified: starts at the left margin and is asked to fill the content width', () => {
    const { p, t } = at((q) => { q.text.title.align = 'justify'; });
    expect(t.anchor).toBe('start');
    expect(t.x).toBeCloseTo(50, 6);
    expect(t.fitWidthMm).toBeCloseTo(posterMm(p).w - 50 - 20, 6);
  });
  it('justified follows the margins as they change', () => {
    const wide = at((q) => { q.text.title.align = 'justify'; }).t.fitWidthMm!;
    const narrow = base((q) => { setMargins(q, { left: 90, right: 90 }); q.text.title.align = 'justify'; });
    expect(titles(narrow)[0]!.fitWidthMm!).toBeLessThan(wide);
  });
  it('live SVG text is stretched with textLength only when justified', () => {
    expect(sceneToSvg(buildScene(base((q) => { q.text.title.align = 'justify'; })))).toMatch(/textLength="[\d.]+" lengthAdjust="spacing"/);
    expect(sceneToSvg(buildScene(base()))).not.toContain('textLength');
  });
});

describe('justified outlines', () => {
  const t = (fit?: number, tracking = 0): TextPrim => ({ kind: 'text', text: TITLE, x: 20, y: 80, anchor: 'start', sizeMm: 20, trackingMm: tracking, fontFamily: 'x', fontKey: 'sans', color: '#000', ...(fit !== undefined ? { fitWidthMm: fit } : {}) });
  it('stretches the letters to fill the width', () => {
    const natural = extent(textToPath(t(), fonts));
    const fit = natural.x1 - natural.x0 + 80;
    const e = extent(textToPath(t(fit), fonts));
    expect(e.x0).toBeCloseTo(natural.x0, 0); // still starts at the left edge
    expect(e.x1 - e.x0).toBeGreaterThan(natural.x1 - natural.x0 + 60);
    expect(e.x1).toBeLessThanOrEqual(20 + fit + 0.01); // never past the requested width
    expect(e.x1).toBeGreaterThan(20 + fit - 0.15 * 20); // within a letter's side bearing of it
  });
  it('a wider target spreads the letters further', () => {
    const w = (fit: number) => { const e = extent(textToPath(t(fit), fonts)); return e.x1 - e.x0; };
    expect(w(300)).toBeGreaterThan(w(250));
  });
  it('squeezes only slightly when the title is already wider than the space', () => {
    const natural = extent(textToPath(t(), fonts));
    const tight = extent(textToPath(t(10), fonts)); // far too narrow a target
    const nw = natural.x1 - natural.x0;
    expect(tight.x1 - tight.x0).toBeLessThanOrEqual(nw);
    expect(tight.x1 - tight.x0).toBeGreaterThan(nw * 0.85); // letters never collapse onto each other
  });
  it('does not touch text that is not justified', () => {
    expect(textToPath(t(), fonts)).toBe(textToPath(t(undefined), fonts));
  });
  it('a one-letter title is left alone', () => {
    const one: TextPrim = { ...t(100), text: 'O' };
    expect(() => textToPath(one, fonts)).not.toThrow();
  });
});

describe('title styles', () => {
  it('outline: one text prim, stroked with the outline weight in the title pen', () => {
    const [x, ...rest] = titles(base((q) => { q.text.title.style = 'outline'; q.text.title.outlineMm = 0.6; q.text.title.pen = 'red'; }));
    expect(rest).toHaveLength(0);
    expect(x).toMatchObject({ mode: 'stroke', strokeMm: 0.6, pen: 'red', color: '#b4441f' });
  });
  it('outline with fill: the inside first, then the outline on top, at the same place', () => {
    const [fill, line] = titles(base((q) => {
      q.text.title.style = 'outlineFill'; q.text.title.pen = 'ink'; q.text.title.fillPen = 'blue'; q.text.title.fillDensity = 'medium'; q.text.title.outlineMm = 0.4;
    }));
    expect(fill).toMatchObject({ pen: 'blue', color: '#2f6f9f', hatch: 'medium' });
    expect(fill!.mode).toBeUndefined();
    expect(line).toMatchObject({ mode: 'stroke', strokeMm: 0.4, pen: 'ink' });
    expect([fill!.x, fill!.y, fill!.anchor]).toEqual([line!.x, line!.y, line!.anchor]);
  });
  it('both parts of a justified outline-with-fill are stretched to the same width', () => {
    const [fill, line] = titles(base((q) => { q.text.title.style = 'outlineFill'; q.text.title.align = 'justify'; }));
    expect(fill!.fitWidthMm).toBe(line!.fitWidthMm);
    expect(fill!.fitWidthMm).toBeGreaterThan(0);
  });
  it('the title block takes the same room whatever the style', () => {
    const f = composeScene(base()).view!.frame;
    expect(composeScene(base((q) => { q.text.title.style = 'outline'; })).view!.frame).toEqual(f);
    expect(composeScene(base((q) => { q.text.title.style = 'outlineFill'; })).view!.frame).toEqual(f);
  });
  it('live SVG: an outlined title is stroked with no fill, in a stroke layer of its own weight', () => {
    const svg = sceneToSvg(buildScene(base((q) => { q.text.title.style = 'outline'; q.text.title.outlineMm = 0.35; })));
    expect(svg).toMatch(/<text[^>]*fill="none" stroke="#1f2a24" stroke-width="0.35" stroke-linejoin="round"[^>]*>WALK OF FRAME<\/text>/);
    expect(svg).toContain('id="layer-1f2a24-0.35mm"');
  });
  it('pens: the outline pen and the fill pen are both listed when outline with fill is chosen', () => {
    const p = base((q) => { q.text.title.style = 'outlineFill'; q.text.title.pen = 'red'; q.text.title.fillPen = 'blue'; });
    const use = penUsage(p);
    expect(use.find((u) => u.section === 'Title outline')?.penId).toBe('red');
    expect(use.find((u) => u.section === 'Title fill')?.penId).toBe('blue');
    expect(penUsage(base()).some((u) => u.section === 'Title')).toBe(true);
    expect(penUsage(base()).some((u) => u.section === 'Title fill')).toBe(false);
  });
});

describe('title styles in the exports', () => {
  const run = (edit: (p: Project) => void, mode: 'print' | 'plotter' = 'print') => {
    const p = base(edit);
    return { p, out: prepareScene(buildScene(p), mode, fonts, { pens: p.pens }) };
  };
  const titleParts = (out: { prims: unknown[] }, size: number) => paths(out).filter((x) => x.d.length > 2000 && x.pen !== undefined && size > 0);

  it('print: filled letters are a fill path; outline-only is a stroked path with no fill', () => {
    const plain = run((q) => { q.text.location.visible = false; q.text.info.visible = false; q.showWatermark = false; q.profile.enabled = false; }).out;
    expect(paths(plain).some((x) => x.mode === 'fill' && x.d.length > 1500)).toBe(true);
    const outline = run((q) => { q.text.title.style = 'outline'; q.text.title.outlineMm = 0.5; q.text.location.visible = false; q.text.info.visible = false; q.showWatermark = false; q.profile.enabled = false; }).out;
    expect(paths(outline).some((x) => x.mode === 'stroke' && x.widthMm === 0.5 && x.d.length > 1500)).toBe(true);
    // the big title shape is not filled any more (other fills are the elevation profile and small text)
    expect(paths(outline).filter((x) => x.mode === 'fill' && x.d.length > 1500)).toHaveLength(0);
  });
  it('print: outline with fill is a fill in the fill pen plus a stroke in the outline pen', () => {
    const { out } = run((q) => { q.text.title.style = 'outlineFill'; q.text.title.fillPen = 'blue'; q.text.title.pen = 'red'; q.text.title.outlineMm = 0.5; });
    const fill = paths(out).find((x) => x.mode === 'fill' && x.pen === 'blue');
    const line = paths(out).find((x) => x.mode === 'stroke' && x.pen === 'red' && x.widthMm === 0.5);
    expect(fill).toBeDefined();
    expect(line).toBeDefined();
    expect(fill!.d).toBe(line!.d); // the same letter shapes
    expect(out.prims.indexOf(fill!)).toBeLessThan(out.prims.indexOf(line!));
  });
  it('plotter: outline with fill is hatch lines in the fill pen plus the outline in the outline pen', () => {
    const { out } = run((q) => { q.text.title.style = 'outlineFill'; q.text.title.fillPen = 'blue'; q.text.title.pen = 'red'; q.text.title.outlineMm = 0.3; }, 'plotter');
    const blue = paths(out).filter((x) => x.pen === 'blue' && x.mode === 'stroke');
    const red = paths(out).filter((x) => x.pen === 'red' && x.d.length > 1500 && x.d.includes('Z'));
    expect(blue.length).toBeGreaterThan(0);
    expect(red.length).toBeGreaterThan(0);
    const hatch = blue.find((x) => (x.d.match(/M/g) ?? []).length > 50)!;
    expect(hatch).toBeDefined();
    expect(hatch.widthMm).toBe(0.3);
    expect(hatch.d).not.toContain('Z'); // lines, not shapes
    expect(hatch.d).not.toContain('C'); // straight segments
  });
  it('plotter: denser hatching means more lines (solid > medium > light)', () => {
    const lines = (density: 'solid' | 'medium' | 'light') => {
      const { out } = run((q) => { q.text.title.style = 'outlineFill'; q.text.title.fillPen = 'blue'; q.text.title.fillDensity = density; }, 'plotter');
      const hatch = paths(out).filter((x) => x.pen === 'blue' && (x.d.match(/M/g) ?? []).length > 5);
      return hatch.reduce((n, x) => n + (x.d.match(/M/g) ?? []).length, 0);
    };
    const [s, m, l] = [lines('solid'), lines('medium'), lines('light')];
    expect(s).toBeGreaterThan(m);
    expect(m).toBeGreaterThan(l);
    expect(s / m).toBeGreaterThan(HATCH_FACTOR.medium / HATCH_FACTOR.solid * 0.7);
  });
  it('plotter: hatch spacing follows the fill pen\'s tip, so a coarser pen draws fewer lines', () => {
    const lines = (tip: number) => {
      const { out } = run((q) => { q.text.title.style = 'outlineFill'; q.text.title.fillPen = 'blue'; q.pens.find((x) => x.id === 'blue')!.tipMm = tip; }, 'plotter');
      return paths(out).filter((x) => x.pen === 'blue' && (x.d.match(/M/g) ?? []).length > 5).reduce((n, x) => n + (x.d.match(/M/g) ?? []).length, 0);
    };
    expect(lines(0.6)).toBeLessThan(lines(0.3));
  });
  it('plotter: an outline-only title is passes of the pen: a heavy outline repeats', () => {
    const count = (mm: number) => {
      const { out } = run((q) => { q.text.title.style = 'outline'; q.text.title.outlineMm = mm; q.text.location.visible = false; q.text.info.visible = false; q.showWatermark = false; q.profile.enabled = false; }, 'plotter');
      return paths(out).filter((x) => x.pen === 'ink' && x.d.length > 1500).length;
    };
    expect(count(0.9)).toBe(3 * count(0.3));
  });
  it('plotter: a plain filled title is still just its outline (no hatching unless asked)', () => {
    const { out } = run(() => {}, 'plotter');
    expect(paths(out).some((x) => x.d.length > 1500 && x.d.includes('Z') && x.widthMm === 0.3)).toBe(true);
    expect(paths(out).filter((x) => (x.d.match(/M/g) ?? []).length > 100)).toHaveLength(0);
  });
  it('plotter layers: the hatch and the outline each land in one layer per color and tip', () => {
    const { out } = run((q) => { q.text.title.style = 'outlineFill'; q.text.title.fillPen = 'blue'; q.text.title.pen = 'red'; }, 'plotter');
    const ids = [...sceneToSvg(out).matchAll(/<g id="(layer-[^"]+)"/g)].map((m) => m[1]!);
    expect(ids).toContain('layer-2f6f9f-0.3mm');
    expect(ids).toContain('layer-b4441f-0.3mm');
    expect(ids.every((i) => i.endsWith('mm'))).toBe(true);
  });
});

describe('hatching the elevation profile', () => {
  const run = (hatch: 'off' | 'light' | 'medium' | 'solid') => {
    const p = base((q) => { q.profile.hatch = hatch; q.text.title.visible = false; q.text.location.visible = false; q.text.info.visible = false; q.showWatermark = false; });
    return prepareScene(buildScene(p), 'plotter', fonts, { pens: p.pens });
  };
  const fillLines = (out: { prims: unknown[] }) => paths(out).filter((x) => (x.d.match(/M/g) ?? []).length > 3).reduce((n, x) => n + (x.d.match(/M/g) ?? []).length, 0);
  it('is off by default: the profile is only outlined', () => {
    expect(defaultProject().profile.hatch).toBe('off');
    expect(fillLines(run('off'))).toBe(0);
  });
  it('hatches the profile when asked, denser for solid than light', () => {
    expect(fillLines(run('light'))).toBeGreaterThan(5);
    expect(fillLines(run('solid'))).toBeGreaterThan(fillLines(run('light')));
  });
  it('keeps the profile outline as well', () => {
    expect(paths(run('medium')).some((x) => x.d.includes('Z') || /L/.test(x.d))).toBe(true);
  });
  it('print is unaffected by the hatch setting', () => {
    const p = base((q) => { q.profile.hatch = 'solid'; });
    const out = prepareScene(buildScene(p), 'print', fonts, { pens: p.pens });
    expect(paths(out).some((x) => x.mode === 'fill' && x.opacity === p.profile.opacity)).toBe(true);
    expect(titleCount(out)).toBeGreaterThan(0);
  });
  function titleCount(out: { prims: unknown[] }) { return paths(out).length; }
});
