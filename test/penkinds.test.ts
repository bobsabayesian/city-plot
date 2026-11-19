import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'opentype.js';
import { addPen, applySavedPen, cleanSavedPen, contrast, defaultPens, inkWidth, isDarkPaper, loadSavedPens, MIN_INK_CONTRAST, PAPER_COLORS, penKind, penSlots, penUsage, savedFromPen, storeSavedPens, withKind, withSavedPen } from '../src/scene/pens';
import { inkAlpha, penLayerOf, sceneToSvg } from '../src/export/svg';
import { prepareScene, tipFor, type FontSet } from '../src/export/outlines';
import { buildScene, composeScene } from '../src/scene/buildScene';
import { defaultProject } from '../src/scene/project';
import { cityData, cityProject, SEATTLE } from './fixture';
import type { PathPrim, Scene } from '../src/scene/types';

const ink = defaultPens()[0]!;

describe('pen kinds', () => {
  it('a technical pen with no spread draws exactly its nib', () => {
    expect(inkWidth(ink)).toBe(0.3);
    expect(tipFor({ pen: ink.id }, { pens: [ink] })).toBe(0.3);
  });
  it('a pen with no kind at all (an old file) also draws exactly its nib', () => {
    const bare = { id: 'x', name: 'x', color: '#000000', tipMm: 0.4 };
    expect(inkWidth(bare)).toBe(0.4);
  });
  it('a kind sets the spread and transparency; a marker leaves a wider line than its tip', () => {
    const m = withKind({ ...ink, tipMm: 1 }, 'marker');
    expect(m.kind).toBe('marker');
    expect(m.gainMm).toBe(0.25);
    expect(inkWidth(m)).toBe(1.5);
    expect(tipFor({ pen: m.id }, { pens: [m] })).toBe(1.5);
  });
  it('changing kind snaps the tip to a size that kind comes in, and custom keeps it', () => {
    expect(withKind({ ...ink, tipMm: 0.3 }, 'marker').tipMm).toBe(0.5);
    expect(withKind({ ...ink, tipMm: 0.33 }, 'custom').tipMm).toBe(0.33);
    expect(withKind({ ...ink, tipMm: 0.3 }, 'fineliner').tipMm).toBe(0.3);
    expect(penKind('nonsense').id).toBe('custom');
  });
  it('the technical pen offers the usual isograph nibs', () => {
    expect(penKind('technical').tipsMm).toEqual(expect.arrayContaining([0.18, 0.25, 0.35, 0.5]));
  });
});

describe('ink spread changes the passes of a layer', () => {
  const widthOf = (spread: number, weight: number) => {
    const p = cityProject((q) => {
      q.features.enabled = false;
      q.pens[0]!.gainMm = spread;
      q.layers.major.weightMm = weight;
    });
    const ps = buildScene(p, cityData()).prims.filter((x): x is PathPrim => x.kind === 'path' && x.pen === 'black' && x.mode === 'stroke');
    return Math.max(...ps.map((x) => x.widthMm!)); // the thickest black line is the major roads
  };
  it('a pass is the nib plus the spread, so the same thickness is a different line', () => {
    expect(widthOf(0, 0.78)).toBeCloseTo(0.78, 6); // 3 passes of 0.3 at 80%
    // 0.1 mm each side: a pass is 0.5 mm, and 0.78 mm is 2 passes: 0.5 + 0.4 = 0.9 mm
    expect(widthOf(0.1, 0.78)).toBeCloseTo(0.9, 6);
  });
  it('the plotter then draws it with the pass count that line needs', () => {
    const p = cityProject((q) => { q.features.enabled = false; q.pens[0]!.gainMm = 0.1; q.layers.major.weightMm = 0.78; for (const k of ['parks', 'water', 'buildings', 'minor', 'secondary'] as const) q.layers[k].enabled = false; });
    const fake = { unitsPerEm: 1000, charToGlyph: () => ({ advanceWidth: 500, getPath: () => ({ toPathData: () => 'M0 0L1 1', commands: [{ type: 'M', x: 0, y: 0 }] }) }) };
    const out = prepareScene(buildScene(p, cityData()), 'plotter', { sans: fake, serif: fake } as unknown as FontSet, { pens: p.pens });
    const lines = out.prims.filter((x): x is PathPrim => x.kind === 'path' && x.pen === 'black' && x.d.startsWith('M') && !x.d.includes('Z') && x.widthMm === 0.5);
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });
});

describe('saved pen library', () => {
  const store = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }; };
  it('round-trips and replaces a pen of the same name in place', () => {
    const s = store();
    const a = savedFromPen('Micron 0.3', withKind(ink, 'fineliner'));
    const b = savedFromPen('Molotow 1', withKind({ ...ink, tipMm: 1 }, 'marker'));
    storeSavedPens(withSavedPen(withSavedPen([], a), b), s);
    expect(loadSavedPens(s).map((x) => x.name)).toEqual(['Micron 0.3', 'Molotow 1']);
    expect(withSavedPen([a, b], { ...a, name: 'micron 0.3', tipMm: 0.5 }).map((x) => x.tipMm)).toEqual([0.5, 1]);
  });
  it('ignores junk in storage', () => {
    const bad = { getItem: () => '[{"name":"x"},{"name":"y","color":"red"},5,null]' };
    expect(loadSavedPens(bad)).toEqual([]);
    expect(loadSavedPens({ getItem: () => 'not json' })).toEqual([]);
    expect(cleanSavedPen({ name: 'ok', color: '#AABBCC', kind: 'gel', tipMm: 0.5, transparency: 0.1, gainMm: 0.05 })?.color).toBe('#aabbcc');
    expect(cleanSavedPen({ name: 'ok', color: '#aabbcc', kind: 'gel', tipMm: 99, transparency: 0.1, gainMm: 0.05 })).toBeNull();
  });
  it('applying a saved pen keeps the id so what used the pen still does', () => {
    const s = savedFromPen('Molotow 2', withKind({ ...ink, tipMm: 2, color: '#ffffff' }, 'marker'));
    expect(applySavedPen(ink, s)).toMatchObject({ id: ink.id, name: 'Molotow 2', kind: 'marker', tipMm: 2, color: '#ffffff' });
  });
});

describe('paper', () => {
  it('has swatches that are valid colors, including the default paper', () => {
    for (const c of PAPER_COLORS) expect(c.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(PAPER_COLORS.map((c) => c.color)).toContain(defaultProject().paper);
  });
  it('tells dark paper from light, and a pen too close to the paper from one that shows', () => {
    expect(isDarkPaper('#0d0d0d')).toBe(true);
    expect(isDarkPaper('#16213e')).toBe(true);
    expect(isDarkPaper('#f3ead3')).toBe(false);
    expect(isDarkPaper('#b08968')).toBe(false);
    expect(contrast('#111111', '#0d0d0d')).toBeLessThan(MIN_INK_CONTRAST); // black ink on black paper
    expect(contrast('#111111', '#f6f3ec')).toBeGreaterThan(MIN_INK_CONTRAST);
    expect(contrast('#ffffff', '#0d0d0d')).toBeGreaterThan(10);
  });
});

describe('plotter preview ink', () => {
  const scene = (pen: string): Scene => ({ widthMm: 10, heightMm: 10, paper: '#ffffff', prims: [{ kind: 'path', d: 'M0 0L5 5', color: '#000000', mode: 'stroke', widthMm: 1, pen }] });
  const marker = withKind({ ...ink, tipMm: 1 }, 'marker');
  const micron = withKind({ ...ink, tipMm: 0.3 }, 'fineliner');
  it('a marker shows less of its color per pass than a fineliner, and multiplies on light paper', () => {
    expect(inkAlpha(marker)).toBeLessThan(inkAlpha(micron));
    const svg = sceneToSvg(scene(marker.id), { ink: { pens: [marker], dark: false } });
    expect(svg).toContain(`stroke-opacity="${inkAlpha(marker)}"`);
    expect(svg).toContain('mix-blend-mode:multiply');
  });
  it('on dark paper inks are laid over it, not multiplied into it', () => {
    expect(sceneToSvg(scene(marker.id), { ink: { pens: [marker], dark: true } })).not.toContain('mix-blend-mode');
  });
  it('without the preview option the file is unchanged, so exports carry no blend or opacity', () => {
    expect(sceneToSvg(scene(marker.id))).not.toMatch(/stroke-opacity|mix-blend/);
  });
  it('a pen with no transparency set is drawn mostly opaque', () => {
    expect(inkAlpha({ id: 'x', name: 'x', color: '#000000', tipMm: 0.3 })).toBeGreaterThan(0.6);
  });
});

describe('pen slots: the table of which pen draws what', () => {
  it('lists the same parts as the pen usage, and only parts that are on', () => {
    const p = cityProject();
    expect(penSlots(p).map((s) => s.section)).toEqual(penUsage(p).map((u) => u.section));
    p.north.enabled = false;
    expect(penSlots(p).some((s) => s.key === 'north')).toBe(false);
    p.north.enabled = true;
    expect(penSlots(p).find((s) => s.key === 'north')?.group).toBe('north');
  });
  it('changes a layer\'s pen', () => {
    const p = cityProject();
    const pen = addPen(p)!;
    penSlots(p).find((s) => s.key === 'layer-major')!.set(p, pen.id);
    expect(p.layers.major.pen).toBe(pen.id);
  });
  it('a landmark kind can go back to the landmarks\' pen, and the landmarks\' pen absorbs equal overrides', () => {
    const p = cityProject();
    const pen = addPen(p)!;
    p.features.pens.overrides.museum = pen.id;
    const museum = penSlots(p).find((s) => s.key === 'landmarks-museum')!;
    expect(museum.inherits).toBe(true);
    museum.set(p, undefined);
    expect(p.features.pens.overrides.museum).toBeUndefined();
    p.features.pens.overrides.museum = pen.id;
    penSlots(p).find((s) => s.key === 'landmarks')!.set(p, pen.id);
    expect(p.features.pens.default).toBe(pen.id);
    expect(p.features.pens.overrides.museum).toBeUndefined();
  });
  it('each part names the group of settings it lives in', () => {
    const groups = new Set(penSlots(cityProject()).map((s) => s.group));
    expect([...groups].sort()).toEqual(['export', 'landmarks', 'layers', 'type']);
  });
});

describe('layers follow pens', () => {
  const pens = [
    { id: 'a', name: 'Black', color: '#111111', tipMm: 0.3 },
    { id: 'b', name: 'Green', color: '#1e7a3c', tipMm: 0.5 },
    { id: 'c', name: 'Fine black', color: '#111111', tipMm: 0.1 },
  ];
  const line = (pen: string | undefined, color: string, w: number): PathPrim => ({ kind: 'path', d: 'M0 0L5 5', color, pen, mode: 'stroke', widthMm: w });
  const scene = (prims: PathPrim[]): Scene => ({ widthMm: 100, heightMm: 100, paper: '#fff', prims });
  it('one layer per pen, named after it, in the order of the palette (not first use)', () => {
    const svg = sceneToSvg(scene([line('c', '#111111', 0.1), line('b', '#1e7a3c', 0.5), line('a', '#111111', 0.3), line('a', '#111111', 0.3)]), { layers: 'pen', pens });
    const labels = [...svg.matchAll(/inkscape:label="([^"]+)"/g)].map((m) => m[1]);
    expect(labels).toEqual(['Pen 1: Black (0.3 mm, #111111)', 'Pen 2: Green (0.5 mm, #1e7a3c)', 'Pen 3: Fine black (0.1 mm, #111111)']);
    expect((svg.match(/<g id="/g) ?? []).length).toBe(3);
  });
  it('two pens of the same color but different tips are two layers', () => {
    expect((sceneToSvg(scene([line('a', '#111111', 0.3), line('c', '#111111', 0.1)]), { layers: 'pen', pens }).match(/<g id="/g) ?? []).length).toBe(2);
  });
  it('anything without a pen of the palette goes to its own "no pen" layer at the end', () => {
    expect(penLayerOf(line(undefined, '#123456', 0.3), pens).label).toMatch(/^No pen/);
    expect(penLayerOf(line('gone', '#123456', 0.3), pens).rank).toBe(pens.length);
  });
  it('the default is unchanged: a layer per color and width', () => {
    const svg = sceneToSvg(scene([line('a', '#111111', 0.3), line('c', '#111111', 0.1)]));
    expect(svg).toContain('layer-111111-0.3mm');
    expect(svg).toContain('layer-111111-0.1mm');
  });
});

describe('a whole plotter map, with a layer per pen', () => {
  const buf = (f: string) => { const b = readFileSync(f); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer; };
  const fonts = { sans: parse(buf('node_modules/@fontsource/inter/files/inter-latin-400-normal.woff')), serif: parse(buf('node_modules/@fontsource/source-serif-4/files/source-serif-4-latin-400-normal.woff')) } as unknown as FontSet;
  const p = cityProject((q) => { q.custom = [{ id: 'custom-1', name: 'Home', kind: 'custom', lat: SEATTLE.lat, lon: SEATTLE.lon, icon: 'home' }]; q.north.enabled = true; });
  const out = prepareScene(composeScene(p, cityData()).scene, 'plotter', fonts, { pens: p.pens });
  const svg = sceneToSvg(out, { layers: 'pen', pens: p.pens });
  it('no fills, no opacity, and each layer is exactly its pen', () => {
    expect(svg).not.toMatch(/fill="#/);
    expect(svg).not.toMatch(/opacity=/);
    const groups = svg.split('<g id="').slice(1);
    expect(groups.length).toBeLessThanOrEqual(p.pens.length);
    for (const g of groups) {
      const pen = p.pens[+g.match(/^pen-(\d+)-/)![1]! - 1]!;
      expect([...new Set([...g.matchAll(/stroke-width="([\d.]+)"/g)].map((m) => +m[1]!))]).toEqual([inkWidth(pen)]);
      expect(new Set([...g.matchAll(/stroke="(#[0-9a-f]{6})"/g)].map((m) => m[1])).size).toBe(1);
    }
  });
  it('all filled text, big or small, is outlined and filled in with hatch lines of its own pen (or single strokes)', () => {
    const text = out.prims.filter((x): x is PathPrim => x.kind === 'path' && (x.d.match(/M/g) ?? []).length > 40);
    expect(text.length).toBeGreaterThan(0);
  });
});
