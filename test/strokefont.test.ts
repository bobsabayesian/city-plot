import { describe, expect, it } from 'vitest';
import { canStroke, textToStrokes } from '../src/export/strokefont';
import { prepareScene, SINGLE_STROKE_MAX_MM, type FontSet } from '../src/export/outlines';
import { defaultPens } from '../src/scene/pens';
import type { PathPrim, Scene, TextPrim } from '../src/scene/types';

// each letter is a 4 mm square at its own position, so the outline has something to fill
const fake = { unitsPerEm: 1000, charToGlyph: () => ({ advanceWidth: 500, getPath: (x: number, y: number) => ({ toPathData: () => `M${x} ${y}L${x + 4} ${y}L${x + 4} ${y - 4}L${x} ${y - 4}`, commands: [] }) }) };
const fonts = { sans: fake, serif: fake } as unknown as FontSet;
const text = (over: Partial<TextPrim> = {}): TextPrim => ({ kind: 'text', text: 'HI', x: 10, y: 20, anchor: 'start', sizeMm: 4, trackingMm: 0, fontFamily: 'x', fontKey: 'sans', color: '#000000', pen: 'ink', ...over });
const nums = (d: string) => (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
const pts = (d: string): [number, number][] => { const n = nums(d); return Array.from({ length: n.length / 2 }, (_, i) => [n[2 * i]!, n[2 * i + 1]!]); };

describe('single-stroke text', () => {
  it('draws letters as lines: an H is two uprights and a bar, sitting on the baseline at about the cap height', () => {
    const d = textToStrokes(text({ text: 'H', sizeMm: 10 }))!;
    expect((d.match(/M/g) ?? []).length).toBe(3);
    const ys = pts(d).map((p) => p[1]);
    expect(Math.max(...ys)).toBeCloseTo(20, 1); // the baseline is the text's y
    expect(20 - Math.min(...ys)).toBeCloseTo(7.2, 0); // a capital is about 0.72 of the size
  });
  it('anchors like filled text: start begins at x, end finishes at x, middle centers on it', () => {
    const xs = (anchor: 'start' | 'middle' | 'end') => pts(textToStrokes(text({ text: 'HIH', anchor, x: 50, sizeMm: 10 }))!).map((p) => p[0]);
    expect(Math.min(...xs('start'))).toBeGreaterThanOrEqual(50);
    expect(Math.max(...xs('end'))).toBeLessThanOrEqual(50.01);
    const m = xs('middle');
    expect((Math.min(...m) + Math.max(...m)) / 2).toBeCloseTo(50, 0);
  });
  it('letter spacing widens the line, and a justified line is stretched to its width', () => {
    const w = (t: Partial<TextPrim>) => { const x = pts(textToStrokes(text({ text: 'HIH', sizeMm: 6, ...t }))!).map((p) => p[0]); return Math.max(...x) - Math.min(...x); };
    expect(w({ trackingMm: 2 })).toBeGreaterThan(w({ trackingMm: 0 }) + 3);
    const fit = w({ fitWidthMm: 60 });
    expect(fit).toBeGreaterThan(50);
    expect(fit).toBeLessThanOrEqual(60);
  });
  it('turns about the anchor point', () => {
    const flat = pts(textToStrokes(text({ text: 'HH' }))!);
    const turned = pts(textToStrokes(text({ text: 'HH', rotate: 90 }))!);
    const spanX = (p: [number, number][]) => Math.max(...p.map((q) => q[0])) - Math.min(...p.map((q) => q[0]));
    const spanY = (p: [number, number][]) => Math.max(...p.map((q) => q[1])) - Math.min(...p.map((q) => q[1]));
    expect(spanX(turned)).toBeCloseTo(spanY(flat), 1);
    expect(spanY(turned)).toBeCloseTo(spanX(flat), 1);
  });
  it('covers the characters on the poster, in both faces, and gives up on ones it lacks', () => {
    for (const face of ['sans', 'serif'] as const) {
      expect(canStroke('46.8266° N 121.6852° W · 9.3 mi 4,957 ft July 4, 2024 (Mt. Rainier) – #1', face)).toBe(true);
      expect(canStroke('Café', face)).toBe(false);
    }
    expect(textToStrokes(text({ text: 'Café' }))).toBeUndefined();
    expect(textToStrokes(text({ text: '   ' }))).toBe('');
  });
});

describe('plotter text mode', () => {
  const pens = defaultPens();
  const scene = (t: TextPrim): Scene => ({ widthMm: 100, heightMm: 100, paper: '#fff', prims: [t] });
  const run = (t: TextPrim, plotterText?: 'outline' | 'single' | 'auto') => prepareScene(scene(t), 'plotter', fonts, { pens, plotterText }).prims as PathPrim[];
  it('outline (and the default) keeps the outlined and hatched letters', () => {
    expect(run(text(), 'outline').length).toBe(2);
    expect(run(text()).length).toBe(2);
  });
  it('single turns text into one stroke path in its pen', () => {
    const out = run(text({ text: 'Peak' }), 'single');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'path', mode: 'stroke', pen: 'ink', widthMm: 0.3 });
    expect(out[0]!.d).toBe(textToStrokes(text({ text: 'Peak' })));
  });
  it('auto uses single strokes for small text and keeps large text filled', () => {
    expect(run(text({ sizeMm: SINGLE_STROKE_MAX_MM }), 'auto')).toHaveLength(1);
    expect(run(text({ sizeMm: SINGLE_STROKE_MAX_MM + 1 }), 'auto')).toHaveLength(2);
  });
  it('text with a character the set lacks, and outlined or hatched text, are unchanged', () => {
    expect(run(text({ text: 'Café' }), 'single')).toHaveLength(2);
    expect(run(text({ mode: 'stroke', strokeMm: 0.3 }), 'single').every((p) => p.d.includes('Z') || p.d.includes('M'))).toBe(true);
    expect(run(text({ hatch: 'light' }), 'single').every((p) => !p.d.startsWith(textToStrokes(text())!.slice(0, 10)))).toBe(true);
  });
  it('a wide pen draws the strokes at its ink width', () => {
    const marker = [{ ...pens[0]!, tipMm: 1, gainMm: 0.25 }];
    const out = prepareScene(scene(text()), 'plotter', fonts, { pens: marker, plotterText: 'single' }).prims as PathPrim[];
    expect(out[0]!.widthMm).toBe(1.5);
  });
});
