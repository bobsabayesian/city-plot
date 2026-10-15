import { afterEach, describe, expect, it, vi } from 'vitest';
import { placeLandmarks, type PlaceInput } from '../src/features/select';
import { defaultFeatures, requestCovers, requestIsEmpty, wantedRequest, type Landmark, type WaterLine } from '../src/features/types';
import { markerPath } from '../src/features/draw';
import { fitBBox } from '../src/geo/project';
import { parseWaypoints } from '../src/gpx/parse';
import { handleApi, normalizeFeatures } from '../worker/api';
import { buildScene, composeScene } from '../src/scene/buildScene';
import { defaultProject } from '../src/scene/project';
import { sampleTrack, sampleWaypoints } from '../src/sample';

const B = { minLat: 46, maxLat: 46.2, minLon: -121.4, maxLon: -121 };
const frame = { x: 20, y: 20, w: 300, h: 400 };
const fit = fitBBox(B, frame);
const lm = (id: string, name: string, kind: Landmark['kind'], lat: number, lon: number, ele?: number): Landmark => ({ id, name, kind, lat, lon, ele });
const input = (landmarks: Landmark[], over: Partial<PlaceInput> = {}): PlaceInput => ({
  landmarks, water: [], fit, frame, route: [], settings: defaultFeatures(), sizeMm: 4, markerR: 2, ...over,
});

const grid: Landmark[] = [];
for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++)
  grid.push(lm(`n${i}${j}`, `Peak ${i}${j}`, 'peak', 46.02 + i * 0.03, -121.35 + j * 0.06, 1000 + i * 100 + j * 10));

describe('placeLandmarks', () => {
  it('draws at most maxLabels, highest peaks first', () => {
    const s = defaultFeatures();
    s.maxLabels = 3;
    const { labels } = placeLandmarks(input(grid, { settings: s }));
    expect(labels).toHaveLength(3);
    expect(labels.map((l) => l.id)).toContain('n55'); // the tallest
  });
  it('GPX waypoints always outrank OSM features', () => {
    const wpt = lm('wpt-0', 'Camp', 'waypoint', 46.1, -121.2);
    const s = defaultFeatures();
    s.kinds.waypoint = true;
    s.maxLabels = 1;
    expect(placeLandmarks(input([...grid, wpt], { settings: s })).labels[0]!.id).toBe('wpt-0');
  });
  it('never overlaps labels with each other', () => {
    const crowded = Array.from({ length: 12 }, (_, i) => lm(`n${i}`, `Crowded Peak ${i}`, 'peak', 46.1 + i * 0.0004, -121.2, 2000 + i));
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
    const p = lm('n1', 'Summit Peak', 'peak', 46.1, -121.2, 2000);
    const [x, y] = fit.toMm(46.1, -121.2);
    const route: [number, number][] = [[x + 8, y - 60], [x + 8, y + 60]]; // vertical line just right of the marker
    const { labels } = placeLandmarks(input([p], { route }));
    expect(labels[0]!.anchor).not.toBe('start');
  });
  it('honors rename and a forced side', () => {
    const s = defaultFeatures();
    s.overrides['n1'] = { name: 'Renamed', side: 'left' };
    const { labels } = placeLandmarks(input([lm('n1', 'Old', 'peak', 46.1, -121.2)], { settings: s }));
    expect(labels[0]).toMatchObject({ text: 'Renamed', anchor: 'end' });
  });
  it('skips kinds that are switched off and landmarks outside the frame', () => {
    const s = defaultFeatures();
    s.kinds.hut = false;
    const out = lm('n9', 'Far Peak', 'peak', 50, -121.2);
    const hut = lm('n8', 'The Hut', 'hut', 46.1, -121.2);
    expect(placeLandmarks(input([out, hut], { settings: s })).labels).toHaveLength(0);
  });
  it('collapses duplicate names of the same kind', () => {
    const dup = [lm('n1', 'Mt Dup', 'peak', 46.1, -121.2, 2000), lm('n2', 'Mt Dup', 'peak', 46.1002, -121.2, 1900)];
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
    const a = lm('a', 'Alpha Peak With A Long Name', 'peak', 46.1, -121.2, 3000);
    const b = lm('b', 'Beta', 'peak', lat2, lon2, 2000);
    const { labels } = placeLandmarks(input([a, b]));
    const la = labels.find((l) => l.id === 'a')!;
    expect(la.anchor).not.toBe('start'); // not through Beta's marker
  });
});

describe('markers', () => {
  it('has a distinct outline for every kind', () => {
    const kinds = ['peak', 'pass', 'hut', 'viewpoint', 'trailhead', 'waypoint'] as const;
    const ds = kinds.map((k) => markerPath(k, 10, 10, 2));
    expect(new Set(ds).size).toBe(kinds.length);
    expect(ds.every((d) => d.startsWith('M'))).toBe(true);
  });
});

describe('gpx waypoints', () => {
  it('reads named wpt entries and skips unnamed ones', () => {
    const xml = `<gpx><wpt lat="46.1" lon="-121.2"><ele>2100</ele><name>Camp Muir</name></wpt><wpt lat="1" lon="2"/><wpt lat="46.2" lon="-121.1"><name>123</name></wpt></gpx>`;
    const w = parseWaypoints(xml);
    expect(w).toHaveLength(2);
    expect(w[0]).toMatchObject({ name: 'Camp Muir', kind: 'waypoint', ele: 2100 });
    expect(w[1]!.name).toBe('123');
  });
  it('returns none when there are no waypoints', () => {
    expect(parseWaypoints('<gpx></gpx>')).toEqual([]);
  });
});

describe('overpass normalization', () => {
  it('maps tags to kinds and drops unnamed or unknown elements', () => {
    const out = normalizeFeatures([
      { type: 'node', id: 1, lat: 1, lon: 2, tags: { name: 'A', natural: 'peak', ele: '2000' } },
      { type: 'node', id: 2, lat: 1, lon: 2, tags: { name: 'B', natural: 'saddle' } },
      { type: 'node', id: 3, lat: 1, lon: 2, tags: { name: 'C', tourism: 'alpine_hut' } },
      { type: 'node', id: 4, lat: 1, lon: 2, tags: { name: 'D', highway: 'trailhead' } },
      { type: 'node', id: 5, lat: 1, lon: 2, tags: { natural: 'peak' } },
      { type: 'node', id: 6, lat: 1, lon: 2, tags: { name: 'E', amenity: 'cafe' } },
      { type: 'way', id: 7, tags: { name: 'L', natural: 'water' }, geometry: [{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }] },
      { type: 'way', id: 8, tags: { name: 'R', waterway: 'river' }, geometry: [{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }] },
      { type: 'way', id: 9, tags: { name: 'X', waterway: 'canal' }, geometry: [{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }] },
    ]);
    expect(out.landmarks.map((l) => [l.id, l.kind])).toEqual([['n1', 'peak'], ['n2', 'pass'], ['n3', 'hut'], ['n4', 'trailhead']]);
    expect(out.landmarks[0]!.ele).toBe(2000);
    expect(out.water.map((w) => [w.id, w.kind])).toEqual([['w7', 'lake'], ['w8', 'river']]);
  });
});

describe('landmarks in the scene', () => {
  const base = () => {
    const pts = sampleTrack();
    const p = { ...defaultProject(), points: pts, waypoints: sampleWaypoints(pts) };
    p.features.kinds.waypoint = true; // waypoints are opt-in
    return p;
  };
  const names = (p = base(), osm?: Parameters<typeof buildScene>[2]) =>
    buildScene(p, undefined, osm).prims.flatMap((x) => (x.kind === 'text' ? [x.text] : []));

  it('draws GPX waypoint labels and markers with no network data', () => {
    expect(names()).toEqual(expect.arrayContaining(['Summit', 'Trailhead']));
    const c = composeScene(base());
    expect(c.landmarks!.map((e) => e.name)).toEqual(expect.arrayContaining(['Summit', 'Trailhead']));
  });
  it('can be switched off entirely', () => {
    const p = base();
    p.features.enabled = false;
    expect(names(p)).not.toContain('Summit');
  });
  it('adds OSM landmarks and water lines, with water under the route', () => {
    const p = base();
    const osm = {
      landmarks: [lm('n1', 'Little Tahoma', 'peak', 46.805, -121.69, 3000)],
      water: [{ id: 'w1', kind: 'river' as const, name: 'River', coords: [[46.79, -121.74], [46.83, -121.66]] as [number, number][] }],
      covers: B,
    };
    expect(names(p, osm)).toContain('Little Tahoma');
    const prims = buildScene(p, undefined, osm).prims;
    const iWater = prims.findIndex((x) => x.kind === 'path' && x.widthMm === p.features.waterWeightMm);
    const iRoute = prims.findIndex((x) => x.kind === 'path' && x.widthMm === p.route.weightMm);
    expect(iWater).toBeGreaterThanOrEqual(0);
    expect(iWater).toBeLessThan(iRoute);
    p.features.water = false;
    expect(buildScene(p, undefined, osm).prims.some((x) => x.kind === 'path' && x.widthMm === p.features.waterWeightMm)).toBe(false);
  });
  it('labels share the text color, so they add no extra pen layer', () => {
    const svgLayers = (p = base()) => new Set(buildScene(p).prims.map((x) => x.color)).size;
    const withLabels = svgLayers();
    const p = base();
    p.features.enabled = false;
    expect(withLabels).toBe(svgLayers(p));
  });
});

describe('/api/features resilience', () => {
  const peak = { type: 'node', id: 1, lat: 1, lon: 2, tags: { name: 'A', natural: 'peak' } };
  const lake = { type: 'way', id: 2, tags: { name: 'L', natural: 'water' }, geometry: [{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }] };
  const reply = (status: number, elements: unknown[] = []) =>
    new Response(status === 200 ? JSON.stringify({ elements }) : 'gateway', { status });
  const call = async (qs: string) => handleApi(new Request(`http://x/api/features?${qs}`)) as Promise<Response>;
  const small = 'minLat=46.01&maxLat=46.08&minLon=-121.39&maxLon=-121.32';

  afterEach(() => vi.unstubAllGlobals());
  const stub = (fn: (isWater: boolean, call: number) => Response) => {
    let n = { node: 0, water: 0 };
    const f = vi.fn(async (_u: string, init: any) => {
      const isWater = decodeURIComponent(init.body).includes('out geom');
      return fn(isWater, ++n[isWater ? 'water' : 'node']);
    });
    vi.stubGlobal('fetch', f);
    return f;
  };

  it('returns everything when both queries succeed', async () => {
    stub((w) => reply(200, w ? [lake] : [peak]));
    const d: any = await (await call(small)).json();
    expect(d.landmarks).toHaveLength(1);
    expect(d.water).toHaveLength(1);
    expect(d.partial).toEqual([]);
  });
  it('keeps landmarks when the water query times out (504), and flags it', async () => {
    stub((w) => (w ? reply(504) : reply(200, [peak])));
    const res = await call(small);
    const d: any = await res.json();
    expect(res.status).toBe(200);
    expect(d.landmarks).toHaveLength(1);
    expect(d.partial).toEqual(['water']);
    expect(res.headers.get('cache-control')).toContain('max-age=60');
  });
  it('retries a 504 once and recovers', async () => {
    const f = stub((w, n) => (w ? (n === 1 ? reply(504) : reply(200, [lake])) : reply(200, [peak])));
    const d: any = await (await call(small)).json();
    expect(d.partial).toEqual([]);
    expect(f).toHaveBeenCalledTimes(3);
  });
  it('skips the expensive water query for large areas', async () => {
    const f = stub(() => reply(200, [peak]));
    const d: any = await (await call('minLat=46&maxLat=46.4&minLon=-121.5&maxLon=-121.2')).json();
    expect(d.partial).toEqual(['water']);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('only errors when everything fails', async () => {
    stub(() => reply(504));
    expect((await call(small)).status).toBe(502);
  });
});

describe('overpass mirrors and diagnostics', () => {
  const peak = { type: 'node', id: 1, lat: 1, lon: 2, tags: { name: 'A', natural: 'peak' } };
  const ok = (elements: unknown[]) => new Response(JSON.stringify({ elements }));
  const small = 'minLat=46.01&maxLat=46.08&minLon=-121.39&maxLon=-121.32';
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
      'overpass.openstreetmap.fr': () => ok([peak]),
    });
    const d: any = await (await call(`/api/features?${small}`)).json();
    expect(d.landmarks[0].name).toBe('A');
    expect(d.partial).toEqual([]);
    expect(calls).toContain('overpass.openstreetmap.fr');
    expect(calls.filter((c) => c === 'z.overpass-api.de')).toHaveLength(0); // stopped once one worked
  });
  it('treats a network error and an HTML body as failures and keeps going', async () => {
    script({
      'overpass-api.de': () => new Response('<html>busy</html>'),
      'overpass.openstreetmap.fr': () => { throw new TypeError('connection reset'); },
      'z.overpass-api.de': () => ok([peak]),
    });
    const d: any = await (await call(`/api/features?${small}`)).json();
    expect(d.landmarks[0].name).toBe('A');
  });
  it('a 200 that only carries a runtime-error remark counts as a failure', async () => {
    script({
      'overpass-api.de': () => new Response(JSON.stringify({ elements: [], remark: 'runtime error: Query timed out' })),
      'overpass.openstreetmap.fr': () => ok([peak]),
    });
    expect(((await (await call(`/api/features?${small}`)).json()) as any).landmarks[0].name).toBe('A');
  });
  it('an empty result with no remark is a real answer, not a failure', async () => {
    const calls = script({ 'overpass-api.de': () => ok([]) });
    const d: any = await (await call(`/api/features?${small}`)).json();
    expect(d.landmarks).toEqual([]);
    expect(new Set(calls)).toEqual(new Set(['overpass-api.de']));
  });
  it('when every server fails, the error says what each one answered', async () => {
    script({
      'overpass-api.de': () => new Response('', { status: 521 }),
      'overpass.openstreetmap.fr': () => new Response('', { status: 429 }),
      'z.overpass-api.de': () => { throw new TypeError('connection reset'); },
    });
    const res = await call(`/api/features?${small}`);
    const msg = ((await res.json()) as any).error as string;
    expect(res.status).toBe(502);
    for (const part of ['overpass-api.de 521', 'overpass.openstreetmap.fr 429', 'z.overpass-api.de connection reset'])
      expect(msg).toContain(part);
  });
  it('a partial answer carries the reason for the missing part', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_u: unknown, init: any) =>
      decodeURIComponent(init.body).includes('out geom') ? new Response('', { status: 504 }) : ok([peak])));
    const d: any = await (await call(`/api/features?${small}`)).json();
    expect(d.partial).toEqual(['water']);
    expect(d.reason).toMatch(/water: .*overpass-api\.de 504/);
  });
  it('the peak lookup uses the mirrors too', async () => {
    script({ 'overpass-api.de': () => new Response('', { status: 504 }), 'overpass.openstreetmap.fr': () => ok([peak]) });
    const d: any = await (await call(`/api/peaks?${small}`)).json();
    expect(d.peaks).toHaveLength(1);
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

describe('opt-in feature defaults', () => {
  it('only peaks, trailheads and water lines are on by default', () => {
    const d = defaultFeatures();
    expect(Object.entries(d.kinds).filter(([, on]) => on).map(([k]) => k).sort()).toEqual(['peak', 'trailhead']);
    expect(d.water).toBe(true);
    expect(d.waterLabels).toBe(false);
  });
  it('the request always covers every point kind (the add-landmark list offers them), plus water by setting', () => {
    expect(wantedRequest(defaultFeatures())).toEqual({ kinds: ['peak', 'pass', 'hut', 'viewpoint', 'trailhead'], lakes: true, rivers: true });
  });
  it('water labels alone still need the water geometry (rivers and lakes)', () => {
    const s = defaultFeatures();
    s.water = false;
    s.waterLabels = true;
    expect(wantedRequest(s)).toMatchObject({ lakes: true, rivers: true });
    s.waterLabels = false;
    expect(wantedRequest(s)).toMatchObject({ lakes: false, rivers: false });
  });
  it('switching a point kind on or off never needs a new fetch; turning water on does', () => {
    const have = wantedRequest(defaultFeatures());
    const s = defaultFeatures();
    s.kinds.hut = true;
    s.kinds.peak = false;
    expect(requestCovers(have, wantedRequest(s))).toBe(true);
    expect(requestCovers(undefined, wantedRequest(s))).toBe(false);
    const noWater = wantedRequest({ ...defaultFeatures(), water: false });
    expect(requestCovers(noWater, wantedRequest(defaultFeatures()))).toBe(false);
    expect(requestCovers(have, wantedRequest({ ...defaultFeatures(), water: false }))).toBe(true);
  });
  it('only water settings can make a request empty of water', () => {
    const s = defaultFeatures();
    s.water = false;
    s.waterLabels = false;
    expect(wantedRequest(s)).toMatchObject({ lakes: false, rivers: false });
    expect(requestIsEmpty(wantedRequest(s))).toBe(false); // points are still fetched
  });
  it('by default the scene labels peaks and trailheads but not huts, passes, viewpoints or lakes', () => {
    const pts = sampleTrack();
    const p = { ...defaultProject(), points: pts };
    const osm = {
      landmarks: [
        lm('n1', 'Summit Pk', 'peak', 46.82, -121.7, 3000), lm('n2', 'Start TH', 'trailhead', 46.79, -121.72),
        lm('n3', 'Old Hut', 'hut', 46.8, -121.7), lm('n4', 'High Pass', 'pass', 46.81, -121.69), lm('n5', 'Nice View', 'viewpoint', 46.805, -121.69),
      ],
      water: [],
      covers: B,
    };
    const labels = buildScene(p, undefined, osm).prims.flatMap((x) => (x.kind === 'text' ? [x.text] : []));
    expect(labels).toEqual(expect.arrayContaining(['Summit Pk', 'Start TH']));
    for (const off of ['Old Hut', 'High Pass', 'Nice View']) expect(labels).not.toContain(off);
    p.features.kinds.hut = true;
    expect(buildScene(p, undefined, osm).prims.flatMap((x) => (x.kind === 'text' ? [x.text] : []))).toContain('Old Hut');
  });
});

describe('/api/features only asks for what is requested', () => {
  const ok = (elements: unknown[] = []) => new Response(JSON.stringify({ elements }));
  const small = 'minLat=46.01&maxLat=46.08&minLon=-121.39&maxLon=-121.32';
  const queries = () => {
    const qs: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: unknown, init: any) => { qs.push(decodeURIComponent(init.body)); return ok(); }));
    return qs;
  };
  afterEach(() => vi.unstubAllGlobals());
  const call = (q: string) => handleApi(new Request(`http://x/api/features?${small}&${q}`)) as Promise<Response>;

  it('peaks and trailheads only: no hut/pass/viewpoint clauses, and no water query when water is off', async () => {
    const qs = queries();
    const d: any = await (await call('kinds=peak,trailhead&lakes=0&rivers=0')).json();
    expect(qs).toHaveLength(1);
    expect(qs[0]).toContain('"natural"="peak"');
    expect(qs[0]).toContain('"highway"="trailhead"');
    for (const nope of ['saddle', 'mountain_pass', 'alpine_hut', 'viewpoint', 'waterway']) expect(qs[0]).not.toContain(nope);
    expect(d.partial).toEqual([]);
  });
  it('rivers only, and lakes only, build different water queries', async () => {
    let qs = queries();
    await call('kinds=&lakes=0&rivers=1');
    expect(qs).toHaveLength(1); // no point kinds -> no node query
    expect(qs[0]).toContain('waterway');
    expect(qs[0]).not.toContain('natural"="water');
    vi.unstubAllGlobals();
    qs = queries();
    await call('kinds=&lakes=1&rivers=0');
    expect(qs[0]).toContain('natural"="water');
    expect(qs[0]).not.toContain('waterway');
  });
  it('a skipped query is not reported as a failure', async () => {
    queries();
    const d: any = await (await call('kinds=peak&lakes=0&rivers=0')).json();
    expect(d.partial).toEqual([]);
    expect(d.reason).toBeUndefined();
  });
  it('asking for nothing makes no upstream calls', async () => {
    const qs = queries();
    await call('kinds=&lakes=0&rivers=0');
    expect(qs).toHaveLength(0);
  });
  it('with no params at all, everything is requested (older clients)', async () => {
    const qs = queries();
    await handleApi(new Request(`http://x/api/features?${small}`));
    expect(qs).toHaveLength(2);
    expect(qs[0]).toContain('alpine_hut');
    expect(qs[1]).toContain('waterway');
  });
  it('unknown kinds in the request are ignored', async () => {
    const qs = queries();
    await call('kinds=peak,bogus,waypoint&lakes=0&rivers=0');
    expect(qs[0]).toContain('"natural"="peak"');
    expect(qs[0]).not.toContain('bogus');
  });
});
