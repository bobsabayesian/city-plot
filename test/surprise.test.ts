import { describe, expect, it } from 'vitest';
import { surprise, SURPRISES } from '../src/surprise';
import { useStore } from '../src/store';
import { fetchingLine } from '../src/ui/App';
import { REGION_MAX_KM, REGION_MIN_KM } from '../src/scene/project';

describe('Surprise me', () => {
  it('every place is somewhere real, at a width the map can show, with a reason', () => {
    expect(new Set(SURPRISES.map((s) => s.name)).size).toBe(SURPRISES.length);
    for (const s of SURPRISES) {
      expect(Math.abs(s.lat)).toBeLessThan(80);
      expect(Math.abs(s.lon)).toBeLessThanOrEqual(180);
      expect(s.widthKm).toBeGreaterThanOrEqual(REGION_MIN_KM);
      expect(s.widthKm).toBeLessThanOrEqual(REGION_MAX_KM);
      expect(s.why.length).toBeGreaterThan(10);
    }
  });
  it('never offers the place already on the map', () => {
    for (let k = 0; k < 50; k++) expect(surprise('Venice', () => k / 50).name).not.toBe('Venice');
  });
  it('goes there by name, at its width, and says why; a search clears the line', async () => {
    const s = SURPRISES.find((x) => x.name === 'Palmanova')!;
    useStore.getState().goTo({ name: s.name, lat: s.lat, lon: s.lon, kind: 'city', location: s.location }, s.widthKm, s.why);
    const st = useStore.getState();
    expect(st.project.place!.name).toBe('Palmanova');
    expect(st.project.region).toEqual({ lat: s.lat, lon: s.lon, widthKm: s.widthKm });
    expect(st.surprise).toContain('star');
    // a coordinate search needs no network and must clear the line
    await useStore.getState().searchPlace('47.6, -122.3');
    expect(useStore.getState().surprise).toBe('');
  });
});

describe('what the bar says while a map loads', () => {
  it('names the place, and always the same way for the same place', () => {
    expect(fetchingLine('Venice')).toContain('Venice');
    expect(fetchingLine('Venice')).toBe(fetchingLine('Venice'));
    const seen = new Set(SURPRISES.map((s) => fetchingLine(s.name).replace(s.name, '#')));
    expect(seen.size).toBeGreaterThan(1);
  });
});
