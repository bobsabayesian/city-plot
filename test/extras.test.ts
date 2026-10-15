import { afterEach, describe, expect, it, vi } from 'vitest';
import { northBox, northPrims } from '../src/scene/north';
import { buildScene } from '../src/scene/buildScene';
import { cityProject } from './fixture';
import { handleApi, normalizeGeocode } from '../worker/api';
import { prepareScene } from '../src/export/outlines';
import type { TextPrim } from '../src/scene/types';

const frame = { x: 20, y: 30, w: 300, h: 400 };
const opts = { style: 'arrow' as const, corner: 'tr' as const, sizeMm: 24, color: '#123456', weightMm: 0.35, fontFamily: 'x', fontKey: 'sans' as const };
const texts = (ps: ReturnType<typeof northPrims>) => ps.flatMap((p) => (p.kind === 'text' ? [p.text] : []));
const base = () => (cityProject());
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

describe('place search results', () => {
  const hit = (name: string, extra: object = {}) => ({
    name, display_name: `${name}, King County, Washington, United States`, type: 'city', category: 'boundary',
    lat: '47.6', lon: '-122.3', boundingbox: ['47.5', '47.7', '-122.4', '-122.2'], ...extra,
  });
  afterEach(() => vi.unstubAllGlobals());

  it('normalizes candidates and drops ones without an extent', () => {
    const r = normalizeGeocode([hit('Seattle'), hit('No Box', { boundingbox: undefined }), hit('Space Needle', { type: 'tourist_attraction' })]);
    expect(r.map((x) => x.name)).toEqual(['Seattle', 'Space Needle']);
    expect(r[0]).toMatchObject({ kind: 'city', location: 'King County, Washington', lat: 47.6, bbox: { minLat: 47.5, maxLat: 47.7, minLon: -122.4, maxLon: -122.2 } });
    expect(r[1]!.kind).toBe('tourist attraction');
  });
  it('the API returns several candidates, or 404 when there are none', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([hit('A'), hit('B')]))));
    const ok = (await handleApi(new Request('http://x/api/geocode?q=seattle')))!;
    expect(((await ok.json()) as any).results).toHaveLength(2);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]')));
    expect((await handleApi(new Request('http://x/api/geocode?q=zzzz')))!.status).toBe(404);
  });
});
