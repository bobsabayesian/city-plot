import type { Project } from '../scene/project';
import { photoDate, type PhotoInfo } from '../photos';
import type { Landmark } from './types';

/** Photos taken within this distance of each other on the same day are one stop (twenty shots of one dinner). */
export const SAME_PLACE_M = 60;

/** A photo to put on the route: its file name and what its EXIF says. */
/** A photo to put on the route: its file name, what its EXIF says, and a name the user gave it (else it is named by its date). */
export interface PhotoIn { file: string; info: PhotoInfo; name?: string }
export interface PhotoResult {
  /** new stops, in route order */
  added: string[];
  /** photos taken where a stop already is, on the same day */
  merged: number;
  /** photos with no location: they need placing by hand */
  unplaced: PhotoIn[];
}

const metres = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
  const k = Math.PI / 180;
  const x = (b.lon - a.lon) * k * Math.cos(((a.lat + b.lat) / 2) * k);
  return Math.hypot(x, (b.lat - a.lat) * k) * 6371000;
};

/** Oldest first, photos without a date last (plain string order: the dates are "YYYY-MM-DDTHH:MM:SS"). */
export const byTime = (a: PhotoIn, b: PhotoIn) => {
  const x = a.info.takenAt, y = b.info.takenAt;
  return x === y ? 0 : x === undefined ? 1 : y === undefined ? -1 : x < y ? -1 : 1;
};

/** A stop's name from a photo: the day it was taken, else the file name without its extension. */
export const photoStopName = (ph: PhotoIn) => ph.name?.trim() || (ph.info.takenAt ? photoDate(ph.info.takenAt) : ph.file.replace(/\.[^.]+$/, '') || 'Photo');

/** The next free user-landmark id. */
function nextId(p: Project): string {
  let n = p.custom.length + 1;
  while (p.custom.some((c) => c.id === `custom-${n}`)) n++;
  return `custom-${n}`;
}

/**
 * Add a landmark for a placed photo and put it on the route in date order: before the first stop taken later, or
 * at the end when it has no date (or nothing on the route is later). Returns its id. Mutates (use on a draft).
 */
export function addPhotoStop(p: Project, ph: PhotoIn, lat: number, lon: number): string {
  const id = nextId(p);
  const lm: Landmark = { id, name: photoStopName(ph), kind: 'custom', lat, lon, icon: 'dot', ...(ph.info.takenAt ? { takenAt: ph.info.takenAt } : {}) };
  p.custom.push(lm);
  const stops = p.route.stops.filter((s) => p.custom.some((c) => c.id === s));
  const when = ph.info.takenAt;
  const at = when ? stops.findIndex((s) => { const t = p.custom.find((c) => c.id === s)?.takenAt; return !!t && t > when; }) : -1;
  if (at < 0) stops.push(id); else stops.splice(at, 0, id);
  p.route.stops = stops;
  p.route.enabled = true;
  return id;
}

/** Put a batch of photos on the route. Mutates (use on a draft). */
export function addPhotos(p: Project, photos: PhotoIn[]): PhotoResult {
  const out: PhotoResult = { added: [], merged: 0, unplaced: [] };
  // oldest first, so a batch reads as a story; undated ones after
  const sorted = [...photos].sort(byTime);
  for (const ph of sorted) {
    const { lat, lon, takenAt } = ph.info;
    if (lat === undefined || lon === undefined) { out.unplaced.push(ph); continue; }
    const day = takenAt?.slice(0, 10);
    const same = p.custom.find((c) => p.route.stops.includes(c.id) && day && c.takenAt?.slice(0, 10) === day && metres(c, { lat, lon }) < SAME_PLACE_M);
    if (same) { out.merged++; continue; }
    out.added.push(addPhotoStop(p, ph, lat, lon));
  }
  return out;
}

/** The region that shows every stop of the route, with some room around it (undefined with fewer than one stop). */
export function routeRegion(stops: { lat: number; lon: number }[], minKm = 1): { lat: number; lon: number; widthKm: number } | undefined {
  if (!stops.length) return undefined;
  const lats = stops.map((s) => s.lat), lons = stops.map((s) => s.lon);
  const lat = (Math.min(...lats) + Math.max(...lats)) / 2, lon = (Math.min(...lons) + Math.max(...lons)) / 2;
  const ew = metres({ lat, lon: Math.min(...lons) }, { lat, lon: Math.max(...lons) });
  const ns = metres({ lat: Math.min(...lats), lon }, { lat: Math.max(...lats), lon });
  // the page is usually taller than wide, so the north-south spread needs less width than the east-west one
  return { lat, lon, widthKm: Math.max(minKm, (Math.max(ew, ns * 0.75) / 1000) * 1.35) };
}
