import { afterEach, describe, expect, it, vi } from 'vitest';
import { placeLandmarks, type PlaceInput } from '../src/features/select';
import { describePoolItem } from '../src/features/format';
import { defaultFeatures, type Landmark, type WaterLine } from '../src/features/types';
import { fitBBox } from '../src/geo/project';
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

/** Twelve well-spaced peaks, tallest = p11, so rank order is p11, p10, p9, ... */
const peaks: Landmark[] = Array.from({ length: 12 }, (_, i) =>
  lm(`p${i}`, `Peak ${i}`, 'peak', 46.03 + Math.floor(i / 3) * 0.04, -121.33 + (i % 3) * 0.12, 2000 + i * 50));
const ids = (labels: { id: string }[]) => labels.map((l) => l.id).sort();
const settings = (maxLabels: number, over: Partial<ReturnType<typeof defaultFeatures>> = {}) => ({ ...defaultFeatures(), maxLabels, ...over });

describe('open slots: a hidden label leaves its slot open', () => {
  it('untouched: the top-ranked labels fill every slot, so no slot is open', () => {
    const r = placeLandmarks(input(peaks, { settings: settings(5) }));
    expect(r.labels).toHaveLength(5);
    expect(ids(r.labels)).toEqual(['p10', 'p11', 'p7', 'p8', 'p9']);
    expect(r.open.point).toBe(0);
  });
  it('hiding one does NOT promote the next candidate; the slot opens', () => {
    const s = settings(5);
    s.overrides['p9'] = { hidden: true };
    const r = placeLandmarks(input(peaks, { settings: s }));
    expect(ids(r.labels)).toEqual(['p10', 'p11', 'p7', 'p8']); // p6 was not pulled in
    expect(r.open.point).toBe(1);
    expect(r.pool.find((p) => p.id === 'p6')).toMatchObject({ reason: 'not chosen' });
    expect(r.pool.find((p) => p.id === 'p9')).toMatchObject({ reason: 'hidden' });
  });
  it('hiding two opens two slots, and un-hiding closes them again', () => {
    const s = settings(5);
    s.overrides['p9'] = { hidden: true };
    s.overrides['p8'] = { hidden: true };
    expect(placeLandmarks(input(peaks, { settings: s })).open.point).toBe(2);
    s.overrides['p9'] = {};
    s.overrides['p8'] = { hidden: false };
    const r = placeLandmarks(input(peaks, { settings: s }));
    expect(r.open.point).toBe(0);
    expect(r.labels).toHaveLength(5);
  });
  it('hiding a label that was never in the top group changes nothing', () => {
    const s = settings(5);
    s.overrides['p0'] = { hidden: true }; // the lowest ranked; not reached
    const r = placeLandmarks(input(peaks, { settings: s }));
    expect(r.labels).toHaveLength(5);
    expect(r.open.point).toBe(0);
  });
  it('the entries list still shows the hidden one so it can be restored', () => {
    const s = settings(5);
    s.overrides['p9'] = { hidden: true };
    const e = placeLandmarks(input(peaks, { settings: s })).entries.find((x) => x.id === 'p9')!;
    expect(e).toMatchObject({ hidden: true, placed: false });
  });
});

describe('choosing from the list', () => {
  it('pinning a pool candidate fills the open slot', () => {
    const s = settings(5);
    s.overrides['p9'] = { hidden: true };
    s.overrides['p6'] = { pinned: true };
    const r = placeLandmarks(input(peaks, { settings: s }));
    expect(ids(r.labels)).toEqual(['p10', 'p11', 'p6', 'p7', 'p8']);
    expect(r.open.point).toBe(0);
    expect(r.entries.find((e) => e.id === 'p6')).toMatchObject({ pinned: true, placed: true });
    expect(r.pool.find((p) => p.id === 'p6')).toBeUndefined(); // drawn, so no longer offered
  });
  it('the list offers kinds that are switched off, and pinning one draws it anyway', () => {
    const hut = lm('h1', 'Muir Hut', 'hut', 46.12, -121.2, 3100);
    const s = settings(5);
    expect(s.kinds.hut).toBe(false);
    const before = placeLandmarks(input([...peaks.slice(0, 3), hut], { settings: s }));
    expect(before.labels.map((l) => l.id)).not.toContain('h1'); // off, so not drawn on its own
    expect(before.open.point).toBe(2); // 3 peaks, 5 slots
    expect(before.pool.find((p) => p.id === 'h1')).toMatchObject({ reason: 'kind off', kind: 'hut' });
    s.overrides['h1'] = { pinned: true };
    const after = placeLandmarks(input([...peaks.slice(0, 3), hut], { settings: s }));
    expect(after.labels.map((l) => l.id)).toContain('h1');
    expect(after.open.point).toBe(1);
  });
  it('seven shown with eight allowed: a slot is open and the pool has the others', () => {
    // 7 enabled-kind candidates, 1 hut (kind off), limit 8
    const seven = peaks.slice(0, 7);
    const hut = lm('h1', 'Old Hut', 'hut', 46.15, -121.15);
    const r = placeLandmarks(input([...seven, hut], { settings: settings(8) }));
    expect(r.labels).toHaveLength(7);
    expect(r.open.point).toBe(1);
    expect(r.pool.map((p) => p.id)).toEqual(['h1']);
  });
  it('GPX waypoints (off by default) are offered and rank at the top of the list', () => {
    const wpt = lm('wpt-0', 'Camp', 'waypoint', 46.1, -121.2);
    const s = settings(5);
    const r = placeLandmarks(input([...peaks.slice(0, 3), wpt], { settings: s }));
    expect(r.pool[0]).toMatchObject({ id: 'wpt-0', reason: 'kind off', kind: 'waypoint' });
  });
  it('the pool is ranked best first and never includes what is drawn', () => {
    const s = settings(3);
    const r = placeLandmarks(input(peaks, { settings: s }));
    const drawn = new Set(r.labels.map((l) => l.id));
    expect(r.pool.some((p) => drawn.has(p.id))).toBe(false);
    expect(r.pool[0]!.id).toBe('p8'); // next best after p9, p10, p11
  });
  it('pinned labels come first, so they win over an equal-ranked auto label for the last slot', () => {
    const s = settings(2);
    s.overrides['p0'] = { pinned: true }; // lowest ranked, but chosen
    const r = placeLandmarks(input(peaks, { settings: s }));
    expect(ids(r.labels)).toEqual(['p0', 'p11']);
  });
  it('removing a pinned label gives its slot back, and it returns to the list', () => {
    const s = settings(3);
    s.overrides['p0'] = { pinned: true, hidden: true };
    const r = placeLandmarks(input(peaks, { settings: s }));
    expect(r.labels).toHaveLength(3); // refilled by rank, since it never held a slot
    expect(r.pool.find((p) => p.id === 'p0')).toMatchObject({ reason: 'hidden' });
  });
  it('pinning more than the limit draws only up to the limit', () => {
    const s = settings(1);
    s.overrides['p0'] = { pinned: true };
    s.overrides['p1'] = { pinned: true };
    expect(placeLandmarks(input(peaks, { settings: s })).labels).toHaveLength(1);
  });
  it('a pinned label can be renamed like any other', () => {
    const s = settings(2);
    s.overrides['p0'] = { pinned: true, name: 'Little One' };
    expect(placeLandmarks(input(peaks, { settings: s })).labels.map((l) => l.text)).toContain('Little One');
  });
  it('a label with no room does not hold a slot: the next candidate takes it', () => {
    // two peaks on the same spot: only one label fits, the other has no room but must not block the third
    const [x, y] = fit.toMm(46.1, -121.2);
    const [la, lo] = fit.fromMm(x, y + 0.5);
    const a = lm('a', 'Alpha Peak Long Name', 'peak', 46.1, -121.2, 3000);
    const b = lm('b', 'Beta Peak Long Name', 'peak', la, lo, 2900);
    const far = lm('c', 'Gamma', 'peak', 46.04, -121.35, 2000);
    const r = placeLandmarks(input([a, b, far], { settings: settings(3) }));
    expect(r.labels.map((l) => l.id)).toContain('c');
  });
});

describe('water name slots work the same way, separately', () => {
  const flat = (id: string, name: string, lat: number): WaterLine => ({ id, kind: 'river', name, coords: [[lat, -121.35], [lat, -121.05]] });
  const rivers = [flat('w1', 'Alpha River', 46.05), flat('w2', 'Bravo River', 46.1), flat('w3', 'Charlie River', 46.15)];
  const run = (over: Record<string, { hidden?: boolean; pinned?: boolean }>, maxWater = 2) => {
    const s = settings(0, { waterLabels: true, maxWaterLabels: maxWater });
    s.overrides = over;
    return placeLandmarks(input([], { water: rivers, settings: s }));
  };
  it('hiding a drawn river leaves a water slot open without refilling it', () => {
    const base = run({});
    expect(base.labels).toHaveLength(2);
    const hide = base.labels[0]!.id;
    const r = run({ [hide]: { hidden: true } });
    expect(r.labels).toHaveLength(1);
    expect(r.open.water).toBe(1);
    expect(r.open.point).toBe(0 + 0); // point slots are separate (limit 0 here)
    expect(r.pool.some((p) => p.group === 'water' && p.reason === 'not chosen')).toBe(true);
  });
  it('picking the third river from the list fills the slot', () => {
    const base = run({});
    const hide = base.labels[0]!.id;
    const notDrawn = ['riv-alpha river', 'riv-bravo river', 'riv-charlie river'].find((i) => !base.labels.some((l) => l.id === i))!;
    const r = run({ [hide]: { hidden: true }, [notDrawn]: { pinned: true } });
    expect(r.labels.map((l) => l.id)).toContain(notDrawn);
    expect(r.open.water).toBe(0);
  });
  it('water names are not offered when water labels are off', () => {
    const s = settings(0, { waterLabels: false });
    expect(placeLandmarks(input([], { water: rivers, settings: s })).pool).toHaveLength(0);
  });
  it('point and water slots do not affect each other', () => {
    const s = settings(2, { waterLabels: true, maxWaterLabels: 2 });
    s.overrides['p11'] = { hidden: true };
    const r = placeLandmarks(input(peaks, { water: rivers, settings: s }));
    expect(r.open.point).toBe(1);
    expect(r.open.water).toBe(0);
  });
});

describe('the scene and the list text', () => {
  it('composeScene exposes the open slots and pool for the editor', () => {
    const pts = sampleTrack();
    const p = { ...defaultProject(), points: pts, waypoints: sampleWaypoints(pts) };
    const osm = { landmarks: [lm('n1', 'Little Peak', 'peak', 46.805, -121.69, 2800)], water: [], covers: B };
    const c = composeScene(p, undefined, osm);
    expect(c.open).toEqual({ point: expect.any(Number), water: expect.any(Number) });
    expect(c.open!.point).toBeGreaterThan(0); // only one enabled-kind candidate for 8 slots
    expect(c.pool!.some((i) => i.kind === 'waypoint' && i.reason === 'kind off')).toBe(true); // Summit / Trailhead offered
  });
  it('pinning a waypoint from the list draws it though GPX waypoints are off', () => {
    const pts = sampleTrack();
    const p = { ...defaultProject(), points: pts, waypoints: sampleWaypoints(pts) };
    expect(p.features.kinds.waypoint).toBe(false);
    p.features.overrides['wpt-0'] = { pinned: true };
    const texts = buildScene(p).prims.flatMap((x) => (x.kind === 'text' ? [x.text] : []));
    expect(texts).toContain('Summit');
    expect(texts).not.toContain('Trailhead');
  });
  it('describes a list item with its kind, elevation in the chosen units, and why it is not drawn', () => {
    const item = { id: 'n1', name: 'Little Tahoma', kind: 'peak' as const, group: 'point' as const, ele: 3000, reason: 'kind off' as const };
    expect(describePoolItem(item, 'imperial')).toBe('Little Tahoma · peak · 9,843 ft (kind switched off)');
    expect(describePoolItem(item, 'metric')).toBe('Little Tahoma · peak · 3,000 m (kind switched off)');
    expect(describePoolItem({ ...item, ele: undefined, reason: 'not chosen' }, 'metric')).toBe('Little Tahoma · peak');
    expect(describePoolItem({ ...item, kind: 'trailhead', reason: 'hidden' }, 'metric')).toContain('trailhead');
    expect(describePoolItem({ ...item, kind: 'waypoint', reason: 'no room' }, 'metric')).toContain('no room on the map');
  });
});
afterEach(() => vi.unstubAllGlobals());
