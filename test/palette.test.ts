import { describe, expect, it } from 'vitest';
import { addPen, defaultPens, featurePenId, mapPenRefs, MAX_PENS, penFor, penUsage, removePen } from '../src/scene/pens';
import { defaultProject, type Project } from '../src/scene/project';
import { buildScene } from '../src/scene/buildScene';
import { prepareScene, tipFor, type FontSet } from '../src/export/outlines';
import { sceneToSvg } from '../src/export/svg';
import { summarizePasses } from '../src/export/offset';
import { LAYER_KEYS } from '../src/city/types';
import { cityData, cityProject, SEATTLE } from './fixture';
import type { PathPrim, Prim, TextPrim } from '../src/scene/types';

const fake = { unitsPerEm: 1000, charToGlyph: () => ({ advanceWidth: 500, getPath: () => ({ toPathData: () => 'M0 0L1 1', commands: [{ type: 'M', x: 0, y: 0 }, { type: 'L', x: 1, y: 1 }] }) }) };
const fonts = { sans: fake, serif: fake } as unknown as FontSet;
const BLACK = '#111111';
const GREEN = '#1e7a3c';
const BLUE = '#1f55b5';
const paths = (ps: Prim[]) => ps.filter((x): x is PathPrim => x.kind === 'path');
const texts = (ps: Prim[]) => ps.filter((x): x is TextPrim => x.kind === 'text');
const colorsOf = (ps: Prim[]) => new Set(ps.map((x) => x.color));

describe('the palette', () => {
  it('starts with black, green and blue isograph pens, all 0.3 mm', () => {
    expect(defaultPens()).toEqual([
      { id: 'black', name: 'Black', color: BLACK, tipMm: 0.3 },
      { id: 'green', name: 'Green', color: GREEN, tipMm: 0.3 },
      { id: 'blue', name: 'Blue', color: BLUE, tipMm: 0.3 },
    ]);
  });
  it('penFor finds a pen, and falls back to the first one for an unknown id', () => {
    const pens = defaultPens();
    expect(penFor(pens, 'green').color).toBe(GREEN);
    expect(penFor(pens, 'gone')).toBe(pens[0]);
    expect(penFor(pens, undefined)).toBe(pens[0]);
  });
  it('addPen adds distinct pens up to the limit, then refuses', () => {
    const p = defaultProject();
    const added = [];
    while (p.pens.length < MAX_PENS) added.push(addPen(p)!);
    expect(p.pens).toHaveLength(MAX_PENS);
    expect(new Set(p.pens.map((x) => x.id)).size).toBe(MAX_PENS);
    expect(new Set(p.pens.map((x) => x.color)).size).toBe(MAX_PENS);
    expect(addPen(p)).toBeUndefined();
    expect(added.every((x) => x.tipMm === 0.3)).toBe(true);
  });
  it('a new pen gets a fresh id even after others were removed', () => {
    const p = defaultProject();
    const a = addPen(p)!;
    const b = addPen(p)!;
    removePen(p, a.id);
    const c = addPen(p)!;
    expect(new Set([b.id, c.id]).size).toBe(2);
  });
});

describe('the default layer pens', () => {
  it('parks are green, water blue, everything else black', () => {
    const p = defaultProject();
    expect(p.layers.parks.pen).toBe('green');
    expect(p.layers.water.pen).toBe('blue');
    for (const k of LAYER_KEYS.filter((k) => k !== 'parks' && k !== 'water')) expect(p.layers[k].pen, k).toBe('black');
  });
  it('every layer\'s pen exists in the palette', () => {
    const p = defaultProject();
    for (const k of LAYER_KEYS) expect(p.pens.some((x) => x.id === p.layers[k].pen), k).toBe(true);
  });
  it('line thicknesses are whole passes of the default pen: 1, 2 or 3 passes', () => {
    const p = defaultProject();
    expect(LAYER_KEYS.map((k) => p.layers[k].weightMm)).toEqual([0.3, 0.3, 0.3, 0.3, 0.3, 0.54, 0.78, 0.3]);
  });
});

describe('removing a pen', () => {
  it('moves everything that used it to the first remaining pen', () => {
    const p = defaultProject();
    const extra = addPen(p)!;
    mapPenRefs(p, () => extra.id); // everything on the new pen
    expect(removePen(p, extra.id)).toBe(true);
    expect(p.pens.some((x) => x.id === extra.id)).toBe(false);
    const seen: string[] = [];
    mapPenRefs(p, (id) => { seen.push(id); return id; });
    expect(new Set(seen)).toEqual(new Set(['black']));
  });
  it('refuses to remove the last pen, or one that does not exist', () => {
    const p = defaultProject();
    p.pens = [p.pens[0]!];
    expect(removePen(p, 'black')).toBe(false);
    expect(removePen(defaultProject(), 'nope')).toBe(false);
  });
  it('removing the blue pen sends water to the first pen, and the override that now matches the default goes away', () => {
    const p = defaultProject();
    expect(p.features.pens.overrides).toEqual({ waterLabel: 'blue' });
    removePen(p, 'blue');
    expect(p.layers.water.pen).toBe('black');
    expect(featurePenId(p.features, 'waterLabel')).toBe('black');
    expect(p.features.pens.overrides).toEqual({});
  });
  it('mapPenRefs reaches every part of the design that has a pen', () => {
    const p = defaultProject();
    const seen: string[] = [];
    mapPenRefs(p, (id) => { seen.push(id); return 'x'; });
    // 8 layers, north, title, title fill, location, info, watermark, border, landmarks default + 1 override
    expect(seen.length).toBe(LAYER_KEYS.length + 8 + 1);
    for (const k of LAYER_KEYS) expect(p.layers[k].pen).toBe('x');
    expect(p.north.pen).toBe('x');
    expect(p.text.title.pen).toBe('x');
    expect(p.text.title.fillPen).toBe('x');
    expect(p.text.location.pen).toBe('x');
    expect(p.text.info.pen).toBe('x');
    expect(p.watermarkPen).toBe('x');
    expect(p.border.pen).toBe('x');
    expect(p.features.pens).toEqual({ default: 'x', overrides: { waterLabel: 'x' } });
  });
});

describe('which part uses which pen', () => {
  it('lists the sections that are on, with their pens', () => {
    const use = penUsage(cityProject());
    const of = (section: string) => use.find((u) => u.section === section)?.penId;
    expect(of('Parks and green space')).toBe('green');
    expect(of('Water')).toBe('blue');
    expect(of('Major roads')).toBe('black');
    expect(of('Map info')).toBe('black');
    expect(of('Landmarks')).toBe('black');
    expect(of('Water names')).toBe('blue');
    expect(of('North arrow')).toBeUndefined(); // off by default
    expect(of('Footpaths and trails')).toBeUndefined(); // off by default
  });
  it('leaves out sections that are switched off', () => {
    const p = defaultProject();
    p.layers.buildings.enabled = false;
    p.features.enabled = false;
    p.showWatermark = false;
    const off = penUsage(p).map((u) => u.section);
    for (const s of ['Buildings', 'Landmarks', 'Water names', 'Attribution']) expect(off).not.toContain(s);
  });
  it('a pen nothing uses has no usage', () => {
    const p = cityProject();
    const pen = addPen(p)!;
    expect(penUsage(p).some((u) => u.penId === pen.id)).toBe(false);
  });
});

describe('every section gets its color from its pen', () => {
  const build = (edit: (p: Project) => void = () => {}) => {
    const p = cityProject();
    p.north.enabled = true;
    p.features.waterLabels = true;
    p.custom = [{ id: 'custom-1', name: 'Home', kind: 'custom', lat: SEATTLE.lat, lon: SEATTLE.lon, icon: 'home' }];
    edit(p);
    return { p, ps: buildScene(p, cityData()).prims };
  };

  it('with the default pens: parks green, water blue, everything else black', () => {
    const { ps } = build();
    expect(colorsOf(ps)).toEqual(new Set([BLACK, GREEN, BLUE]));
    expect(colorsOf(paths(ps).filter((x) => x.pen === 'green'))).toEqual(new Set([GREEN]));
    expect(colorsOf(paths(ps).filter((x) => x.pen === 'blue'))).toEqual(new Set([BLUE]));
    expect(texts(ps).filter((x) => x.text === 'River Test').every((x) => x.color === BLUE)).toBe(true);
  });
  it('every primitive records the pen it was drawn with, and its color matches that pen', () => {
    const { ps } = build();
    const pens = defaultPens();
    for (const x of ps) {
      expect(x.pen, `${x.kind} without a pen`).toBeDefined();
      expect(x.color).toBe(penFor(pens, x.pen).color);
    }
  });
  it('recoloring a pen recolors every section on it', () => {
    const { ps } = build((p) => { p.pens.find((x) => x.id === 'black')!.color = '#123456'; });
    expect(colorsOf(ps)).toEqual(new Set(['#123456', GREEN, BLUE]));
  });
  it('each map layer follows the pen chosen for it', () => {
    for (const key of Object.keys(cityData().layers) as (typeof LAYER_KEYS)[number][]) {
      const { ps } = build((p) => { p.layers[key].pen = 'blue'; for (const k of LAYER_KEYS) p.layers[k].enabled = k === key; p.features.enabled = false; p.north.enabled = false; });
      const map = paths(ps).filter((x) => x.pen !== 'black'); // black is the text
      expect(map.length, key).toBeGreaterThan(0);
      expect(colorsOf(map), key).toEqual(new Set([BLUE]));
    }
  });
  it('each text block follows the pen chosen for it', () => {
    for (const [name, edit, pick] of [
      ['north', (p: Project) => { p.north.pen = 'green'; }, (x: Prim) => x.kind === 'text' && x.text === 'N'],
      ['title', (p: Project) => { p.text.title.pen = 'blue'; }, (x: Prim) => x.kind === 'text' && x.text === 'SEATTLE'],
      ['info', (p: Project) => { p.text.info.pen = 'green'; }, (x: Prim) => x.kind === 'text' && /^1:/.test(x.text)],
      ['watermark', (p: Project) => { p.watermarkPen = 'green'; }, (x: Prim) => x.kind === 'text' && x.text.startsWith('Map data')],
    ] as const) {
      const { p, ps } = build(edit);
      const hit = ps.filter(pick);
      expect(hit.length, name).toBeGreaterThan(0);
      const id = name === 'north' ? p.north.pen : name === 'title' ? p.text.title.pen : name === 'info' ? p.text.info.pen : p.watermarkPen;
      for (const h of hit) expect(h.color, name).toBe(penFor(p.pens, id).color);
    }
  });
});

describe('landmark pens: a default with overrides', () => {
  const data = {
    layers: {},
    landmarks: [
      { id: 'n1', name: 'Space Needle', kind: 'attraction' as const, lat: SEATTLE.lat + 0.004, lon: SEATTLE.lon - 0.003 },
      { id: 'n2', name: 'King Street', kind: 'station' as const, lat: SEATTLE.lat - 0.004, lon: SEATTLE.lon + 0.003 },
    ],
  };
  const scene = (edit: (p: Project) => void) => { const p = cityProject(); edit(p); return buildScene(p, data).prims; };
  const label = (ps: Prim[], text: string) => texts(ps).find((x) => x.text === text)!;

  it('everything uses the default pen to begin with', () => {
    const ps = scene(() => {});
    expect(label(ps, 'Space Needle').color).toBe(BLACK);
    expect(label(ps, 'King Street').color).toBe(BLACK);
  });
  it('changing the default pen moves every landmark that has no override', () => {
    const ps = scene((p) => { p.features.pens.default = 'green'; });
    expect(label(ps, 'Space Needle').color).toBe(GREEN);
    expect(label(ps, 'King Street').color).toBe(GREEN);
  });
  it('an override moves just that kind, markers and labels together', () => {
    const ps = scene((p) => { p.features.pens.overrides.attraction = 'blue'; });
    expect(label(ps, 'Space Needle').color).toBe(BLUE);
    expect(label(ps, 'King Street').color).toBe(BLACK);
    // markers are drawn one path per pen, so the two kinds are in different marker paths
    const markers = paths(ps).filter((x) => x.round && (x.pen === 'blue' || x.pen === 'black') && x.d.length < 400);
    expect(new Set(markers.map((m) => m.pen)).size).toBe(2);
  });
  it('water names stay blue when the landmarks default changes', () => {
    const p = cityProject();
    p.features.pens.default = 'green';
    expect(featurePenId(p.features, 'waterLabel')).toBe('blue');
    expect(featurePenId(p.features, 'attraction')).toBe('green');
  });
  it('clearing an override returns that kind to the default', () => {
    const p = cityProject();
    p.features.pens.overrides.waterLabel = undefined;
    expect(featurePenId(p.features, 'waterLabel')).toBe(p.features.pens.default);
  });
});

describe('plotter export uses each pen\'s own tip', () => {
  const run = (edit: (p: Project) => void) => {
    const p = cityProject();
    edit(p);
    return { p, out: prepareScene(buildScene(p, cityData()), 'plotter', fonts, { pens: p.pens }) };
  };
  it('lines on a pen are drawn at that pen\'s tip width', () => {
    const { out } = run((p) => { p.pens.find((x) => x.id === 'green')!.tipMm = 0.5; });
    expect(paths(out.prims).filter((x) => x.pen === 'green').every((x) => x.widthMm === 0.5)).toBe(true);
    expect(paths(out.prims).filter((x) => x.pen === 'black').every((x) => x.widthMm === 0.3)).toBe(true);
  });
  it('a coarser pen needs fewer passes for the same line weight', () => {
    const count = (tip: number) => run((p) => { p.layers.parks.weightMm = 1.02; p.layers.parks.fill = 'off'; p.pens.find((x) => x.id === 'green')!.tipMm = tip; }).out.prims.filter((x) => x.pen === 'green').length;
    expect(count(0.3)).toBe(4); // 1.02 mm: four passes of a 0.3 mm pen
    expect(count(0.6)).toBe(2); // 0.6 + 0.48 = 1.08 mm, nearest to 1.02
    expect(count(1.02)).toBe(1);
  });
  it('layers follow color and tip: two pens of one color but different tips are two layers', () => {
    const { out } = run((p) => {
      p.pens.push({ id: 'fine', name: 'Fine black', color: BLACK, tipMm: 0.1 });
      p.north.enabled = true;
      p.north.pen = 'fine';
    });
    const ids = [...sceneToSvg(out).matchAll(/<g id="(layer-[^"]+)"/g)].map((m) => m[1]!);
    expect(ids).toContain(`layer-${BLACK.slice(1)}-0.1mm`);
    expect(ids).toContain(`layer-${BLACK.slice(1)}-0.3mm`);
  });
  it('two pens with the same color and tip share a layer', () => {
    const { out } = run((p) => { p.pens.push({ id: 'twin', name: 'Twin black', color: BLACK, tipMm: 0.3 }); p.layers.buildings.pen = 'twin'; });
    const ids = [...sceneToSvg(out).matchAll(/<g id="(layer-[^"]+)"/g)].map((m) => m[1]!);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((i) => i.startsWith(`layer-${BLACK.slice(1)}`))).toHaveLength(1);
  });
  it('tipFor falls back to the default when there is no palette or no pen on the prim', () => {
    expect(tipFor({ pen: 'green' }, { pens: defaultPens() })).toBe(0.3);
    expect(tipFor({ pen: 'green' }, { penMm: 0.45 })).toBe(0.45);
    expect(tipFor({}, { pens: defaultPens() })).toBe(0.3);
    expect(tipFor({ pen: 'green' }, { pens: [{ id: 'green', name: 'g', color: GREEN, tipMm: 0.7 }] })).toBe(0.7);
  });
  it('the pass summary uses each prim\'s own tip', () => {
    const p = cityProject();
    p.pens.find((x) => x.id === 'black')!.tipMm = 0.5;
    const sc = buildScene(p, cityData());
    const summary = summarizePasses(sc.prims, (x) => tipFor(x as { pen?: string }, { pens: p.pens }));
    // 0.78 mm major roads with a 0.5 mm pen: two passes, 0.9 mm wide
    expect(summary).toEqual([{ widthMm: 0.9, passes: 2, forced: false }]);
  });
  it('print and live exports ignore tips: real widths and colors are kept', () => {
    const p = cityProject();
    p.pens.find((x) => x.id === 'black')!.tipMm = 0.9;
    const print = prepareScene(buildScene(p, cityData()), 'print', fonts, { pens: p.pens });
    expect(paths(print.prims).some((x) => x.widthMm === 0.9 && x.pen === 'black')).toBe(true);
  });
});
