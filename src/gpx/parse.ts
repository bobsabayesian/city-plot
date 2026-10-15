import { XMLParser } from 'fast-xml-parser';
import type { TrackPoint } from './types';
import type { Landmark } from '../features/types';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name) => ['trk', 'trkseg', 'trkpt', 'rte', 'rtept', 'wpt'].includes(name),
});

function toPoint(raw: any): TrackPoint | null {
  const lat = Number(raw['@_lat']);
  const lon = Number(raw['@_lon']);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const p: TrackPoint = { lat, lon };
  const ele = raw.ele === undefined ? NaN : Number(raw.ele);
  if (Number.isFinite(ele)) p.ele = ele;
  const t = raw.time === undefined ? NaN : Date.parse(String(raw.time));
  if (Number.isFinite(t)) p.time = t;
  return p;
}

/** Returns one flat point array: all <trkpt> in document order, falling back to <rtept>. */
export function parseGpx(xml: string): TrackPoint[] {
  const gpx = parser.parse(xml)?.gpx;
  if (!gpx) throw new Error('Not a GPX file');
  const pts: TrackPoint[] = [];
  for (const trk of gpx.trk ?? [])
    for (const seg of trk.trkseg ?? [])
      for (const raw of seg.trkpt ?? []) {
        const p = toPoint(raw);
        if (p) pts.push(p);
      }
  if (pts.length === 0)
    for (const rte of gpx.rte ?? [])
      for (const raw of rte.rtept ?? []) {
        const p = toPoint(raw);
        if (p) pts.push(p);
      }
  if (pts.length < 2) throw new Error('GPX contains no usable track points');
  return pts;
}

/** Named <wpt> entries, as landmarks (kind "waypoint"). Unnamed waypoints are skipped. */
export function parseWaypoints(xml: string): Landmark[] {
  const gpx = parser.parse(xml)?.gpx;
  const out: Landmark[] = [];
  for (const raw of gpx?.wpt ?? []) {
    const p = toPoint(raw);
    const name = raw.name === undefined ? '' : String(raw.name).trim();
    if (p && name) out.push({ id: `wpt-${out.length}`, name, kind: 'waypoint', lat: p.lat, lon: p.lon, ele: p.ele });
  }
  return out;
}
