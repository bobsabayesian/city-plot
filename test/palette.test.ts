import { describe, expect, it } from 'vitest';
import { addPen, defaultPens, featurePenId, mapPenRefs, MAX_PENS, penFor, penUsage, removePen } from '../src/scene/pens';
import { defaultProject, type Project } from '../src/scene/project';
import { buildScene, viewBBox } from '../src/scene/buildScene';
import { prepareScene, tipFor, type FontSet } from '../src/export/outlines';
import { sceneToSvg } from '../src/export/svg';
import { summarizePasses } from '../src/export/offset';
import { sampleTrack, sampleWaypoints } from '../src/sample';
import { loadTerrain, latToPx, lonToPx, TILE } from '../src/topo/terrain';
import type { PathPrim, Prim, TextPrim } from '../src/scene/types';

const fake = { unitsPerEm: 1000, charToGlyph: () => ({ advanceWidth: 500, getPath: () => ({ toPathData: () => 'M0 0L1 1', commands: [{ type: 'M', x: 0, y: 0 }, { type: 'L', x: 1, y: 1 }] }) }) };
const fonts = { sans: fake, serif: fake } as unknown as FontSet;
const base = (): Project => ({ ...defaultProject(), points: sampleTrack() });
const INK = '#1f2a24';
const RED = '#b4441f';
const BLUE = '#2f6f9f';
const paths = (ps: Prim[]) => ps.filter((x): x is PathPrim => x.kind === 'path');
const texts = (ps: Prim[]) => ps.filter((x): x is TextPrim => x.kind === 'text');
const colorsOf = (ps: Prim[]) => new Set(ps.map((x) => x.color));

describe('the palette', () => {
  it('starts with ink, a route red and a water blue, all 0.3 mm', () => {
    expect(defaultPens()).toEqual([
      { id: 'ink', name: 'Ink', color: INK, tipMm: 0.3 },
      { id: 'red', name: 'Route red', color: RED, tipMm: 0.3 },
      { id: 'blue', name: 'Water blue', color: BLUE, tipMm: 0.3 },
    ]);
  });
  it('penFor finds a pen, and falls back to the first one for an unknown id', () => {
    const pens = defaultPens();
    expect(penFor(pens, 'red').color).toBe(RED);
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

describe('removing a pen', () => {
  it('moves everything that used it to the first remaining pen', () => {
    const p = defaultProject();
    const extra = addPen(p)!;
    mapPenRefs(p, () => extra.id); // everything on the new pen
    expect(removePen(p, extra.id)).toBe(true);
    expect(p.pens.some((x) => x.id === extra.id)).toBe(false);
    const seen: string[] = [];
    mapPenRefs(p, (id) => { seen.push(id); return id; });
    expect(new Set(seen)).toEqual(new Set(['ink']));
  });
  it('refuses to remove the last pen, or one that does not exist', () => {
    const p = defaultProject();
    p.pens = [p.pens[0]!];
    expect(removePen(p, 'ink')).toBe(false);
    expect(removePen(defaultProject(), 'nope')).toBe(false);
  });
  it('removing water blue sends water to the first pen, and the override that now matches the default goes away', () => {
    const p = defaultProject();
    expect(p.features.pens.overrides).toEqual({ waterOutline: 'blue', waterLabel: 'blue' });
    removePen(p, 'blue');
    expect(featurePenId(p.features, 'waterOutline')).toBe('ink');
    expect(p.features.pens.overrides).toEqual({});
  });
  it('mapPenRefs reaches every part of the design that has a pen', () => {
    const p = defaultProject();
    const seen: string[] = [];
    mapPenRefs(p, (id) => { seen.push(id); return 'x'; });
    expect(seen.length).toBe(11 + 2); // route, contours, profile, north, title, title fill, location, info, watermark, border, landmarks default + 2 overrides
    expect(p.route.pen).toBe('x');
    expect(p.terrain.pen).toBe('x');
    expect(p.profile.pen).toBe('x');
    expect(p.north.pen).toBe('x');
    expect(p.text.title.pen).toBe('x');
    expect(p.text.title.fillPen).toBe('x');
    expect(p.text.location.pen).toBe('x');
    expect(p.text.info.pen).toBe('x');
    expect(p.watermarkPen).toBe('x');
    expect(p.border.pen).toBe('x');
    expect(p.features.pens).toEqual({ default: 'x', overrides: { waterOutline: 'x', waterLabel: 'x' } });
  });
});

describe('which part uses which pen', () => {
  it('lists the sections that are on, with their pens', () => {
    const p = base();
    const use = penUsage(p);
    const of = (section: string) => use.find((u) => u.section === section)?.penId;
    expect(of('Route')).toBe('red');
    expect(of('Contours')).toBe('ink');
    expect(of('Elevation profile')).toBe('ink');
    expect(of('Route info')).toBe('ink');
    expect(of('Landmarks')).toBe('ink');
    expect(of('Water outlines')).toBe('blue');
    expect(of('Water labels')).toBe('blue');
    expect(of('North arrow')).toBeUndefined(); // off by default
  });
  it('leaves out sections that are switched off or have nothing to draw', () => {
    const p = defaultProject(); // no GPX
    const sections = penUsage(p).map((u) => u.section);
    expect(sections).not.toContain('Route');
    expect(sections).not.toContain('Elevation profile');
    p.terrain.enabled = false;
    p.features.enabled = false;
    p.showWatermark = false;
    const off = penUsage(p).map((u) => u.section);
    for (const s of ['Contours', 'Landmarks', 'Water outlines', 'Watermark']) expect(off).not.toContain(s);
  });
  it('says when contour numbers share the contour pen', () => {
    const p = base();
    p.terrain.labels.enabled = true;
    expect(penUsage(p).some((u) => u.section === 'Contours and their numbers')).toBe(true);
  });
  it('a pen nothing uses has no usage', () => {
    const p = base();
    const pen = addPen(p)!;
    expect(penUsage(p).some((u) => u.penId === pen.id)).toBe(false);
  });
});

describe('every section gets its color from its pen', () => {
  const cone = async (z: number, tx: number, ty: number) => {
    const cx = lonToPx(-121.7, z);
    const cy = latToPx(46.82, z);
    const out = new Float32Array(TILE * TILE);
    const slope = 2000 / (2 ** z * TILE * 0.0008);
    for (let r = 0; r < TILE; r++) for (let c = 0; c < TILE; c++) out[r * TILE + c] = Math.max(0, 2000 - slope * Math.hypot(tx * TILE + c - cx, ty * TILE + r - cy));
    return out;
  };
  const osm = {
    landmarks: [
      { id: 'n1', name: 'Little Peak', kind: 'peak' as const, lat: 46.805, lon: -121.69, ele: 2800 },
      { id: 'n2', name: 'Start TH', kind: 'trailhead' as const, lat: 46.79, lon: -121.72 },
    ],
    water: [{ id: 'w1', kind: 'river' as const, name: 'Test River', coords: [[46.79, -121.74], [46.83, -121.66]] as [number, number][] }],
    covers: { minLat: 46, maxLat: 47, minLon: -122, maxLon: -121 },
  };
  const build = async (edit: (p: Project) => void = () => {}) => {
    const p = base();
    p.terrain.indexEvery = 2;
    p.terrain.intervalM = 100;
    p.terrain.labels.enabled = true;
    p.terrain.labels.density = 'dense';
    p.north.enabled = true;
    p.profile.labels = { extremes: true, yTicks: true, xTicks: true, sizePt: 9 };
    p.features.waterLabels = true;
    p.waypoints = sampleWaypoints(p.points);
    p.features.kinds.waypoint = true;
    edit(p);
    const terrain = await loadTerrain(viewBBox(p)!, cone);
    return buildScene(p, terrain, osm).prims;
  };

  it('with the default pens: route red, water blue, everything else ink', async () => {
    const ps = await build();
    expect(colorsOf(ps)).toEqual(new Set([INK, RED, BLUE]));
    expect(colorsOf(paths(ps).filter((x) => x.pen === 'red'))).toEqual(new Set([RED]));
    expect(colorsOf(paths(ps).filter((x) => x.pen === 'blue'))).toEqual(new Set([BLUE]));
    expect(texts(ps).filter((x) => x.text === 'Test River').every((x) => x.color === BLUE)).toBe(true);
  });
  it('every primitive records the pen it was drawn with, and its color matches that pen', async () => {
    const ps = await build();
    const pens = defaultPens();
    for (const x of ps) {
      expect(x.pen, `${x.kind} without a pen`).toBeDefined();
      expect(x.color).toBe(penFor(pens, x.pen).color);
    }
  });
  it('recoloring a pen recolors every section on it', async () => {
    const ps = await build((p) => { p.pens.find((x) => x.id === 'ink')!.color = '#123456'; });
    expect(colorsOf(ps)).toEqual(new Set(['#123456', RED, BLUE]));
  });
  it('each section follows the pen chosen for it', async () => {
    for (const [name, edit, pick] of [
      ['route', (p: Project) => { p.route.pen = 'blue'; }, (x: Prim) => x.kind === 'path' && x.widthMm === 0.9],
      ['profile', (p: Project) => { p.profile.pen = 'blue'; }, (x: Prim) => x.kind === 'path' && x.mode === 'fill'],
      ['north', (p: Project) => { p.north.pen = 'red'; }, (x: Prim) => x.kind === 'text' && x.text === 'N'],
      ['title', (p: Project) => { p.text.title.pen = 'blue'; }, (x: Prim) => x.kind === 'text' && x.text === 'WALK OF FRAME'],
      ['info', (p: Project) => { p.text.info.pen = 'red'; }, (x: Prim) => x.kind === 'text' && /mi$/.test(x.text)],
      ['watermark', (p: Project) => { p.watermarkPen = 'red'; }, (x: Prim) => x.kind === 'text' && x.text.startsWith('Generated with')],
    ] as const) {
      const p = base();
      p.north.enabled = name === 'north';
      edit(p);
      const hit = buildScene(p).prims.filter(pick);
      expect(hit.length, name).toBeGreaterThan(0);
      const want = penFor(p.pens, (name === 'route' ? p.route.pen : name === 'profile' ? p.profile.pen : name === 'north' ? p.north.pen : name === 'title' ? p.text.title.pen : name === 'info' ? p.text.info.pen : p.watermarkPen));
      for (const h of hit) expect(h.color, name).toBe(want.color);
    }
  });
  it('contour lines and their numbers share the contour pen', async () => {
    const ps = await build((p) => { p.terrain.pen = 'red'; p.profile.labels = { extremes: false, yTicks: false, xTicks: false, sizePt: 9 }; });
    const lines = paths(ps).filter((x) => x.widthMm === 0.12 || x.widthMm === 0.25);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((x) => x.pen === 'red' && x.color === RED)).toBe(true);
    const numbers = texts(ps).filter((x) => /^[\d,]+$/.test(x.text));
    expect(numbers.length).toBeGreaterThan(0);
    expect(numbers.every((x) => x.pen === 'red' && x.color === RED)).toBe(true);
  });
  it('the elevation profile line, fill, ticks and labels share one pen', async () => {
    const ps = await build((p) => { p.profile.pen = 'red'; p.north.enabled = false; p.text.info.visible = false; p.features.enabled = false; });
    const profile = ps.filter((x) => (x.kind === 'path' && x.mode === 'fill') || (x.kind === 'text' && /ft$/.test(x.text)));
    expect(profile.length).toBeGreaterThan(0);
    expect(profile.every((x) => x.pen === 'red')).toBe(true);
  });
});

describe('landmark pens: a default with overrides', () => {
  const osm = {
    landmarks: [
      { id: 'n1', name: 'Little Peak', kind: 'peak' as const, lat: 46.805, lon: -121.69, ele: 2800 },
      { id: 'n2', name: 'Start TH', kind: 'trailhead' as const, lat: 46.79, lon: -121.72 },
    ],
    water: [], covers: { minLat: 46, maxLat: 47, minLon: -122, maxLon: -121 },
  };
  const scene = (edit: (p: Project) => void) => { const p = base(); edit(p); return buildScene(p, undefined, osm).prims; };
  const label = (ps: Prim[], text: string) => texts(ps).find((x) => x.text === text)!;

  it('everything uses the default pen to begin with', () => {
    const ps = scene(() => {});
    expect(label(ps, 'Little Peak').color).toBe(INK);
    expect(label(ps, 'Start TH').color).toBe(INK);
  });
  it('changing the default pen moves every landmark that has no override', () => {
    const ps = scene((p) => { p.features.pens.default = 'red'; });
    expect(label(ps, 'Little Peak').color).toBe(RED);
    expect(label(ps, 'Start TH').color).toBe(RED);
  });
  it('an override moves just that kind, markers and labels together', () => {
    const ps = scene((p) => { p.features.pens.overrides.peak = 'blue'; });
    expect(label(ps, 'Little Peak').color).toBe(BLUE);
    expect(label(ps, 'Start TH').color).toBe(INK);
    // markers are drawn one path per pen, so the two kinds are in different marker paths
    const markers = paths(ps).filter((x) => x.widthMm === 0.35 && x.round && (x.pen === 'blue' || x.pen === 'ink') && x.d.length < 400);
    expect(new Set(markers.map((m) => m.pen)).size).toBe(2);
  });
  it('water stays blue when the landmarks default changes', () => {
    const p = base();
    p.features.pens.default = 'red';
    expect(featurePenId(p.features, 'waterOutline')).toBe('blue');
    expect(featurePenId(p.features, 'peak')).toBe('red');
  });
  it('clearing an override returns that kind to the default', () => {
    const p = base();
    p.features.pens.overrides.waterOutline = undefined;
    expect(featurePenId(p.features, 'waterOutline')).toBe(p.features.pens.default);
  });
});

describe('plotter export uses each pen\'s own tip', () => {
  const run = (edit: (p: Project) => void) => {
    const p = base();
    edit(p);
    return { p, out: prepareScene(buildScene(p), 'plotter', fonts, { pens: p.pens }) };
  };
  it('lines on a pen are drawn at that pen\'s tip width', () => {
    const { out } = run((p) => { p.pens.find((x) => x.id === 'red')!.tipMm = 0.5; });
    expect(paths(out.prims).filter((x) => x.pen === 'red').every((x) => x.widthMm === 0.5)).toBe(true);
    expect(paths(out.prims).filter((x) => x.pen === 'ink').every((x) => x.widthMm === 0.3)).toBe(true);
  });
  it('a coarser pen needs fewer passes for the same line weight', () => {
    const count = (tip: number) => run((p) => { p.pens.find((x) => x.id === 'red')!.tipMm = tip; }).out.prims.filter((x) => x.pen === 'red').length;
    expect(count(0.3)).toBe(3 * count(0.9)); // 0.9 mm route: 3 passes of 0.3, 1 pass of 0.9
    expect(count(0.45)).toBe(2 * count(0.9));
  });
  it('layers follow color and tip: two pens of one color but different tips are two layers', () => {
    const { out } = run((p) => {
      p.pens.push({ id: 'fine', name: 'Fine ink', color: INK, tipMm: 0.1 });
      p.north.enabled = true;
      p.north.pen = 'fine';
    });
    const ids = [...sceneToSvg(out).matchAll(/<g id="(layer-[^"]+)"/g)].map((m) => m[1]!);
    expect(ids).toContain(`layer-${INK.slice(1)}-0.1mm`);
    expect(ids).toContain(`layer-${INK.slice(1)}-0.3mm`);
  });
  it('two pens with the same color and tip share a layer', () => {
    const { out } = run((p) => { p.pens.push({ id: 'twin', name: 'Twin ink', color: INK, tipMm: 0.3 }); p.profile.pen = 'twin'; });
    const ids = [...sceneToSvg(out).matchAll(/<g id="(layer-[^"]+)"/g)].map((m) => m[1]!);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((i) => i.startsWith(`layer-${INK.slice(1)}`))).toHaveLength(1);
  });
  it('tipFor falls back to the default when there is no palette or no pen on the prim', () => {
    expect(tipFor({ pen: 'red' }, { pens: defaultPens() })).toBe(0.3);
    expect(tipFor({ pen: 'red' }, { penMm: 0.45 })).toBe(0.45);
    expect(tipFor({}, { pens: defaultPens() })).toBe(0.3);
    expect(tipFor({ pen: 'red' }, { pens: [{ id: 'red', name: 'r', color: RED, tipMm: 0.7 }] })).toBe(0.7);
  });
  it('the pass summary uses each prim\'s own tip', () => {
    const p = base();
    p.pens.find((x) => x.id === 'red')!.tipMm = 0.45;
    const sc = buildScene(p);
    const summary = summarizePasses(sc.prims, (x) => tipFor(x as { pen?: string }, { pens: p.pens }));
    expect(summary.find((s) => s.widthMm === 0.9)).toMatchObject({ passes: 2 });
  });
  it('print and live exports ignore tips: real widths and colors are kept', () => {
    const p = base();
    p.pens.find((x) => x.id === 'red')!.tipMm = 0.9;
    const print = prepareScene(buildScene(p), 'print', fonts, { pens: p.pens });
    expect(paths(print.prims).some((x) => x.widthMm === 0.9 && x.pen === 'red')).toBe(true);
  });
});
