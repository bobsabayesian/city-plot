import { describe, expect, it } from 'vitest';
import { formatCoordsDms } from '../src/geo/format';
import { niceDistance, niceWalk, WALK_M_PER_MIN } from '../src/scene/scalebar';
import { buildScene, viewOf } from '../src/scene/buildScene';
import { textToStrokes } from '../src/export/strokefont';
import { flattenPath } from '../src/export/offset';
import { fromFile, FILE_APP } from '../src/projectFile';
import type { PathPrim, TextPrim } from '../src/scene/types';
import { cityData, cityProject } from './fixture';

const span = (d: string) => {
  const pts = flattenPath(d).flatMap((s) => s.pts);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
};

describe('coordinates in degrees, minutes and seconds', () => {
  it('Seattle', () => {
    expect(formatCoordsDms(47.6062, -122.3321)).toBe('47°36′22″ N  122°19′56″ W');
  });
  it('south and east, and seconds that round up to a whole minute', () => {
    expect(formatCoordsDms(-33.8568, 151.2153)).toBe('33°51′24″ S  151°12′55″ E');
    expect(formatCoordsDms(10.99999, 0)).toBe('11°00′00″ N  0°00′00″ E');
  });
  it('the plotter font can write them in single strokes', () => {
    const t = { kind: 'text' as const, text: formatCoordsDms(47.6062, -122.3321), x: 0, y: 0, anchor: 'start' as const, sizeMm: 3, trackingMm: 0, fontFamily: 'x', fontKey: 'sans' as const, color: '#000' };
    expect(textToStrokes(t)).toBeTruthy();
  });
  it('the location line uses them when asked', () => {
    const texts = buildScene(cityProject((p) => { p.text.location.coordFormat = 'dms'; }), cityData()).prims.filter((x): x is TextPrim => x.kind === 'text').map((x) => x.text);
    expect(texts).toContain('47°36′22″ N  122°19′56″ W');
  });
});

describe('round lengths for scale bars', () => {
  const at25k = 1000 / 25000; // map mm per metre at 1:25,000
  it('metric: the longest of 1, 2, 5 × 10ⁿ m that fits', () => {
    expect(niceDistance(60, at25k, false)).toEqual({ m: 1000, label: '1 km' }); // 40 mm
    expect(niceDistance(30, at25k, false)).toEqual({ m: 500, label: '500 m' }); // 20 mm
    expect(niceDistance(0.03, at25k, false)).toBeUndefined(); // not even a metre (0.04 mm) fits
  });
  it('imperial: feet, then fractions of a mile', () => {
    expect(niceDistance(60, at25k, true)!.label).toBe('0.5 mi'); // 32 mm; a mile would be 64
    expect(niceDistance(10, at25k, true)!.label).toBe('500 ft');
  });
  it('on foot: the longest round number of minutes at 5 km/h', () => {
    expect(niceWalk(60, at25k)).toEqual({ m: 15 * WALK_M_PER_MIN, label: '15 min' }); // 50 mm
    expect(niceWalk(210, at25k)!.label).toBe('1 h'); // 5 km = 200 mm; 90 min would be 300
  });
});

describe('scale bars on the poster', () => {
  const withBars = (edit: (p: ReturnType<typeof cityProject>) => void = () => {}) => cityProject((p) => {
    p.region!.scale = 25000;
    p.units = 'metric';
    for (const it of p.text.info.items) it.visible = it.key === 'bar' || it.key === 'walk';
    edit(p);
  });

  it('the scale bar is exactly as long as its distance on the map, in four parts, alternately filled', () => {
    const p = withBars();
    const prims = buildScene(p, cityData()).prims;
    const info = prims.filter((x): x is PathPrim => x.kind === 'path' && x.part === 'info');
    const outlines = info.filter((x) => x.mode === 'stroke');
    expect(outlines).toHaveLength(2); // the scale bar and the walk bar
    const label = prims.find((x): x is TextPrim => x.kind === 'text' && x.part === 'info' && /\d (m|km)$/.test(x.text))!;
    const metres = label.text.endsWith('km') ? parseFloat(label.text) * 1000 : parseFloat(label.text);
    const bar = span(outlines[0]!.d);
    const mmPerM = viewOf(p)!.frame.w / (viewOf(p)!.widthKm * 1000);
    expect(bar.x1 - bar.x0).toBeCloseTo(metres * mmPerM, 6);
    expect(bar.x1 - bar.x0).toBeCloseTo(metres / 25, 6); // 1:25,000
    // the filled parts: the first and third of four
    const fills = flattenPath(info.find((x) => x.mode === 'fill')!.d);
    expect(fills).toHaveLength(2);
    expect(fills[0]!.pts.length).toBeGreaterThan(3);
  });

  it('the walk bar says how many minutes it is on foot', () => {
    const texts = buildScene(withBars(), cityData()).prims.filter((x): x is TextPrim => x.kind === 'text' && x.part === 'info').map((x) => x.text);
    expect(texts.some((t) => /^\d+ (min|h)$/.test(t))).toBe(true);
    expect(texts).toContain('ON FOOT');
  });

  it('a typed value is written instead of the bar', () => {
    const p = withBars((q) => { q.text.info.items.find((i) => i.key === 'bar')!.value = 'Not to scale'; });
    const texts = buildScene(p, cityData()).prims.filter((x): x is TextPrim => x.kind === 'text').map((x) => x.text);
    expect(texts).toContain('Not to scale');
  });
});

describe('info values that would not fit', () => {
  it('on a small page, area and scale are set smaller rather than run into each other', () => {
    const p = cityProject((q) => { q.sizeId = '8x10'; });
    const values = buildScene(p, cityData()).prims.filter((x): x is TextPrim => x.kind === 'text' && x.part === 'info' && x.opacity === undefined);
    expect(values).toHaveLength(2);
    const [area, scale] = values as [TextPrim, TextPrim];
    expect(area.sizeMm).toBeLessThan(22 * (25.4 / 72));
    // the area's text (estimated as the layout does) ends before the scale's begins
    const width = area.text.length * (area.sizeMm * 0.56 + area.trackingMm);
    expect(area.x + width).toBeLessThan(scale.x);
  });
  it('the whole row shrinks alike, so area and scale stay the same size as each other', () => {
    const values = buildScene(cityProject((q) => { q.sizeId = '8x10'; }), cityData()).prims.filter((x): x is TextPrim => x.kind === 'text' && x.part === 'info' && x.opacity === undefined);
    expect(values[0]!.sizeMm).toBeCloseTo(values[1]!.sizeMm, 9);
  });
  it('a bar takes most of its cell, even four to a row', () => {
    const p = cityProject((q) => { q.region!.scale = 10000; q.units = 'metric'; for (const it of q.text.info.items) it.visible = true; });
    const view = viewOf(p)!;
    const outlines = buildScene(p, cityData()).prims.filter((x): x is PathPrim => x.kind === 'path' && x.part === 'info' && x.mode === 'stroke');
    expect(outlines).toHaveLength(2);
    for (const o of outlines) expect(span(o.d).x1 - span(o.d).x0).toBeGreaterThan((view.frame.w / 4) * 0.3);
  });
  it('on a big page nothing changes size', () => {
    const values = buildScene(cityProject(), cityData()).prims.filter((x): x is TextPrim => x.kind === 'text' && x.part === 'info' && x.opacity === undefined);
    expect(values).toHaveLength(2);
    for (const v of values) expect(v.sizeMm).toBeCloseTo(22 * (25.4 / 72), 6);
  });
});

describe('the cartouche', () => {
  const framed = (frame: 'box' | 'double' | 'corners') => {
    const p = cityProject((q) => { q.text.title.frame = frame; });
    const prims = buildScene(p, cityData()).prims;
    const frameD = prims.filter((x): x is PathPrim => x.kind === 'path' && x.part === 'title');
    return { p, prims, frameD };
  };

  it('a ruled box goes round the title, location and info, below the map, and their text sits inside it', () => {
    const { p, prims, frameD } = framed('box');
    expect(frameD).toHaveLength(1);
    const box = span(frameD[0]!.d);
    const map = viewOf(p)!.frame;
    expect(box.y0).toBeGreaterThan(map.y + map.h);
    for (const t of prims.filter((x): x is TextPrim => x.kind === 'text' && ['title', 'location', 'info'].includes(x.part ?? ''))) {
      expect(t.y).toBeGreaterThan(box.y0);
      expect(t.y).toBeLessThan(box.y1);
      expect(t.x).toBeGreaterThanOrEqual(box.x0 + 3.9);
    }
    // the map gives up the room the frame needs
    expect(viewOf(p)!.frame.h).toBeLessThan(viewOf(cityProject())!.frame.h);
  });

  it('a double rule is a heavy outer line and a fine inner one; corner brackets are two Ls at each corner', () => {
    const d = framed('double').frameD;
    expect(d.map((x) => x.widthMm)).toEqual([0.6, 0.25]);
    const c = framed('corners').frameD;
    expect(flattenPath(c[0]!.d)).toHaveLength(8);
  });

  it('no frame, no change', () => {
    expect(buildScene(cityProject(), cityData()).prims.some((x) => x.kind === 'path' && x.part === 'title')).toBe(false);
  });
});

describe('projects saved before the bars existed', () => {
  it('get the new info items, switched off, when opened', () => {
    const old = cityProject();
    old.text.info.items = [{ key: 'scale', visible: true, label: 'Scale' }];
    const p = fromFile({ app: FILE_APP, version: 1, project: JSON.parse(JSON.stringify(old)) });
    expect(p.text.info.items.map((i) => [i.key, i.visible])).toEqual([['scale', true], ['extent', false], ['bar', false], ['walk', false]]);
    expect(p.text.location.coordFormat).toBe('decimal');
    expect(p.text.title.frame).toBe('none');
  });
});
