import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'opentype.js';
import { prepareScene, textToPath, PLOTTER_PEN_MM, type FontSet } from '../src/export/outlines';
import { sceneToSvg } from '../src/export/svg';
import { buildScene } from '../src/scene/buildScene';
import { defaultProject } from '../src/scene/project';
import { sampleTrack } from '../src/sample';
import type { TextPrim } from '../src/scene/types';

const load = (path: string) => {
  const b = readFileSync(path);
  return parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
const fonts = {
  sans: load('node_modules/@fontsource/inter/files/inter-latin-400-normal.woff'),
  serif: load('node_modules/@fontsource/source-serif-4/files/source-serif-4-latin-400-normal.woff'),
} as unknown as FontSet;

const nums = (d: string) => d.match(/-?\d+(\.\d+)?/g)!.map(Number);
const xs = (d: string) => nums(d).filter((_, i) => i % 2 === 0); // rough: M/L/C coords alternate x,y

const base: TextPrim = {
  kind: 'text', text: 'HIKE', x: 100, y: 50, anchor: 'start', sizeMm: 10, trackingMm: 1,
  fontFamily: 'x', fontKey: 'sans', color: '#000',
};

describe('text outlines', () => {
  it('produces vector path data near the requested position and size', () => {
    const d = textToPath(base, fonts);
    expect(d.startsWith('M')).toBe(true);
    const all = nums(d);
    expect(Math.min(...xs(d))).toBeGreaterThanOrEqual(99);
    expect(Math.max(...all.filter((_, i) => i % 2 === 1))).toBeLessThanOrEqual(50.5); // baseline at y=50
  });
  it('anchors start/middle/end consistently', () => {
    const xmin = (a: TextPrim['anchor']) => Math.min(...xs(textToPath({ ...base, anchor: a }, fonts)));
    expect(xmin('middle')).toBeLessThan(xmin('start'));
    expect(xmin('end')).toBeLessThan(xmin('middle'));
  });
  it('serif and sans differ', () => {
    expect(textToPath(base, fonts)).not.toEqual(textToPath({ ...base, fontKey: 'serif' }, fonts));
  });
  it('wider tracking spreads letters', () => {
    const w = (tr: number) => Math.max(...xs(textToPath({ ...base, trackingMm: tr }, fonts)));
    expect(w(3)).toBeGreaterThan(w(0));
  });
  it('handles the glyphs the poster uses (° · digits)', () => {
    expect(() => textToPath({ ...base, text: '46.8522° N  121.7575° W  ·  4,957 ft' }, fonts)).not.toThrow();
  });
});

describe('export modes', () => {
  const scene = buildScene({ ...defaultProject(), points: sampleTrack() });
  it('live keeps <text>', () => {
    expect(sceneToSvg(prepareScene(scene, 'live'))).toContain('<text');
  });
  it('print has no <text> and keeps fills', () => {
    const svg = sceneToSvg(prepareScene(scene, 'print', fonts));
    expect(svg).not.toContain('<text');
    expect(svg).toContain('fill="#1f2a24" stroke="none"');
  });
  it('plotter is strokes only: no fills, no opacity, no text', () => {
    const out = prepareScene(scene, 'plotter', fonts);
    expect(out.prims.every((p) => p.kind === 'path' && p.mode === 'stroke' && p.opacity === undefined)).toBe(true);
    expect(sceneToSvg(out)).not.toMatch(/stroke="none"|<text|opacity=/);
    expect(out.prims.some((p) => p.kind === 'path' && p.widthMm === PLOTTER_PEN_MM)).toBe(true);
  });
  it('plotter layers are all strokes at the one pen width, so one layer per color', () => {
    const svg = sceneToSvg(prepareScene(scene, 'plotter', fonts));
    const ids = [...svg.matchAll(/<g id="(layer-[^"]+)"/g)].map((m) => m[1]!);
    // route (orange) and everything else (ink): heavy lines became repeated passes of the same pen
    expect(ids).toHaveLength(2);
    expect(ids.every((i) => i.endsWith(`-${PLOTTER_PEN_MM}mm`))).toBe(true);
  });
});
