import { describe, expect, it } from 'vitest';
import { buildScene, composeScene, parseLatLon, regionBBox, viewOf, WATERMARK_TEXT } from '../src/scene/buildScene';
import { sceneToSvg } from '../src/export/svg';
import { defaultProject, posterMm } from '../src/scene/project';
import { pngSize, MAX_SIDE_PX } from '../src/export/png';
import { cityData, cityProject, SEATTLE } from './fixture';

const texts = (p = cityProject(), data = cityData()) => buildScene(p, data).prims.flatMap((x) => (x.kind === 'text' ? [x.text] : []));

describe('scene', () => {
  it('poster size follows print size and orientation', () => {
    const p = defaultProject();
    expect(posterMm(p).w).toBeCloseTo(457.2);
    expect(posterMm({ ...p, landscape: true }).w).toBeCloseTo(609.6);
  });
  it('watermark on by default, gone when unchecked', () => {
    expect(texts()).toContain(WATERMARK_TEXT);
    expect(texts({ ...cityProject(), showWatermark: false })).not.toContain(WATERMARK_TEXT);
  });
  it('the attribution credits OpenStreetMap', () => {
    expect(WATERMARK_TEXT).toContain('OpenStreetMap');
  });
  it('builds a text-only scene before anything is searched', () => {
    expect(() => buildScene(defaultProject())).not.toThrow();
    expect(viewOf(defaultProject())).toBeUndefined();
  });
  it('the title is the place name, and can be overridden', () => {
    const p = cityProject();
    expect(texts(p)).toContain('SEATTLE');
    p.text.title.value = 'Emerald City';
    expect(texts(p)).toContain('EMERALD CITY');
  });
  it('shows the region name and coordinates, hidden on request', () => {
    const p = cityProject();
    expect(texts(p)).toContain('King County, Washington');
    expect(texts(p).some((t) => t.includes('° N'))).toBe(true);
    p.text.location.visible = false;
    expect(texts(p)).not.toContain('King County, Washington');
  });
  it('title placement moves it to the top', () => {
    const p = cityProject();
    const y = (q: typeof p) => {
      const t = buildScene(q).prims.find((x) => x.kind === 'text' && x.text === 'SEATTLE');
      return t && t.kind === 'text' ? t.y : NaN;
    };
    const bottomY = y(p);
    p.text.title.placement = 'top';
    expect(y(p)).toBeLessThan(bottomY);
  });
  it('the area and scale come from the region and the page', () => {
    const p = cityProject();
    const t = texts(p).join('|');
    expect(t).toMatch(/\d(\.\d+)? mi × \d(\.\d+)? mi/);
    expect(t).toMatch(/1:[\d,]+/);
    p.units = 'metric';
    expect(texts(p).join('|')).toMatch(/km × .* km/);
  });
  it('info values can be overridden, and hidden', () => {
    const p = cityProject();
    p.text.info.items.find((i) => i.key === 'scale')!.value = '1:12,345';
    p.text.info.items.find((i) => i.key === 'extent')!.visible = false;
    const s = texts(p).join('|');
    expect(s).toContain('1:12,345');
    expect(s).not.toMatch(/mi ×/);
  });
  it('draws the map layers it has data for, and nothing for layers switched off', () => {
    const p = cityProject();
    const count = (q = p) => buildScene(q, cityData()).prims.filter((x) => x.kind === 'path').length;
    const all = count();
    expect(all).toBeGreaterThan(4);
    p.layers.buildings.enabled = false;
    expect(count()).toBeLessThan(all);
  });
  it('layers are split by color and stroke width; identical ones merge', () => {
    const p = cityProject((q) => { q.features.enabled = false; q.text.title.visible = false; q.text.location.visible = false; q.text.info.visible = false; q.showWatermark = false; });
    const layers = (q = p) => sceneToSvg(buildScene(q, cityData())).match(/inkscape:groupmode="layer"/g)?.length ?? 0;
    // parks (green line + fill), water (blue line + fill), black lines at 0.3 / 0.54 / 0.78 mm
    expect(layers()).toBe(7);
    const q = structuredClone(p);
    q.layers.major.weightMm = 0.54; // the same black, the same width as the secondary streets: they merge
    expect(layers(q)).toBe(6);
    q.layers.parks.fill = 'off';
    expect(layers(q)).toBe(5);
    expect(sceneToSvg(buildScene(q, cityData()))).not.toContain('id="paper"');
    expect(sceneToSvg(buildScene(q, cityData()), { paper: true })).toContain('id="paper"');
  });
});

describe('the region', () => {
  it('is centered on the region, and as wide as asked for on the ground', () => {
    const p = cityProject();
    const v = viewOf(p)!;
    expect(v.widthKm).toBeCloseTo(2.5, 2);
    const [lat, lon] = v.fit.fromMm(v.frame.x + v.frame.w / 2, v.frame.y + v.frame.h / 2);
    expect(lat).toBeCloseTo(SEATTLE.lat, 4);
    expect(lon).toBeCloseTo(SEATTLE.lon, 4);
  });
  it('the box has the shape of the frame, and 1 degree of longitude is shorter away from the equator', () => {
    const wide = regionBBox({ lat: 60, lon: 10, widthKm: 10 }, 1);
    const eq = regionBBox({ lat: 0, lon: 10, widthKm: 10 }, 1);
    expect(wide.maxLon - wide.minLon).toBeGreaterThan(2 * (eq.maxLon - eq.minLon) * 0.99);
    expect(wide.maxLat - wide.minLat).toBeCloseTo((wide.maxLon - wide.minLon) * Math.cos((60 * Math.PI) / 180), 1);
  });
  it('a wider region shows more ground and a smaller scale', () => {
    const p = cityProject();
    const narrow = viewOf(p)!;
    p.region!.widthKm = 12;
    const wide = viewOf(p)!;
    expect(wide.widthKm).toBeCloseTo(12, 1);
    expect(wide.scale).toBeGreaterThan(narrow.scale * 3.9);
  });
  it('a taller page shows more north to south for the same width', () => {
    const p = cityProject();
    const portrait = viewOf(p)!;
    p.landscape = true;
    const landscape = viewOf(p)!;
    expect(portrait.heightKm / portrait.widthKm).toBeGreaterThan(landscape.heightKm / landscape.widthKm);
  });
  it('layers too wide for the view are skipped, narrower ones still drawn', () => {
    const p = cityProject();
    const withBuildings = composeScene(p, cityData()).scene.prims.length;
    p.region!.widthKm = 9; // buildings are only drawn up to 4 km across
    const wide = composeScene(p, cityData()).scene.prims.length;
    expect(wide).toBeLessThan(withBuildings);
  });
  it('parses latitude, longitude text', () => {
    expect(parseLatLon('47.62, -122.35')).toEqual({ lat: 47.62, lon: -122.35 });
    expect(parseLatLon(' 47.62 -122.35 ')).toEqual({ lat: 47.62, lon: -122.35 });
    expect(parseLatLon('-33.86;151.2')).toEqual({ lat: -33.86, lon: 151.2 });
    expect(parseLatLon('Seattle, WA')).toBeUndefined();
    expect(parseLatLon('123 Main St')).toBeUndefined();
    expect(parseLatLon('95, 10')).toBeUndefined();
  });
});

describe('png sizing', () => {
  it('matches print size x dpi when it fits', () => {
    expect(pngSize(457.2, 609.6, 150)).toEqual({ width: 2700, height: 3600, dpi: 150, capped: false });
  });
  it('24x36 at 300 dpi fits as-is', () => {
    expect(pngSize(609.6, 914.4, 300)).toMatchObject({ width: 7200, height: 10800, capped: false });
  });
  it('scales down oversized exports (24x36 at 600 dpi)', () => {
    const s = pngSize(609.6, 914.4, 600);
    expect(s.capped).toBe(true);
    expect(Math.max(s.width, s.height)).toBeLessThanOrEqual(MAX_SIDE_PX);
    expect(s.width * s.height).toBeLessThanOrEqual(100_000_000);
    expect(s.width / s.height).toBeCloseTo(2 / 3, 2);
  });
});

describe('rotating the map', () => {
  const turned = (deg: number) => cityProject((p) => { p.region!.rotationDeg = deg; });
  const centerOf = (p: ReturnType<typeof cityProject>) => { const v = viewOf(p)!; return v.fit.toMm(p.region!.lat, p.region!.lon).map((x) => +x.toFixed(3)); };

  it('turns about the middle of the frame: the region center stays put', () => {
    const v = viewOf(turned(0))!;
    const mid = [v.frame.x + v.frame.w / 2, v.frame.y + v.frame.h / 2].map((x) => +x.toFixed(3));
    for (const deg of [0, 30, 90, -45, 180]) expect(centerOf(turned(deg))).toEqual(mid);
  });
  it('a quarter turn clockwise puts north on the right: a point north of center lands right of it', () => {
    const p = turned(90);
    const v = viewOf(p)!;
    const [cx, cy] = v.fit.toMm(p.region!.lat, p.region!.lon);
    const [nx, ny] = v.fit.toMm(p.region!.lat + 0.005, p.region!.lon);
    expect(nx).toBeGreaterThan(cx + 1);
    expect(ny).toBeCloseTo(cy, 3);
    const [ex, ey] = v.fit.toMm(p.region!.lat, p.region!.lon + 0.005); // and east lands below
    expect(ey).toBeGreaterThan(cy + 1);
    expect(ex).toBeCloseTo(cx, 3);
  });
  it('fromMm undoes toMm when turned', () => {
    const v = viewOf(turned(37))!;
    const [x, y] = v.fit.toMm(47.61, -122.33);
    const [la, lo] = v.fit.fromMm(x, y);
    expect(la).toBeCloseTo(47.61, 6);
    expect(lo).toBeCloseTo(-122.33, 6);
  });
  it('the data needed is the box around the tilted view, so it grows with the turn and covers the frame corners', () => {
    const flat = viewOf(turned(0))!.bbox;
    const diag = viewOf(turned(45))!.bbox;
    expect(diag.maxLat - diag.minLat).toBeGreaterThan(flat.maxLat - flat.minLat);
    expect(diag.maxLon - diag.minLon).toBeGreaterThan(flat.maxLon - flat.minLon);
    const v = viewOf(turned(45))!;
    for (const [x, y] of [[v.frame.x, v.frame.y], [v.frame.x + v.frame.w, v.frame.y + v.frame.h]] as [number, number][]) {
      const [la, lo] = v.fit.fromMm(x, y);
      expect(la).toBeGreaterThanOrEqual(diag.minLat - 1e-9);
      expect(la).toBeLessThanOrEqual(diag.maxLat + 1e-9);
      expect(lo).toBeGreaterThanOrEqual(diag.minLon - 1e-9);
      expect(lo).toBeLessThanOrEqual(diag.maxLon + 1e-9);
    }
  });
  it('the ground size and scale do not change when the map is turned', () => {
    const [a, b] = [viewOf(turned(0))!, viewOf(turned(60))!];
    expect(b.widthKm).toBeCloseTo(a.widthKm, 6);
    expect(b.scale).toBe(a.scale);
  });
  it('map lines are still clipped to the frame', () => {
    const p = turned(30);
    const f = viewOf(p)!.frame;
    let checked = 0;
    for (const x of composeScene(p, cityData()).scene.prims) {
      if (x.kind !== 'path' || x.mode !== 'stroke' || x.d.includes('a')) continue; // map lines only: markers use relative arcs
      const n = (x.d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
      for (let i = 0; i + 1 < n.length; i += 2) {
        if (n[i]! < f.x - 0.01 || n[i]! > f.x + f.w + 0.01 || n[i + 1]! < f.y - 0.01 || n[i + 1]! > f.y + f.h + 0.01) throw new Error(`${x.d.slice(0, 40)} -> ${n[i]},${n[i + 1]}`);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });
  it('the north arrow turns with the map, and letters stay upright', () => {
    const north = (deg: number) => {
      const p = cityProject((q) => { q.north.enabled = true; q.north.style = 'compass'; q.region!.rotationDeg = deg; });
      return composeScene(p).scene.prims;
    };
    const label = (ps: ReturnType<typeof north>, t: string) => ps.find((x) => x.kind === 'text' && x.text === t) as { x: number; y: number; rotate?: number };
    const [up, right] = [north(0), north(90)];
    expect(label(up, 'N').rotate).toBeUndefined();
    expect(label(right, 'N').rotate).toBeUndefined(); // upright
    const [n0, n1, s1] = [label(up, 'N'), label(right, 'N'), label(right, 'S')];
    const cx = (label(up, 'E').x + label(up, 'W').x) / 2;
    expect(n0.x).toBeCloseTo(cx, 1); // straight up
    expect(n1.x).toBeGreaterThan(cx + 3); // a quarter turn clockwise: N is on the right
    expect(s1.x).toBeLessThan(cx - 3);
  });
  it('north stays up when the map is not turned: no rotation key is needed', () => {
    const p = cityProject((q) => { q.north.enabled = true; });
    expect(p.region!.rotationDeg).toBeUndefined();
    expect(() => buildScene(p)).not.toThrow();
  });
});
