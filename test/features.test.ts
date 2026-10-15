import { afterEach, describe, expect, it, vi } from 'vitest';
import { placeLandmarks, type PlaceInput } from '../src/features/select';
import { defaultFeatures, LANDMARK_KINDS, CUSTOM_ICONS, type Landmark, type WaterLine } from '../src/features/types';
import { markerPath } from '../src/features/draw';
import { fitBBox } from '../src/geo/project';
import { handleApi } from '../worker/api';
import { buildScene } from '../src/scene/buildScene';
import { cityData, cityProject } from './fixture';

const B = { minLat: 46, maxLat: 46.2, minLon: -121.4, maxLon: -121 };
const frame = { x: 20, y: 20, w: 300, h: 400 };
const fit = fitBBox(B, frame);
const lm = (id: string, name: string, kind: Landmark['kind'], lat: number, lon: number): Landmark => ({ id, name, kind, lat, lon });
const input = (landmarks: Landmark[], over: Partial<PlaceInput> = {}): PlaceInput => ({
  landmarks, water: [], fit, frame, route: [], settings: defaultFeatures(), sizeMm: 4, markerR: 2, ...over,
});

const grid: Landmark[] = [];
for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++)
  grid.push(lm(`n${i}${j}`, `Place ${i}${j}`, 'attraction', 46.02 + i * 0.03, -121.35 + j * 0.06));

describe('placeLandmarks', () => {
  it('draws at most maxLabels, the ones linked to Wikidata first', () => {
    const s = defaultFeatures();
    s.maxLabels = 3;
    const known = grid.map((g) => (g.id === 'n55' ? { ...g, notable: true } : g));
    const { labels } = placeLandmarks(input(known, { settings: s }));
    expect(labels).toHaveLength(3);
    expect(labels.map((l) => l.id)).toContain('n55');
  });
  it('your own landmarks always outrank OSM features', () => {
    const home = lm('custom-1', 'Home', 'custom', 46.1, -121.2);
    const s = defaultFeatures();
    s.maxLabels = 1;
    expect(placeLandmarks(input([...grid, home], { settings: s })).labels[0]!.id).toBe('custom-1');
  });
  it('never overlaps labels with each other', () => {
    const crowded = Array.from({ length: 12 }, (_, i) => lm(`n${i}`, `Crowded Peak ${i}`, 'attraction', 46.1 + i * 0.0004, -121.2));
    const s = defaultFeatures();
    s.maxLabels = 12;
    const { labels } = placeLandmarks(input(crowded, { settings: s }));
    const box = (l: (typeof labels)[number]) => {
      const w = l.text.length * 4 * 0.56;
      const x0 = l.anchor === 'start' ? l.x : l.anchor === 'end' ? l.x - w : l.x - w / 2;
      return [x0, l.y - 3.4, x0 + w, l.y + 0.6];
    };
    for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
      const a = box(labels[i]!); const b = box(labels[j]!);
      expect(a[0]! < b[2]! && a[2]! > b[0]! && a[1]! < b[3]! && a[3]! > b[1]!).toBe(false);
    }
    expect(labels.length).toBeLessThan(12); // some could not fit
  });
  it('moves a label off the route instead of drawing across it', () => {
    const p = lm('n1', 'Summit Peak', 'attraction', 46.1, -121.2);
    const [x, y] = fit.toMm(46.1, -121.2);
    const route: [number, number][] = [[x + 8, y - 60], [x + 8, y + 60]]; // vertical line just right of the marker
    const { labels } = placeLandmarks(input([p], { route }));
    expect(labels[0]!.anchor).not.toBe('start');
  });
  it('honors rename and a forced side', () => {
    const s = defaultFeatures();
    s.overrides['n1'] = { name: 'Renamed', side: 'left' };
    const { labels } = placeLandmarks(input([lm('n1', 'Old', 'attraction', 46.1, -121.2)], { settings: s }));
    expect(labels[0]).toMatchObject({ text: 'Renamed', anchor: 'end' });
  });
  it('skips kinds that are switched off and landmarks outside the frame', () => {
    const s = defaultFeatures();
    s.kinds.museum = false;
    const out = lm('n9', 'Far Peak', 'attraction', 50, -121.2);
    const hut = lm('n8', 'The Hut', 'museum', 46.1, -121.2);
    expect(placeLandmarks(input([out, hut], { settings: s })).labels).toHaveLength(0);
  });
  it('collapses duplicate names of the same kind', () => {
    const dup = [lm('n1', 'Mt Dup', 'attraction', 46.1, -121.2), lm('n2', 'Mt Dup', 'attraction', 46.1002, -121.2)];
    expect(placeLandmarks(input(dup)).labels).toHaveLength(1);
  });
  it('labels big named lakes at their center, with no marker; ignores tiny ones', () => {
    const ring = (lat: number, lon: number, r: number): [number, number][] =>
      [[lat - r, lon - r], [lat - r, lon + r], [lat + r, lon + r], [lat + r, lon - r], [lat - r, lon - r]];
    const water: WaterLine[] = [
      { id: 'w1', kind: 'lake', name: 'Big Lake', coords: ring(46.1, -121.2, 0.02) },
      { id: 'w2', kind: 'lake', name: 'Puddle', coords: ring(46.15, -121.3, 0.0002) },
    ];
    const s = defaultFeatures();
    s.waterLabels = true;
    const { labels } = placeLandmarks(input([], { water, settings: s }));
    expect(labels.map((l) => l.text)).toEqual(['Big Lake']);
    expect(labels[0]!.marker).toBeUndefined();
  });
});

describe('labels and markers', () => {
  it('no label is written over any drawn marker', () => {
    const s = defaultFeatures();
    s.maxLabels = 20;
    const { labels } = placeLandmarks(input(grid, { settings: s }));
    const size = 4;
    const hitsMarker = (l: (typeof labels)[number], m: [number, number]) => {
      const w = l.text.length * size * 0.56;
      const x0 = l.anchor === 'start' ? l.x : l.anchor === 'end' ? l.x - w : l.x - w / 2;
      return m[0] > x0 && m[0] < x0 + w && m[1] > l.y - size * 0.8 && m[1] < l.y + size * 0.2;
    };
    for (const l of labels) for (const o of labels) if (o !== l && o.marker) expect(hitsMarker(l, o.marker)).toBe(false);
  });
  it('a label avoids the marker of a lower-ranked neighbor placed after it', () => {
    const [x, y] = fit.toMm(46.1, -121.2);
    const [lat2, lon2] = fit.fromMm(x + 14, y); // second peak 14 mm to the right: under a long label placed to the right of the first
    const a = lm('a', 'Alpha Peak With A Long Name', 'attraction', 46.1, -121.2);
    const b = lm('b', 'Beta', 'attraction', lat2, lon2);
    const { labels } = placeLandmarks(input([a, b]));
    const la = labels.find((l) => l.id === 'a')!;
    expect(la.anchor).not.toBe('start'); // not through Beta's marker
  });
});

describe('markers', () => {
  it('has a distinct outline for every kind', () => {
    const kinds = ['attraction', 'historic', 'museum', 'worship', 'station', 'custom'] as const;
    const ds = kinds.map((k) => markerPath(k, 10, 10, 2));
    expect(new Set(ds).size).toBe(kinds.length);
    expect(ds.every((d) => d.startsWith('M'))).toBe(true);
  });
});

describe('markers', () => {
  it('has a distinct outline for every kind', () => {
    const ds = LANDMARK_KINDS.map((k) => markerPath(k, 10, 10, 2));
    expect(new Set(ds).size).toBe(LANDMARK_KINDS.length);
    expect(ds.every((d) => d.startsWith('M'))).toBe(true);
  });
  it('your own landmark can be a pin, a house, a star or a flag, each its own shape', () => {
    const ds = CUSTOM_ICONS.map((i) => markerPath('custom', 10, 10, 2, i));
    expect(new Set(ds).size).toBe(CUSTOM_ICONS.length);
    expect(markerPath('custom', 10, 10, 2)).toBe(markerPath('custom', 10, 10, 2, 'pin'));
  });
  it('a house marker stays within its radius, scaled for visibility', () => {
    const nums = (markerPath('custom', 100, 100, 2, 'home').match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
    for (let i = 0; i < nums.length; i += 2) {
      expect(Math.abs(nums[i]! - 100)).toBeLessThanOrEqual(2 * 1.4 + 0.01);
      expect(Math.abs(nums[i + 1]! - 100)).toBeLessThanOrEqual(2 * 1.6 + 0.01);
    }
  });
});

describe('landmarks in the scene', () => {
  const texts = (p = cityProject(), data = cityData()) => buildScene(p, data).prims.flatMap((x) => (x.kind === 'text' ? [x.text] : []));
  it('labels the landmarks that came with the map', () => {
    expect(texts()).toContain('Space Needle');
    expect(texts()).toContain('Art Museum');
  });
  it('can be switched off entirely, but your own are hidden with it', () => {
    const p = cityProject();
    p.features.enabled = false;
    expect(texts(p)).not.toContain('Space Needle');
  });
  it('your own landmark is drawn at its address or coordinates, with a marker, in the chosen icon', () => {
    const p = cityProject();
    p.custom = [{ id: 'custom-1', name: 'Home', kind: 'custom', lat: 47.6062, lon: -122.3321, icon: 'home' }];
    const sc = buildScene(p, cityData());
    expect(sc.prims.some((x) => x.kind === 'text' && x.text === 'Home')).toBe(true);
    const house = markerPath('custom', 0, 0, 1, 'home').replace(/-?\d+(\.\d+)?/g, '#').replace(/\s+/g, '');
    const drawn = sc.prims.filter((x) => x.kind === 'path' && x.round).map((x) => (x as { d: string }).d.replace(/-?\d+(\.\d+)?/g, '#').replace(/\s+/g, ''));
    expect(drawn.some((d) => d.includes(house))).toBe(true);
  });
  it('your own landmark outside the map is not drawn', () => {
    const p = cityProject();
    p.custom = [{ id: 'custom-1', name: 'Far Away', kind: 'custom', lat: 10, lon: 10 }];
    expect(texts(p)).not.toContain('Far Away');
  });
  it('your own landmark is drawn even when the landmark limit is zero', () => {
    const p = cityProject();
    p.features.maxLabels = 0;
    p.custom = [{ id: 'custom-1', name: 'Home', kind: 'custom', lat: 47.6062, lon: -122.3321 }];
    expect(texts(p)).toContain('Home');
    expect(texts(p)).not.toContain('Space Needle');
  });
  it('lake and river names come from the water layer and only when asked', () => {
    const p = cityProject();
    expect(texts(p)).not.toContain('Lake Test');
    p.features.waterLabels = true;
    expect(texts(p)).toContain('Lake Test');
    expect(texts(p)).toContain('River Test');
  });
  it('labels share the text color, so they add no extra pen layer', () => {
    const p = cityProject();
    const sc = buildScene(p, cityData());
    const label = sc.prims.find((x) => x.kind === 'text' && x.text === 'Space Needle')!;
    expect(label.color).toBe(sc.prims.find((x) => x.kind === 'text' && x.text === 'SEATTLE')!.color);
  });
});

describe('opt-in landmark defaults', () => {
  it('attractions, museums, historic sites and stations are on; worship, parks, universities and stadiums are not', () => {
    const k = defaultFeatures().kinds;
    expect([k.attraction, k.museum, k.historic, k.station, k.custom]).toEqual([true, true, true, true, true]);
    expect([k.worship, k.park, k.university, k.stadium]).toEqual([false, false, false, false]);
  });
  it('water names are off until asked for', () => {
    expect(defaultFeatures().waterLabels).toBe(false);
  });
});

describe('Overpass mirrors and diagnostics', () => {
  const road = { type: 'way', id: 1, tags: { highway: 'primary' }, geometry: [{ lat: 46.02, lon: -121.38 }, { lat: 46.03, lon: -121.37 }] };
  const ok = (elements: unknown[]) => new Response(JSON.stringify({ elements }));
  const small = 'layer=major&minLat=46.01&maxLat=46.08&minLon=-121.39&maxLon=-121.32';
  const call = (path: string) => handleApi(new Request(`http://x${path}`)) as Promise<Response>;
  const host = (u: unknown) => new URL(String(u)).hostname;
  afterEach(() => vi.unstubAllGlobals());

  /** `script` maps hostname -> response (or a thrown error) for every Overpass call. */
  const script = (byHost: Record<string, () => Response | Promise<Response>>) => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: unknown) => {
      calls.push(host(u));
      const h = byHost[host(u)];
      if (!h) throw new Error('unexpected host');
      return h();
    }));
    return calls;
  };

  it('falls through to the next mirror on a 504', async () => {
    const calls = script({
      'overpass-api.de': () => new Response('', { status: 504 }),
      'overpass.openstreetmap.fr': () => ok([road]),
    });
    const d: any = await (await call(`/api/layer?${small}`)).json();
    expect(d.ways).toHaveLength(1);
    expect(calls).toContain('overpass.openstreetmap.fr');
    expect(calls.filter((c) => c === 'z.overpass-api.de')).toHaveLength(0); // stopped once one worked
  });
  it('treats a network error and an HTML body as failures and keeps going', async () => {
    script({
      'overpass-api.de': () => new Response('<html>busy</html>'),
      'overpass.openstreetmap.fr': () => { throw new TypeError('connection reset'); },
      'z.overpass-api.de': () => ok([road]),
    });
    expect(((await (await call(`/api/layer?${small}`)).json()) as any).ways).toHaveLength(1);
  });
  it('a 200 that only carries a runtime-error remark counts as a failure', async () => {
    script({
      'overpass-api.de': () => new Response(JSON.stringify({ elements: [], remark: 'runtime error: Query timed out' })),
      'overpass.openstreetmap.fr': () => ok([road]),
    });
    expect(((await (await call(`/api/layer?${small}`)).json()) as any).ways).toHaveLength(1);
  });
  it('an empty result with no remark is a real answer, not a failure', async () => {
    const calls = script({ 'overpass-api.de': () => ok([]) });
    const d: any = await (await call(`/api/layer?${small}`)).json();
    expect(d.ways).toEqual([]);
    expect(new Set(calls)).toEqual(new Set(['overpass-api.de']));
  });
  it('when every server fails, the error says what each one answered', async () => {
    script({
      'overpass-api.de': () => new Response('', { status: 521 }),
      'overpass.openstreetmap.fr': () => new Response('', { status: 429 }),
      'z.overpass-api.de': () => { throw new TypeError('connection reset'); },
    });
    const res = await call(`/api/layer?${small}`);
    const msg = ((await res.json()) as any).error as string;
    expect(res.status).toBe(502);
    for (const part of ['overpass-api.de 521', 'overpass.openstreetmap.fr 429', 'z.overpass-api.de connection reset'])
      expect(msg).toContain(part);
  });
  it('/api/health reports each server and is never cached', async () => {
    script({
      'overpass-api.de': () => ok([]),
      'overpass.openstreetmap.fr': () => new Response('', { status: 504 }),
      'z.overpass-api.de': () => { throw new TypeError('refused'); },
    });
    const res = await call('/api/health');
    const d: any = await res.json();
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(d.hosts.map((h: any) => [h.host, h.ok])).toEqual([
      ['overpass-api.de', true], ['overpass.openstreetmap.fr', false], ['z.overpass-api.de', false],
    ]);
    expect(d.hosts[1].status).toBe(504);
    expect(d.hosts[2].error).toBe('refused');
    expect(d.hosts).toHaveLength(3);
  });
});

describe('formatting the label of one of my landmarks', () => {
  const home = lm('custom-1', 'Home', 'custom', 46.1, -121.2);
  const run = (ov: NonNullable<ReturnType<typeof defaultFeatures>['overrides'][string]>) => {
    const s = defaultFeatures();
    s.overrides['custom-1'] = ov;
    return placeLandmarks(input([home], { settings: s })).labels;
  };
  it('the name goes on the side you choose', () => {
    expect(run({ side: 'left' })[0]).toMatchObject({ anchor: 'end' });
    expect(run({ side: 'right' })[0]).toMatchObject({ anchor: 'start' });
    const above = run({ side: 'above' })[0]!;
    const below = run({ side: 'below' })[0]!;
    expect(above).toMatchObject({ anchor: 'middle' });
    expect(above.y).toBeLessThan(below.y);
  });
  it('its own text size changes the label and leaves others alone', () => {
    expect(run({ sizePt: 24 })[0]!.sizeMm).toBeCloseTo(24 * 25.4 / 72, 6);
    expect(run({})[0]!.sizeMm).toBeUndefined();
  });
  it('a bigger name needs more room, so it is wider on the page', () => {
    const wide = (labels: ReturnType<typeof run>) => labels[0]!.text.length * (labels[0]!.sizeMm ?? 4);
    expect(wide(run({ sizePt: 30 }))).toBeGreaterThan(wide(run({})));
  });
  it('marker only: no text, the marker stays', () => {
    const [l] = run({ noLabel: true });
    expect(l).toMatchObject({ text: '', marker: expect.any(Array) });
  });
  it('name only: no marker, the name is centered on the spot', () => {
    const [l] = run({ noMarker: true });
    expect(l!.marker).toBeUndefined();
    expect(l).toMatchObject({ text: 'Home', anchor: 'middle' });
  });
  it('in the scene: marker-only draws no text, name-only draws no marker', () => {
    const scene = (ov: object) => {
      const p = cityProject((q) => {
        q.features.enabled = true;
        q.custom = [{ id: 'custom-1', name: 'Home', kind: 'custom', lat: 47.6062, lon: -122.3321, icon: 'home' }];
        q.features.overrides['custom-1'] = ov;
      });
      return buildScene(p, { layers: {}, landmarks: [] }).prims;
    };
    const markers = (ps: ReturnType<typeof scene>) => ps.filter((x) => x.kind === 'path' && x.round).length;
    const names = (ps: ReturnType<typeof scene>) => ps.filter((x) => x.kind === 'text' && x.text === 'Home').length;
    expect([markers(scene({})), names(scene({}))]).toEqual([1, 1]);
    expect([markers(scene({ noLabel: true })), names(scene({ noLabel: true }))]).toEqual([1, 0]);
    expect([markers(scene({ noMarker: true })), names(scene({ noMarker: true }))]).toEqual([0, 1]);
  });
  it('the chosen size reaches the drawn text', () => {
    const p = cityProject((q) => {
      q.custom = [{ id: 'custom-1', name: 'Home', kind: 'custom', lat: 47.6062, lon: -122.3321 }];
      q.features.overrides['custom-1'] = { sizePt: 30 };
    });
    const t = buildScene(p, { layers: {}, landmarks: [] }).prims.find((x) => x.kind === 'text' && x.text === 'Home') as { sizeMm: number };
    expect(t.sizeMm).toBeCloseTo(30 * 25.4 / 72, 6);
  });
});
