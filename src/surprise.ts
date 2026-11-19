/**
 * Places that make striking plots, for "Surprise me": each one's centre, the width that shows it best, and why it
 * is worth drawing. Chosen for their street plans: star forts, canal rings, grids, radial capitals.
 */
export interface Surprise { name: string; location: string; lat: number; lon: number; widthKm: number; why: string }

export const SURPRISES: Surprise[] = [
  { name: 'Palmanova', location: 'Friuli, Italy', lat: 45.9054, lon: 13.3098, widthKm: 2.2, why: 'a nine-pointed star of a Renaissance fortress town' },
  { name: 'Venice', location: 'Veneto, Italy', lat: 45.4380, lon: 12.3330, widthKm: 3, why: 'streets that are canals, and a hundred islands' },
  { name: 'Amsterdam', location: 'North Holland, Netherlands', lat: 52.3720, lon: 4.8900, widthKm: 3, why: 'the 17th-century canal ring, in rings of water' },
  { name: 'Naarden', location: 'North Holland, Netherlands', lat: 52.2953, lon: 5.1625, widthKm: 1.6, why: 'a star fort with a double moat' },
  { name: 'Bourtange', location: 'Groningen, Netherlands', lat: 53.0072, lon: 7.1916, widthKm: 1.2, why: 'a tiny five-pointed fortress village' },
  { name: 'Manhattan', location: 'New York, USA', lat: 40.7580, lon: -73.9855, widthKm: 3.5, why: 'the grid, with Broadway cutting across it' },
  { name: 'Barcelona', location: 'Catalonia, Spain', lat: 41.3925, lon: 2.1620, widthKm: 2.5, why: 'the Eixample: blocks with their corners cut off' },
  { name: 'Paris', location: 'Île-de-France, France', lat: 48.8738, lon: 2.2950, widthKm: 2.2, why: 'twelve avenues meeting at the Arc de Triomphe' },
  { name: 'Washington', location: 'District of Columbia, USA', lat: 38.8899, lon: -77.0200, widthKm: 4, why: "L'Enfant's diagonal avenues over a grid" },
  { name: 'Kyoto', location: 'Kyoto, Japan', lat: 35.0116, lon: 135.7681, widthKm: 3, why: 'an ancient capital laid out as a chessboard' },
  { name: 'Brasília', location: 'Federal District, Brazil', lat: -15.7939, lon: -47.8828, widthKm: 7, why: 'a city planned in the shape of a plane' },
  { name: 'Valletta', location: 'Malta', lat: 35.8989, lon: 14.5146, widthKm: 1.6, why: 'a walled grid on a peninsula, ringed by harbours' },
  { name: 'Dubrovnik', location: 'Dubrovnik-Neretva, Croatia', lat: 42.6407, lon: 18.1077, widthKm: 1.2, why: 'an old town packed inside its sea walls' },
  { name: 'Savannah', location: 'Georgia, USA', lat: 32.0770, lon: -81.0930, widthKm: 2, why: "Oglethorpe's grid of wards, each round a square" },
  { name: 'La Plata', location: 'Buenos Aires, Argentina', lat: -34.9214, lon: -57.9545, widthKm: 5, why: 'a square city crossed by two diagonals' },
  { name: 'Canberra', location: 'Australian Capital Territory', lat: -35.2988, lon: 149.1300, widthKm: 5, why: 'circles and axes round a lake, by the Griffins' },
  { name: 'Chandigarh', location: 'Punjab, India', lat: 30.7333, lon: 76.7794, widthKm: 5, why: "Le Corbusier's city of sectors" },
  { name: 'Karlsruhe', location: 'Baden-Württemberg, Germany', lat: 49.0140, lon: 8.4044, widthKm: 2.5, why: 'a fan of streets spreading from the palace' },
  { name: 'Seattle', location: 'Washington, USA', lat: 47.6062, lon: -122.3321, widthKm: 2.5, why: 'two street grids that meet at an angle, on Elliott Bay' },
];

/** A place other than `not` (so pressing again always moves on). */
export function surprise(not?: string, random = Math.random): Surprise {
  const pool = SURPRISES.filter((s) => s.name !== not);
  return pool[Math.floor(random() * pool.length) % pool.length]!;
}
