import { describe, expect, it } from 'vitest';
import { addPhotos, addPhotoStop, routeRegion, SAME_PLACE_M, type PhotoIn } from '../src/features/photoStops';
import { routeStops } from '../src/features/route';
import { cityProject } from './fixture';

const photo = (file: string, lat?: number, lon?: number, takenAt?: string): PhotoIn => ({ file, info: { ...(lat !== undefined ? { lat, lon } : {}), ...(takenAt ? { takenAt } : {}) } });
const names = (p: ReturnType<typeof cityProject>) => routeStops(p.route, p.custom).map((s) => s.name);

describe('photos onto the route', () => {
  it('each located photo becomes a stop named by its day, in the order they were taken, and the route is switched on', () => {
    const p = cityProject();
    const r = addPhotos(p, [
      photo('IMG_3.jpg', 47.60, -122.33, '2014-06-21T15:00:00'),
      photo('IMG_1.jpg', 47.61, -122.34, '2009-03-03T10:00:00'),
      photo('IMG_2.jpg', 47.62, -122.35, '2011-08-14T19:30:00'),
    ]);
    expect(r.added).toHaveLength(3);
    expect(names(p)).toEqual(['3 Mar 2009', '14 Aug 2011', '21 Jun 2014']);
    expect(p.route.enabled).toBe(true);
    expect(p.custom.every((c) => c.icon === 'dot' && c.takenAt)).toBe(true);
  });

  it('a later batch slots into date order among the stops already there; undated photos go at the end', () => {
    const p = cityProject();
    addPhotos(p, [photo('a.jpg', 47.60, -122.33, '2009-01-01T00:00:00'), photo('c.jpg', 47.62, -122.33, '2020-01-01T00:00:00')]);
    addPhotos(p, [photo('b.jpg', 47.61, -122.33, '2015-05-05T00:00:00'), photo('Our wedding.jpg', 47.63, -122.33)]);
    expect(names(p)).toEqual(['1 Jan 2009', '5 May 2015', '1 Jan 2020', 'Our wedding']);
  });

  it('photos taken at one place on one day are one stop', () => {
    const p = cityProject();
    const near = 47.6 + (SAME_PLACE_M / 2) / 111_000;
    const r = addPhotos(p, [
      photo('1.jpg', 47.6, -122.33, '2014-06-21T18:00:00'),
      photo('2.jpg', near, -122.33, '2014-06-21T18:05:00'),
      photo('3.jpg', near, -122.33, '2015-06-21T18:05:00'), // a year later: a new visit
    ]);
    expect(r.added).toHaveLength(2);
    expect(r.merged).toBe(1);
  });

  it('photos without a location are handed back to be placed by hand, and placing one puts it in date order', () => {
    const p = cityProject();
    const r = addPhotos(p, [photo('a.jpg', 47.6, -122.33, '2010-01-01T00:00:00'), photo('b.jpg', undefined, undefined, '2005-01-01T00:00:00')]);
    expect(r.unplaced.map((x) => x.file)).toEqual(['b.jpg']);
    addPhotoStop(p, r.unplaced[0]!, 47.61, -122.34);
    expect(names(p)).toEqual(['1 Jan 2005', '1 Jan 2010']);
  });

  it('new ids never clash with existing landmarks', () => {
    const p = cityProject((q) => { q.custom = [{ id: 'custom-2', name: 'Home', kind: 'custom', lat: 47.6, lon: -122.3 }]; });
    addPhotos(p, [photo('a.jpg', 47.6, -122.33), photo('b.jpg', 47.7, -122.33)]);
    expect(new Set(p.custom.map((c) => c.id)).size).toBe(3);
  });
});

describe('fitting the map to the route', () => {
  it('centres on the stops and covers them with room to spare', () => {
    const r = routeRegion([{ lat: 47.60, lon: -122.36 }, { lat: 47.62, lon: -122.30 }])!;
    expect(r.lat).toBeCloseTo(47.61, 6);
    expect(r.lon).toBeCloseTo(-122.33, 6);
    expect(r.widthKm).toBeGreaterThan(4.5); // 0.06° of longitude at 47.6° is about 4.5 km
    expect(r.widthKm).toBeLessThan(7);
  });
  it('one stop gets at least a kilometre; none gets nothing', () => {
    expect(routeRegion([{ lat: 47.6, lon: -122.3 }])!.widthKm).toBe(1);
    expect(routeRegion([])).toBeUndefined();
  });
});
