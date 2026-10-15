export interface BBox {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

const R = 6371008.8;

export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function bbox(pts: { lat: number; lon: number }[]): BBox {
  const b = { minLat: Infinity, maxLat: -Infinity, minLon: Infinity, maxLon: -Infinity };
  for (const p of pts) {
    b.minLat = Math.min(b.minLat, p.lat);
    b.maxLat = Math.max(b.maxLat, p.lat);
    b.minLon = Math.min(b.minLon, p.lon);
    b.maxLon = Math.max(b.maxLon, p.lon);
  }
  return b;
}

/** Web Mercator in meters (y grows north). */
export function mercator(lat: number, lon: number): [number, number] {
  const rad = Math.PI / 180;
  return [R * lon * rad, R * Math.log(Math.tan(Math.PI / 4 + (lat * rad) / 2))];
}

export interface Fit {
  /** lat/lon -> poster mm (y grows down) */
  toMm(lat: number, lon: number): [number, number];
  /** poster mm -> lat/lon */
  fromMm(x: number, y: number): [number, number];
  /** Web Mercator meters -> poster mm (linear) */
  mercToMm(mx: number, my: number): [number, number];
  /** meters on ground per mm on paper */
  metersPerMm: number;
}

export const WORLD_M = 2 * Math.PI * R;

export function inverseMercator(mx: number, my: number): [number, number] {
  const deg = 180 / Math.PI;
  return [(2 * Math.atan(Math.exp(my / R)) - Math.PI / 2) * deg, (mx / R) * deg];
}

/** Fit a bbox centered inside the frame (x, y, w, h in mm), preserving aspect ratio. */
export function fitBBox(b: BBox, frame: { x: number; y: number; w: number; h: number }): Fit {
  const [x0, y0] = mercator(b.minLat, b.minLon);
  const [x1, y1] = mercator(b.maxLat, b.maxLon);
  const w = Math.max(x1 - x0, 1e-6);
  const h = Math.max(y1 - y0, 1e-6);
  const scale = Math.min(frame.w / w, frame.h / h); // mm per meter (mercator)
  const offX = frame.x + (frame.w - w * scale) / 2;
  const offY = frame.y + (frame.h - h * scale) / 2;
  const mercToMm = (mx: number, my: number): [number, number] => [offX + (mx - x0) * scale, offY + (y1 - my) * scale];
  return {
    metersPerMm: 1 / scale,
    mercToMm,
    toMm: (lat, lon) => mercToMm(...mercator(lat, lon)),
    fromMm: (x, y) => inverseMercator(x0 + (x - offX) / scale, y1 - (y - offY) / scale),
  };
}
