import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../src/store';
import { defaultProject } from '../src/scene/project';
import { buildScene } from '../src/scene/buildScene';
import type { GeocodeHit } from '../src/lookup';

const hit = (name: string, lat: number, lon: number): GeocodeHit => ({ name, lat, lon, kind: 'school', location: 'Kenton County, Kentucky', bbox: { minLat: lat - 0.001, maxLat: lat + 0.001, minLon: lon - 0.001, maxLon: lon + 0.001 } });
const choose = (...hits: GeocodeHit[]) => { useStore.setState({ searchResults: hits }); useStore.getState().choosePlace(0); };
const project = () => useStore.getState().project;
const drawn = () => buildScene(project()).prims.flatMap((x) => (x.kind === 'text' ? [x.text] : []));

beforeEach(() => useStore.setState({ project: defaultProject(), searchResults: [], layers: {}, landmarks: { status: 'idle' } }));

describe('a searched place is offered as one of my landmarks', () => {
  it('is added, switched off, with the place name and position', () => {
    choose(hit('Dixie Heights High School', 39.0, -84.6));
    const [c] = project().custom;
    expect(c).toMatchObject({ name: 'Dixie Heights High School', kind: 'custom', lat: 39.0, lon: -84.6, fromSearch: true });
    expect(project().features.overrides[c!.id]).toEqual({ hidden: true });
  });
  it('is not drawn until it is switched on', () => {
    choose(hit('Dixie Heights High School', 39.0, -84.6));
    expect(drawn()).not.toContain('Dixie Heights High School');
    const id = project().custom[0]!.id;
    useStore.getState().set((p) => { p.features.overrides[id] = { hidden: false }; });
    expect(drawn()).toContain('Dixie Heights High School');
  });
  it('the next search replaces an entry that was never switched on', () => {
    choose(hit('Dixie Heights High School', 39.0, -84.6));
    choose(hit('Covington', 39.08, -84.5));
    expect(project().custom.map((c) => c.name)).toEqual(['Covington']);
  });
  it('but keeps one that was switched on, and your own landmarks', () => {
    choose(hit('Dixie Heights High School', 39.0, -84.6));
    const id = project().custom[0]!.id;
    useStore.getState().set((p) => {
      p.features.overrides[id] = { hidden: false };
      p.custom.push({ id: 'custom-9', name: 'Home', kind: 'custom', lat: 39.1, lon: -84.4 });
    });
    choose(hit('Covington', 39.08, -84.5));
    expect(project().custom.map((c) => c.name).sort()).toEqual(['Covington', 'Dixie Heights High School', 'Home']);
    expect(project().features.overrides[id]).toEqual({ hidden: false });
  });
  it('choosing the same place again does not add it twice', () => {
    choose(hit('Covington', 39.08, -84.5));
    useStore.getState().set((p) => { p.features.overrides[p.custom[0]!.id] = { hidden: false }; });
    choose(hit('Covington', 39.08, -84.5));
    expect(project().custom).toHaveLength(1);
  });
  it('ids never clash with ones already used', () => {
    useStore.getState().set((p) => { p.custom.push({ id: 'custom-1', name: 'Home', kind: 'custom', lat: 1, lon: 1 }); });
    choose(hit('Covington', 39.08, -84.5));
    expect(new Set(project().custom.map((c) => c.id)).size).toBe(2);
  });
});
