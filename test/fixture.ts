import { defaultProject, type Project } from '../src/scene/project';
import type { CityData } from '../src/scene/buildScene';
import type { LayerData, Way } from '../src/city/types';
import type { Landmark } from '../src/features/types';

/** Downtown Seattle, 2.5 km wide (about 3.5 km tall on the default page, inside the 4 km buildings limit). */
export const SEATTLE = { lat: 47.6062, lon: -122.3321 };

/** A project with a place and region chosen, as after a search. */
export const cityProject = (edit: (p: Project) => void = () => {}): Project => {
  const p = defaultProject();
  p.place = { name: 'Seattle', lat: SEATTLE.lat, lon: SEATTLE.lon, kind: 'city', location: 'King County, Washington' };
  p.region = { ...SEATTLE, widthKm: 2.5 };
  edit(p);
  return p;
};

const line = (id: string, ...pts: [number, number][]): Way => ({ id, closed: false, pts: pts.flat() });
const ring = (id: string, ...pts: [number, number][]): Way => ({ id, closed: true, pts: [...pts, pts[0]!].flat() });
const covers = { minLat: 47.5, maxLat: 47.7, minLon: -122.5, maxLon: -122.2 };
const at = (dLat: number, dLon: number): [number, number] => [SEATTLE.lat + dLat, SEATTLE.lon + dLon];
const layer = (...ways: Way[]): LayerData => ({ covers, ways });

/** A little made-up map around the region's center: a street grid, a block, a park, a lake, a river. */
export const cityData = (): CityData => ({
  layers: {
    major: layer(line('major-1', at(-0.01, -0.01), at(0.01, 0.01))),
    secondary: layer(line('sec-1', at(0.002, -0.01), at(0.002, 0.01)), line('sec-2', at(-0.002, -0.01), at(-0.002, 0.01))),
    minor: layer(...Array.from({ length: 6 }, (_, i) => line(`min-${i}`, at(-0.01 + i * 0.004, -0.01), at(-0.01 + i * 0.004, 0.01)))),
    buildings: layer(ring('b-1', at(0.001, 0.001), at(0.001, 0.0025), at(0.0025, 0.0025), at(0.0025, 0.001))),
    parks: layer(ring('park-1', at(-0.006, -0.006), at(-0.006, -0.002), at(-0.002, -0.002), at(-0.002, -0.006))),
    water: layer(
      { ...ring('lake-1', at(0.005, -0.008), at(0.005, -0.004), at(0.008, -0.004), at(0.008, -0.008)), sub: 'lake', name: 'Lake Test' },
      { ...line('river-1', at(-0.009, -0.01), at(-0.008, 0), at(-0.009, 0.01)), sub: 'river', name: 'River Test' },
    ),
  },
  landmarks: [
    { id: 'n1', name: 'Space Needle', kind: 'attraction', lat: SEATTLE.lat + 0.004, lon: SEATTLE.lon - 0.003, notable: true },
    { id: 'n2', name: 'Art Museum', kind: 'museum', lat: SEATTLE.lat - 0.003, lon: SEATTLE.lon + 0.004 },
  ] satisfies Landmark[],
});
