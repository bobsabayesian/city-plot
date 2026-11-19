import { describe, expect, it } from 'vitest';
import { applyLook, LOOKS, lookById } from '../src/scene/looks';
import { contrast, mapPenRefs, MAX_PENS, MIN_INK_CONTRAST } from '../src/scene/pens';
import { defaultProject, type Project } from '../src/scene/project';
import { buildScene } from '../src/scene/buildScene';
import { cityData, cityProject } from './fixture';

const looked = (id: string, edit: (p: Project) => void = () => {}) => {
  const p = cityProject(edit);
  applyLook(p, lookById(id)!);
  return p;
};
const refs = (p: Project) => { const out: string[] = []; mapPenRefs(p, (id) => (out.push(id), id)); return out; };

describe('looks', () => {
  it('have unique ids and at most the pen limit', () => {
    expect(new Set(LOOKS.map((l) => l.id)).size).toBe(LOOKS.length);
    for (const l of LOOKS) expect(l.pens.length).toBeLessThanOrEqual(MAX_PENS);
  });

  it.each(LOOKS.map((l) => l.id))('%s: every part of the design points at one of its pens', (id) => {
    const p = looked(id);
    const ids = new Set(p.pens.map((x) => x.id));
    for (const r of refs(p)) expect(ids).toContain(r);
  });

  it.each(LOOKS.map((l) => l.id))('%s: every ink can be read on its paper', (id) => {
    const l = lookById(id)!;
    for (const pen of l.pens) expect(contrast(pen.color, l.paper)).toBeGreaterThanOrEqual(MIN_INK_CONTRAST);
  });

  it.each(LOOKS.map((l) => l.id))('%s: draws the map in its own inks only', (id) => {
    const p = looked(id);
    const inks = new Set(p.pens.map((x) => x.color.toLowerCase()));
    const prims = buildScene(p, cityData()).prims;
    expect(prims.length).toBeGreaterThan(5);
    for (const x of prims) expect(inks).toContain(x.color.toLowerCase());
  });

  it('Classic is the default style', () => {
    const p = looked('classic', (q) => { q.paper = '#000000'; q.layers.water.fill = 'off'; q.text.font = 'serif'; q.border.enabled = true; });
    const d = defaultProject();
    expect(p.paper).toBe(d.paper);
    expect(p.pens).toEqual(d.pens);
    expect(p.layers).toEqual(d.layers);
    expect(p.text.font).toBe(d.text.font);
    expect(p.text.title.style).toBe(d.text.title.style);
    expect(p.border).toEqual(d.border);
    expect(p.features.pens).toEqual(d.features.pens);
  });

  it('keeps the place, area, size, margins, text and landmarks', () => {
    const before = cityProject((q) => {
      q.sizeId = 'a3'; q.landscape = true; q.page.margins.top = 9; q.text.title.value = 'Home';
      q.region!.rotationDeg = 30;
      q.custom.push({ id: 'custom-1', name: 'Our flat', kind: 'custom', lat: 47.6, lon: -122.33, icon: 'default' });
    });
    const p = structuredClone(before);
    applyLook(p, lookById('engraved')!);
    for (const k of ['place', 'region', 'sizeId', 'landscape', 'page', 'custom', 'units'] as const) expect(p[k]).toEqual(before[k]);
    expect(p.text.title.value).toBe('Home');
  });

  it('Engraved chart draws waterlines; Nolli fills buildings and drops streets', () => {
    expect(looked('engraved').layers.water.waterlines!.count).toBeGreaterThan(0);
    const n = looked('nolli');
    expect(n.layers.buildings.fill).toBe('solid');
    expect(n.layers.minor.enabled || n.layers.secondary.enabled || n.layers.major.enabled).toBe(false);
  });

  it('on a coaster the coaster limits still hold', () => {
    const p = looked('engraved', (q) => { q.sizeId = 'coaster-circle'; });
    expect(p.text.title.visible).toBe(false);
    expect(p.border.enabled).toBe(false);
    expect(p.layers.buildings.enabled).toBe(false);
  });

  it('applying a look does not change the look itself', () => {
    const l = lookById('blueprint')!;
    const copy = structuredClone(l);
    const p = looked('blueprint');
    p.pens[0]!.color = '#123456';
    p.layers.water.waterlines!.count = 99;
    expect(l).toEqual(copy);
  });
});

describe('the north arrow sits on clear paper', () => {
  it('no map line runs under it', async () => {
    const { northBox } = await import('../src/scene/north');
    const { viewOf } = await import('../src/scene/buildScene');
    const { flattenPath } = await import('../src/export/offset');
    // the fixture's street grid runs through the middle of the map: a big arrow in a corner reaches it
    const at0 = (q: Project) => northBox(viewOf(q)!.frame, 'tl', 200);
    const pointsUnder = (on: boolean) => {
      const p = cityProject((q) => { q.north = { ...q.north, enabled: on, corner: 'tl', sizeMm: 200 }; });
      const at = at0(p);
      const inside = ([x, y]: [number, number]) => x > at.x + 0.5 && x < at.x + 199.5 && y > at.y + 0.5 && y < at.y + 199.5;
      const mapLines = buildScene(p, cityData()).prims.filter((x) => x.kind === 'path' && x.part && !['north', 'border'].includes(x.part) && x.mode === 'stroke');
      return mapLines.flatMap((l) => flattenPath((l as { d: string }).d).flatMap((s) => s.pts)).filter(inside).length;
    };
    expect(pointsUnder(false)).toBeGreaterThan(0);
    expect(pointsUnder(true)).toBe(0);
  });

  it('hatched areas are cleared under it too', async () => {
    const { northBox } = await import('../src/scene/north');
    const { viewOf } = await import('../src/scene/buildScene');
    const { hatchPath } = await import('../src/export/hatch');
    const { flattenPath } = await import('../src/export/offset');
    const hatchUnder = (on: boolean) => {
      const p = cityProject((q) => { q.north = { ...q.north, enabled: on, corner: 'tl', sizeMm: 200 }; q.layers.parks.fill = 'solid'; q.layers.water.fill = 'solid'; q.layers.buildings.fill = 'solid'; });
      const at = northBox(viewOf(p)!.frame, 'tl', 200);
      const inside = ([x, y]: [number, number]) => x > at.x + 0.5 && x < at.x + 199.5 && y > at.y + 0.5 && y < at.y + 199.5;
      const fills = buildScene(p, cityData()).prims.filter((x) => x.kind === 'path' && x.mode === 'fill' && x.part && x.part !== 'north');
      return fills.flatMap((f) => flattenPath(hatchPath((f as { d: string }).d, 0.5)).flatMap((s) => s.pts)).filter(inside).length;
    };
    expect(hatchUnder(false)).toBeGreaterThan(0);
    expect(hatchUnder(true)).toBe(0);
  });
});
