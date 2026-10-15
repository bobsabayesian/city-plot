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
