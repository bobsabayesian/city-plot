import { describe, expect, it } from 'vitest';
import { layerOf, sceneToSvg } from '../src/export/svg';
import { buildScene, viewBBox } from '../src/scene/buildScene';
import { defaultProject } from '../src/scene/project';
import { sampleTrack, sampleWaypoints } from '../src/sample';
import { loadTerrain, latToPx, lonToPx, TILE } from '../src/topo/terrain';
import { prepareScene, type FontSet } from '../src/export/outlines';
import type { PathPrim, Prim, Scene, TextPrim } from '../src/scene/types';

const stroke = (color: string, widthMm: number, extra: Partial<PathPrim> = {}): PathPrim => ({ kind: 'path', d: 'M0 0L1 1', color, mode: 'stroke', widthMm, ...extra });
const fill = (color: string): PathPrim => ({ kind: 'path', d: 'M0 0L1 0L1 1Z', color, mode: 'fill' });
const text = (color: string): TextPrim => ({ kind: 'text', text: 'x', x: 1, y: 1, anchor: 'start', sizeMm: 3, trackingMm: 0, fontFamily: 'x', fontKey: 'sans', color });
const scene = (prims: Prim[]): Scene => ({ widthMm: 100, heightMm: 100, paper: '#fff', prims });
const layers = (prims: Prim[]) => [...sceneToSvg(scene(prims)).matchAll(/<g id="([^"]+)"/g)].map((m) => m[1]!);

describe('SVG layers: every color and every stroke width is its own layer', () => {
  it('same color, different widths -> separate layers', () => {
    expect(layers([stroke('#000', 0.2), stroke('#000', 0.9)])).toHaveLength(2);
  });
  it('same width, different colors -> separate layers', () => {
    expect(layers([stroke('#000', 0.3), stroke('#f00', 0.3)])).toHaveLength(2);
  });
  it('same color and width merge, however the color is written', () => {
    expect(layers([stroke('#ABC', 0.3), stroke('#aabbcc', 0.3), stroke('#AABBCC', 0.3)])).toHaveLength(1);
  });
  it('widths that differ by less than 0.01 mm are one pen', () => {
    expect(layers([stroke('#000', 0.3), stroke('#000', 0.3004), stroke('#000', 0.2996)])).toHaveLength(1);
    expect(layers([stroke('#000', 0.3), stroke('#000', 0.32)])).toHaveLength(2);
  });
  it('fills never share a layer with strokes, even in the same color', () => {
    const ids = layers([stroke('#000', 0.3), fill('#000')]);
    expect(ids).toHaveLength(2);
    expect(ids.filter((i) => i.endsWith('-fill'))).toHaveLength(1);
  });
  it('live text is filled, so it joins the fill layer of its color', () => {
    expect(layers([fill('#000'), text('#000')])).toHaveLength(1);
    expect(layers([text('#000'), text('#f00')])).toHaveLength(2);
  });
  it('opacity and dashes do not split layers (they are not pens)', () => {
    expect(layers([stroke('#000', 0.3), stroke('#000', 0.3, { opacity: 0.5, dash: [1, 1] })])).toHaveLength(1);
  });
  it('layer ids and labels state the color and width, and ids are unique', () => {
    const svg = sceneToSvg(scene([stroke('#112233', 0.35), stroke('#112233', 0.9), fill('#445566')]));
    expect(svg).toContain('id="layer-112233-0.35mm"');
    expect(svg).toContain('id="layer-112233-0.9mm"');
    expect(svg).toContain('id="layer-445566-fill"');
    expect(svg).toContain('inkscape:label="Layer 1 #112233 0.35mm"');
    const ids = layers([stroke('#112233', 0.35), stroke('#112233', 0.9), fill('#445566')]);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('layerOf is stable for the same pen', () => {
    expect(layerOf(stroke('#ABC', 0.3))).toEqual(layerOf(stroke('#aabbcc', 0.3)));
  });
  it('keeps first-appearance order so fills stay under lines', () => {
    const ids = layers([fill('#999'), stroke('#000', 0.3), stroke('#000', 0.1)]);
    expect(ids[0]).toBe('layer-999999-fill');
    expect(ids).toHaveLength(3);
  });
});

/** Every element inside one SVG layer must really be the same pen. */
function checkEveryLayerIsOnePen(svg: string) {
  const groups = svg.split('<g id="').slice(1);
  expect(groups.length).toBeGreaterThan(0);
  for (const g of groups) {
    const id = g.slice(0, g.indexOf('"'));
    const strokes = [...g.matchAll(/stroke="(#[0-9a-f]{6})"[^>]*?stroke-width="([\d.]+)"/g)].map((m) => `${m[1]}|${m[2]}`);
    const fills = [...g.matchAll(/fill="(#[0-9a-f]{6})"/g)].map((m) => m[1]);
    if (id.endsWith('-fill')) {
      expect(strokes, `${id} should hold no strokes`).toHaveLength(0);
      expect(new Set(fills).size, `${id} mixes fill colors`).toBe(1);
    } else {
      expect(new Set(strokes).size, `${id} mixes pens: ${[...new Set(strokes)].join(', ')}`).toBe(1);
      const width = +id.match(/-([\d.]+)mm$/)![1]!;
      expect(Math.abs(+strokes[0]!.split('|')[1]! - width)).toBeLessThan(0.01);
    }
  }
}

describe('a full poster really is one pen per layer', () => {
  const cone = async (z: number, tx: number, ty: number) => {
    const cx = lonToPx(-121.7, z);
    const cy = latToPx(46.82, z);
    const out = new Float32Array(TILE * TILE);
    const slope = 2000 / (2 ** z * TILE * 0.0008);
    for (let r = 0; r < TILE; r++) for (let c = 0; c < TILE; c++) out[r * TILE + c] = Math.max(0, 2000 - slope * Math.hypot(tx * TILE + c - cx, ty * TILE + r - cy));
    return out;
  };
  const rich = async () => {
    const pts = sampleTrack();
    const p = { ...defaultProject(), points: pts, waypoints: sampleWaypoints(pts) };
    p.features.kinds.waypoint = true;
    p.features.waterLabels = true;
    p.north.enabled = true;
    p.north.style = 'rose';
    p.border = { ...p.border, enabled: true, style: 'double', weightMm: 0.6 };
    p.text.title.style = 'outlineFill';
    p.text.title.align = 'justify';
    p.text.title.fillPen = 'blue';
    p.profile.hatch = 'light';
    p.terrain.labels.enabled = true;
    p.terrain.labels.density = 'dense';
    p.profile.labels = { extremes: true, yTicks: true, xTicks: true, sizePt: 9 };
    p.text.info.items.find((i) => i.key === 'contour')!.visible = true;
    const terrain = await loadTerrain(viewBBox(p)!, cone);
    const osm = {
      landmarks: [{ id: 'n1', name: 'Little Peak', kind: 'peak' as const, lat: 46.805, lon: -121.69, ele: 2800 }],
      water: [{ id: 'w1', kind: 'river' as const, name: 'Test River', coords: [[46.79, -121.74], [46.83, -121.66]] as [number, number][] }],
      covers: { minLat: 46, maxLat: 47, minLon: -122, maxLon: -121 },
    };
    return buildScene(p, terrain, osm);
  };

  it('with every feature switched on, live text', async () => {
    const sc = await rich();
    const svg = sceneToSvg(sc);
    checkEveryLayerIsOnePen(svg);
    expect(svg.match(/<g id=/g)!.length).toBeGreaterThanOrEqual(5); // route, contours x2, profile, north, water, ...
  });
  it('and in plotter mode: strokes only, each layer one pen', async () => {
    const sc = await rich();
    const fake = { unitsPerEm: 1000, charToGlyph: () => ({ advanceWidth: 500, getPath: () => ({ toPathData: () => 'M0 0L1 1', commands: [{ type: 'M', x: 0, y: 0 }, { type: 'L', x: 1, y: 1 }] }) }) };
    const out = sceneToSvg(prepareScene(sc, 'plotter', { sans: fake, serif: fake } as unknown as FontSet));
    checkEveryLayerIsOnePen(out);
    expect(out).not.toContain('-fill"');
    expect(out).not.toContain('<text');
  });
  it('heavy and light contours, route, water and labels land on different layers by width', async () => {
    const sc = await rich();
    const widths = new Set(sc.prims.flatMap((x) => (x.kind === 'path' && x.mode === 'stroke' ? [+(x.widthMm ?? 0.5).toFixed(2)] : [])));
    expect(widths.size).toBeGreaterThanOrEqual(4);
    const ids = layers(sc.prims);
    for (const w of widths) expect(ids.some((i) => i.endsWith(`-${w}mm`))).toBe(true);
  });
});
