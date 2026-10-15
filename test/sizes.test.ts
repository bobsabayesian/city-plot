import { describe, expect, it } from 'vitest';
import { CUSTOM_SIZE_ID, CUSTOM_SIZE_MAX_MM, CUSTOM_SIZE_MIN_MM, defaultProject, posterMm, PRINT_SIZES, type Project } from '../src/scene/project';
import { buildScene, composeScene } from '../src/scene/buildScene';
import { pngSize } from '../src/export/png';
import { sampleTrack } from '../src/sample';

const size = (id: string) => PRINT_SIZES.find((s) => s.id === id)!;
const withSize = (sizeId: string, extra: Partial<Project> = {}): Project => ({ ...defaultProject(), points: sampleTrack(), sizeId, ...extra });

describe('the list of print sizes', () => {
  it('has plenty of choices across US, ISO and metric', () => {
    expect(PRINT_SIZES.length).toBeGreaterThanOrEqual(25);
    for (const g of ['US (inches)', 'ISO (A series)', 'Metric (cm)']) expect(PRINT_SIZES.filter((s) => s.group === g).length).toBeGreaterThanOrEqual(5);
  });
  it('every size has a unique id and a label, and is stored portrait', () => {
    expect(new Set(PRINT_SIZES.map((s) => s.id)).size).toBe(PRINT_SIZES.length);
    for (const s of PRINT_SIZES) {
      expect(s.label.length).toBeGreaterThan(2);
      expect(s.wMm).toBeLessThan(s.hMm);
      expect(s.wMm).toBeGreaterThanOrEqual(CUSTOM_SIZE_MIN_MM);
      expect(s.hMm).toBeLessThanOrEqual(CUSTOM_SIZE_MAX_MM);
    }
  });
  it('keeps the sizes that were there before, under the same ids', () => {
    for (const id of ['12x16', '16x20', '18x24', '24x36', 'a3', 'a2']) expect(size(id)).toBeDefined();
    expect(posterMm(defaultProject())).toEqual({ w: 457.2, h: 609.6 });
  });
  it('the common poster sizes are there', () => {
    for (const id of ['8x10', '11x14', '11x17', '12x18', '16x24', '20x30', '24x30', '27x40', '30x40', '36x48', 'a4', 'a1', 'a0', 'cm50x70', 'cm60x90', 'cm70x100']) expect(size(id), id).toBeDefined();
  });
  it('US sizes convert inches exactly', () => {
    expect(posterMm(withSize('24x36'))).toEqual({ w: 609.6, h: 914.4 });
    expect(posterMm(withSize('36x48')).w).toBeCloseTo(914.4, 6);
  });
  it('ISO sizes are exact and keep the 1:1.414 ratio', () => {
    expect(posterMm(withSize('a4'))).toEqual({ w: 210, h: 297 });
    expect(posterMm(withSize('a0'))).toEqual({ w: 841, h: 1189 });
    for (const n of [5, 4, 3, 2, 1, 0]) {
      const s = size(`a${n}`);
      expect(s.hMm / s.wMm).toBeGreaterThan(Math.SQRT2 * 0.995);
      expect(s.hMm / s.wMm).toBeLessThan(Math.SQRT2 * 1.005);
    }
    // each A size is half the one above it
    expect(size('a3').wMm).toBe(size('a4').hMm);
  });
  it('metric sizes are exact', () => {
    expect(posterMm(withSize('cm50x70'))).toEqual({ w: 500, h: 700 });
    expect(posterMm(withSize('cm70x100'))).toEqual({ w: 700, h: 1000 });
  });
  it('landscape swaps width and height for every size', () => {
    for (const s of PRINT_SIZES) {
      const portrait = posterMm(withSize(s.id));
      const landscape = posterMm(withSize(s.id, { landscape: true }));
      expect(landscape).toEqual({ w: portrait.h, h: portrait.w });
    }
  });
  it('an unknown id falls back to 18 x 24, not to the first size in the list', () => {
    expect(posterMm(withSize('nonsense'))).toEqual({ w: 457.2, h: 609.6 });
  });
});

describe('custom size', () => {
  const custom = (wMm: number, hMm: number, landscape = false) => posterMm(withSize(CUSTOM_SIZE_ID, { customSize: { wMm, hMm }, landscape }));
  it('uses the width and height typed in', () => {
    expect(custom(300, 450)).toEqual({ w: 300, h: 450 });
  });
  it('can be turned to landscape', () => {
    expect(custom(300, 450, true)).toEqual({ w: 450, h: 300 });
  });
  it('is kept between the minimum and maximum', () => {
    expect(custom(5, 8)).toEqual({ w: CUSTOM_SIZE_MIN_MM, h: CUSTOM_SIZE_MIN_MM });
    expect(custom(9000, 12000)).toEqual({ w: CUSTOM_SIZE_MAX_MM, h: CUSTOM_SIZE_MAX_MM });
    expect(custom(NaN, Infinity).w).toBe(CUSTOM_SIZE_MIN_MM);
  });
  it('starts at the default 18 x 24', () => {
    expect(defaultProject().customSize).toEqual({ wMm: 457.2, hMm: 609.6 });
    expect(posterMm({ sizeId: CUSTOM_SIZE_ID, landscape: false })).toEqual({ w: 457.2, h: 609.6 });
  });
  it('does not change a preset size', () => {
    expect(posterMm(withSize('12x16', { customSize: { wMm: 100, hMm: 100 } }))).toEqual({ w: 304.8, h: 406.4 });
  });
});

describe('the poster follows the size', () => {
  it('the scene is the size chosen, for presets and custom', () => {
    for (const id of ['8x10', 'a4', 'cm60x90', '36x48']) {
      const sc = buildScene(withSize(id));
      const want = posterMm(withSize(id));
      expect(sc.widthMm).toBeCloseTo(want.w, 6);
      expect(sc.heightMm).toBeCloseTo(want.h, 6);
    }
    const c = buildScene(withSize(CUSTOM_SIZE_ID, { customSize: { wMm: 250, hMm: 350 }, landscape: true }));
    expect([c.widthMm, c.heightMm]).toEqual([350, 250]);
  });
  it('the map frame fills a small and a large page alike, within the margins', () => {
    for (const id of ['5x7', 'a5', '36x48', 'a0']) {
      const p = withSize(id);
      const { w, h } = posterMm(p);
      const f = composeScene(p).view!.frame;
      expect(f.x).toBeGreaterThanOrEqual(0);
      expect(f.x + f.w).toBeLessThanOrEqual(w + 1e-6);
      expect(f.y + f.h).toBeLessThanOrEqual(h + 1e-6);
      expect(f.w).toBeGreaterThan(0);
      expect(f.h).toBeGreaterThan(0);
    }
  });
  it('a small page still keeps its content (margins are clamped, not allowed to swallow the page)', () => {
    const p = withSize('5x7'); // 127 x 178 mm with 31.75 mm margins
    const f = composeScene(p).view!.frame;
    expect(f.w).toBeGreaterThanOrEqual(127 * 0.2);
  });
  it('large pages produce a PNG at a reduced dpi, small ones at the full dpi', () => {
    const a0 = posterMm(withSize('a0'));
    const big = pngSize(a0.w, a0.h, 300);
    expect(big.capped).toBe(true);
    expect(Math.max(big.width, big.height)).toBeLessThanOrEqual(12000);
    const small = posterMm(withSize('8x10'));
    expect(pngSize(small.w, small.h, 300)).toMatchObject({ width: 2400, height: 3000, capped: false });
  });
});
