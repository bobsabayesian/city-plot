import { describe, expect, it } from 'vitest';
import { parseGpx } from '../src/gpx/parse';
import { cleanTrack, collapseStationary, douglasPeucker, removeElevationSpikes } from '../src/gpx/clean';
import { computeStats, elevationGain, formatFeet, formatMiles } from '../src/geo/stats';
import { bbox, fitBBox, haversine } from '../src/geo/project';

const pt = (lat: number, lon: number, ele?: number, time?: string) =>
  `<trkpt lat="${lat}" lon="${lon}">${ele === undefined ? '' : `<ele>${ele}</ele>`}${time ? `<time>${time}</time>` : ''}</trkpt>`;
const gpx = (...segs: string[][]) =>
  `<?xml version="1.0"?><gpx version="1.1"><trk>${segs.map((s) => `<trkseg>${s.join('')}</trkseg>`).join('')}</trk></gpx>`;

describe('parseGpx', () => {
  it('reads lat/lon/ele/time across segments', () => {
    const pts = parseGpx(
      gpx([pt(46, -121, 100, '2024-07-04T10:00:00Z')], [pt(46.001, -121, 110), pt(46.002, -121)]),
    );
    expect(pts).toHaveLength(3);
    expect(pts[0]).toMatchObject({ lat: 46, lon: -121, ele: 100, time: Date.parse('2024-07-04T10:00:00Z') });
    expect(pts[2]!.ele).toBeUndefined();
  });
  it('handles a single trkpt per segment (non-array xml)', () => {
    expect(() => parseGpx(gpx([pt(1, 1), pt(1.1, 1)]))).not.toThrow();
  });
  it('rejects non-gpx and empty tracks', () => {
    expect(() => parseGpx('<foo/>')).toThrow();
    expect(() => parseGpx(gpx([pt(1, 1)]))).toThrow();
  });
});

describe('cleaning', () => {
  it('removes an elevation spike', () => {
    const base = Array.from({ length: 11 }, (_, i) => ({ lat: 46 + i * 0.0003, lon: -121, ele: 1000 + i }));
    base[5]!.ele = 5000;
    const out = removeElevationSpikes(base);
    expect(out[5]!.ele).toBeLessThan(1100);
  });
  it('collapses lunch-stop drift into one point', () => {
    const drift = Array.from({ length: 30 }, (_, i) => ({ lat: 46 + (i % 3) * 1e-5, lon: -121 + (i % 2) * 1e-5 }));
    const moving = [{ lat: 46.01, lon: -121 }, { lat: 46.02, lon: -121 }];
    const out = collapseStationary([...drift, ...moving]);
    expect(out.length).toBeLessThan(5);
    expect(out[out.length - 1]).toEqual(moving[1]);
  });
  it('douglas-peucker drops collinear points but keeps corners', () => {
    const line = Array.from({ length: 20 }, (_, i) => ({ lat: 46, lon: -121 + i * 0.001 }));
    const corner = [...line, { lat: 46.01, lon: -121 + 0.019 }];
    const out = douglasPeucker(corner, 5);
    expect(out.length).toBe(3);
    expect(out[0]).toBe(corner[0]);
    expect(out[out.length - 1]).toBe(corner[corner.length - 1]);
  });
  it('cleanTrack keeps endpoints', () => {
    const pts = Array.from({ length: 100 }, (_, i) => ({ lat: 46 + i * 1e-4, lon: -121, ele: 1000 }));
    const out = cleanTrack(pts, 2);
    expect(out[0]).toEqual(pts[0]);
    expect(out[out.length - 1]).toEqual(pts[99]);
  });
});

describe('stats and projection', () => {
  it('haversine: 1 degree latitude ~ 111.2 km', () => {
    expect(haversine(0, 0, 1, 0)).toBeGreaterThan(111000);
    expect(haversine(0, 0, 1, 0)).toBeLessThan(111400);
  });
  it('gain ignores noise under threshold', () => {
    const noisy = [100, 101, 100, 102, 100, 101].map((ele) => ({ lat: 0, lon: 0, ele }));
    expect(elevationGain(noisy)).toBe(0);
    const climb = [100, 110, 120, 115, 130].map((ele) => ({ lat: 0, lon: 0, ele }));
    expect(elevationGain(climb)).toBe(35);
  });
  it('computeStats picks peak and start time', () => {
    const s = computeStats([
      { lat: 1, lon: 1, ele: 10, time: 5 },
      { lat: 1.1, lon: 1, ele: 50 },
      { lat: 1.2, lon: 1, ele: 20 },
    ]);
    expect(s.peak!.ele).toBe(50);
    expect(s.reliefM).toBe(40);
    expect(s.startTime).toBe(5);
  });
  describe('route time plausibility', () => {
    // ~11.1 km straight north, timed over `ms`
    const track = (ms: number) => [
      { lat: 46, lon: -121, time: 0 },
      { lat: 46.1, lon: -121, time: ms },
    ];
    it('keeps a normal hike duration', () => {
      expect(computeStats(track(6 * 3600e3)).durationMs).toBe(6 * 3600e3);
    });
    it('drops a duration implying faster than 125 mph', () => {
      expect(computeStats(track(60e3)).durationMs).toBeUndefined();
    });
    it('applies the 125 mph boundary', () => {
      const d = computeStats(track(1e9)).distanceM;
      const msAt = (mph: number) => (d / (mph * 0.44704)) * 1000;
      expect(computeStats(track(msAt(120))).durationMs).toBeDefined();
      expect(computeStats(track(msAt(130))).durationMs).toBeUndefined();
    });
    it('still reports the start date when time is dropped', () => {
      expect(computeStats(track(60e3)).startTime).toBe(0);
    });
  });
  it('formats', () => {
    expect(formatMiles(22851.6)).toBe('14.2 mi');
    expect(formatFeet(1036)).toBe('3,399 ft');
  });
  it('fitBBox centers inside the frame', () => {
    const b = bbox([{ lat: 46, lon: -121.1 }, { lat: 46.1, lon: -121 }]);
    const fit = fitBBox(b, { x: 10, y: 10, w: 100, h: 200 });
    const [x, y] = fit.toMm(46.05, -121.05);
    expect(x).toBeGreaterThan(10);
    expect(x).toBeLessThan(110);
    expect(y).toBeGreaterThan(10);
    expect(y).toBeLessThan(210);
    const [, yTop] = fit.toMm(46.1, -121.05);
    const [, yBot] = fit.toMm(46, -121.05);
    expect(yTop).toBeLessThan(yBot);
  });
});
