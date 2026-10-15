import { afterEach, describe, expect, it, vi } from 'vitest';
import { northBox, northPrims } from '../src/scene/north';
import { buildScene, featureView, niceTicks, viewBBox, viewSizeKm } from '../src/scene/buildScene';
import { defaultProject } from '../src/scene/project';
import { formatFeet } from '../src/geo/stats';
import { sampleTrack } from '../src/sample';
import { handleApi, normalizeGeocode } from '../worker/api';
import { prepareScene } from '../src/export/outlines';
import type { TextPrim } from '../src/scene/types';

const frame = { x: 20, y: 30, w: 300, h: 400 };
const opts = { style: 'arrow' as const, corner: 'tr' as const, sizeMm: 24, color: '#123456', weightMm: 0.35, fontFamily: 'x', fontKey: 'sans' as const };
const texts = (ps: ReturnType<typeof northPrims>) => ps.flatMap((p) => (p.kind === 'text' ? [p.text] : []));
const base = () => ({ ...defaultProject(), points: sampleTrack() });
const sceneTexts = (p = base()) => buildScene(p).prims.flatMap((x) => (x.kind === 'text' ? [x.text] : []));

describe('north arrow', () => {
  it('places the box in each corner of the frame', () => {
    const at = (corner: 'tl' | 'tr' | 'bl' | 'br') => northBox(frame, corner, 24);
    expect(at('tl').x).toBeLessThan(at('tr').x);
    expect(at('tl').y).toBeLessThan(at('bl').y);
    for (const c of ['tl', 'tr', 'bl', 'br'] as const) {
      const b = at(c);
      expect(b.x).toBeGreaterThanOrEqual(frame.x);
      expect(b.x + 24).toBeLessThanOrEqual(frame.x + frame.w);
      expect(b.y).toBeGreaterThanOrEqual(frame.y);
      expect(b.y + 24).toBeLessThanOrEqual(frame.y + frame.h);
    }
  });
  it('every style draws something, uses the chosen color, and contains an N', () => {
    for (const style of ['arrow', 'circle', 'compass', 'rose'] as const) {
      const ps = northPrims(frame, { ...opts, style });
      expect(ps.length).toBeGreaterThan(1);
      expect(ps.every((p) => p.color === '#123456')).toBe(true);
      expect(texts(ps)).toContain('N');
    }
  });
  it('compass shows all four cardinals; the others show only N', () => {
    expect(texts(northPrims(frame, { ...opts, style: 'compass' })).sort()).toEqual(['E', 'N', 'S', 'W']);
    expect(texts(northPrims(frame, { ...opts, style: 'arrow' }))).toEqual(['N']);
  });
  it('stays inside its box (size scales the drawing)', () => {
    for (const style of ['arrow', 'circle', 'compass', 'rose'] as const) for (const corner of ['tl', 'br'] as const) {
      const { x, y } = northBox(frame, corner, 30);
      for (const p of northPrims(frame, { ...opts, style, corner, sizeMm: 30 })) {
        if (p.kind !== 'path') continue;
        // arcs are relative ("a"), so only check absolute M/L/H/V points via the leading M
        const m = p.d.match(/M(-?[\d.]+) (-?[\d.]+)/)!;
        expect(+m[1]!).toBeGreaterThanOrEqual(x - 0.5);
        expect(+m[1]!).toBeLessThanOrEqual(x + 30.5);
        expect(+m[2]!).toBeGreaterThanOrEqual(y - 0.5);
        expect(+m[2]!).toBeLessThanOrEqual(y + 30.5);
      }
    }
  });
  it('is off by default and appears in the scene when enabled', () => {
    expect(sceneTexts()).not.toContain('N');
    const p = base();
    p.north.enabled = true;
    expect(sceneTexts(p)).toContain('N');
  });
  it('survives plotter export as strokes only', () => {
    const p = base();
    p.north.enabled = true;
    const sc = buildScene(p);
    // fonts are not needed for this check: only that no fill/opacity remains once converted
    const fake = { sans: { unitsPerEm: 1000, charToGlyph: () => ({ advanceWidth: 500, getPath: () => ({ toPathData: () => 'M0 0L1 1' }) }) } } as any;
    fake.serif = fake.sans;
    expect(prepareScene(sc, 'plotter', fake).prims.every((x) => x.kind === 'path' && x.mode === 'stroke')).toBe(true);
  });
});

describe('elevation labels', () => {
  const high = () => Math.max(...base().points.map((q) => q.ele!));
  const low = () => Math.min(...base().points.map((q) => q.ele!));
  it('niceTicks gives round numbers inside the range', () => {
    expect(niceTicks(1650, 3150, 4)).toEqual([2000, 2500, 3000]);
    expect(niceTicks(0, 9.3, 5)).toEqual([0, 2, 4, 6, 8]);
    expect(niceTicks(5, 5, 4)).toEqual([]);
  });
  it('off by default', () => {
    expect(sceneTexts().some((t) => t.includes(formatFeet(high())))).toBe(false);
  });
  it('labels the highest and lowest point', () => {
    const p = base();
    p.profile.labels.extremes = true;
    const t = sceneTexts(p);
    expect(t).toContain(formatFeet(high()));
    expect(t).toContain(formatFeet(low()));
  });
  it('adds elevation ticks (values in feet when imperial, meters when metric)', () => {
    const p = base();
    p.profile.labels.yTicks = true;
    const ft = sceneTexts(p).filter((t) => /^[\d,]+$/.test(t)).map((t) => +t.replace(/,/g, ''));
    expect(ft.length).toBeGreaterThanOrEqual(2);
    expect(Math.min(...ft)).toBeGreaterThanOrEqual(low() * 3.28 - 1);
    expect(Math.max(...ft)).toBeLessThanOrEqual(high() * 3.28 + 1);
    p.units = 'metric';
    const m = sceneTexts(p).filter((t) => /^[\d,]+$/.test(t)).map((t) => +t.replace(/,/g, ''));
    expect(Math.max(...m)).toBeLessThanOrEqual(high() + 1);
  });
  it('adds distance ticks', () => {
    const p = base();
    p.profile.labels.xTicks = true;
    expect(sceneTexts(p).some((t) => /^\d+ mi$/.test(t))).toBe(true);
    p.units = 'metric';
    expect(sceneTexts(p).some((t) => /^\d+ km$/.test(t))).toBe(true);
  });
  it('shows nothing extra when the profile is hidden or has no elevation', () => {
    const p = base();
    p.profile.enabled = false;
    p.profile.labels.extremes = true;
    expect(sceneTexts(p).some((t) => t.includes(formatFeet(high())))).toBe(false);
  });
  it('contour interval is an optional info item', () => {
    const p = base();
    expect(sceneTexts(p).some((t) => /\d+ m \(/.test(t))).toBe(false);
  });
});

describe('feature search results', () => {
  const hit = (name: string, extra: object = {}) => ({
    name, display_name: `${name}, Pierce County, Washington, United States`, type: 'volcano', category: 'natural',
    lat: '46.85', lon: '-121.75', boundingbox: ['46.8', '46.9', '-121.8', '-121.7'], ...extra,
  });
  afterEach(() => vi.unstubAllGlobals());

  it('normalizes candidates and drops ones without an extent', () => {
    const r = normalizeGeocode([hit('Mount Rainier'), hit('No Box', { boundingbox: undefined }), hit('Rainier Lodge', { type: 'alpine_hut' })]);
    expect(r.map((x) => x.name)).toEqual(['Mount Rainier', 'Rainier Lodge']);
    expect(r[0]).toMatchObject({ kind: 'volcano', location: 'Pierce County, Washington', lat: 46.85, bbox: { minLat: 46.8, maxLat: 46.9, minLon: -121.8, maxLon: -121.7 } });
    expect(r[1]!.kind).toBe('alpine hut');
  });
  it('the API returns several candidates, or 404 when there are none', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([hit('A'), hit('B')]))));
    const ok = (await handleApi(new Request('http://x/api/geocode?q=rainier')))!;
    expect(((await ok.json()) as any).results).toHaveLength(2);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]')));
    expect((await handleApi(new Request('http://x/api/geocode?q=zzzz')))!.status).toBe(404);
  });
  it('view span: auto keeps the feature extent (min ~6 km); a set span is square-ish and centered', () => {
    const f = { name: 'x', lat: 46.85, lon: -121.75, bbox: { minLat: 46.85, maxLat: 46.85, minLon: -121.75, maxLon: -121.75 } };
    const [w0] = viewSizeKm(featureView(f));
    expect(w0).toBeGreaterThan(4);
    expect(w0).toBeLessThan(8);
    const [w, h] = viewSizeKm(featureView({ ...f, spanKm: 40 }));
    expect(w).toBeCloseTo(40, 0);
    expect(h).toBeCloseTo(40, 0);
    const p = { ...defaultProject(), feature: { ...f, spanKm: 40 } };
    const b = viewBBox(p)!;
    expect((b.minLat + b.maxLat) / 2).toBeCloseTo(46.85, 1);
  });
});
