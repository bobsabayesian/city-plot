import { cleanTrack } from '../gpx/clean';
import { bbox, fitBBox, haversine, type BBox, type Fit } from '../geo/project';
import type { Rect } from '../geo/clip';
import {
  computeStats, metersToFeet, formatCoords, formatDuration, formatFeet, formatKm, formatMeters, formatMiles,
  type TrackStats,
} from '../geo/stats';
import { contourInterval, contourPaths } from '../topo/contours';
import type { TerrainField } from '../topo/terrain';
import { landmarkPrims, waterPrims } from '../features/draw';
import type { LandmarkEntry, LandmarkPlacement } from '../features/select';
import { penKeyOf, type OsmData } from '../features/types';
import type { XY } from '../geo/clip';
import { northBox, northPrims } from './north';
import { borderPrims, layoutBorder } from './border';
import { featurePenId, penFor } from './pens';
import { formatLevel, pathsWithGaps, placeContourLabels } from '../topo/contourLabels';
import type { Box } from '../features/select';
import type { Prim, Scene } from './types';
import { clampMargins, posterMm, type InfoItem, type Placement, type Project, type StrokeStyle } from './project';

const PT = 25.4 / 72;
/** Poster title when there is no name to use (no GPX peak name and no searched feature). */
export const DEFAULT_TITLE = 'Walk of Frame';
export const WATERMARK_TEXT = 'Generated with hike.bobsabayesian.io · free for non-commercial use';
export const FONTS = {
  sans: 'Inter, "Helvetica Neue", Helvetica, Arial, sans-serif',
  serif: '"Source Serif 4", Georgia, "Times New Roman", serif',
};
/** Minimum map extent (degrees) so a point-like feature (a single peak) still gets a useful view. */
export const MIN_SPAN_DEG = 0.06;

const f = (n: number) => +n.toFixed(3);
const circle = (cx: number, cy: number, r: number) =>
  `M${f(cx - r)} ${f(cy)}a${f(r)} ${f(r)} 0 1 0 ${f(2 * r)} 0a${f(r)} ${f(r)} 0 1 0 ${f(-2 * r)} 0Z`;

/** Round-number tick values within [lo, hi], aiming for about `target` ticks. */
export function niceTicks(lo: number, hi: number, target: number): number[] {
  const span = hi - lo;
  if (!(span > 0)) return [];
  const raw = span / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 5, 10].find((k) => k * mag >= raw) ?? 10) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}
const polyline = (xy: [number, number][]) => xy.map(([x, y], i) => `${i ? 'L' : 'M'}${f(x)} ${f(y)}`).join('');

function dashFor(style: StrokeStyle, w: number): { dash?: number[]; round?: boolean } {
  if (style === 'dashed') return { dash: [w * 5, w * 3] };
  if (style === 'dotted') return { dash: [0, w * 2.5], round: true };
  return {};
}

export function autoDate(t?: number): string {
  return t === undefined
    ? ''
    : new Date(t).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

/** The area a typed feature is shown at: `spanKm` square if set, else the feature's own extent (at least ~6 km). */
export function featureView(f: NonNullable<Project['feature']>): BBox {
  if (f.spanKm === undefined) return expandMin(f.bbox);
  const lat = (f.bbox.minLat + f.bbox.maxLat) / 2;
  const lon = (f.bbox.minLon + f.bbox.maxLon) / 2;
  const dLat = f.spanKm / 110.57 / 2;
  const dLon = f.spanKm / (111.32 * Math.max(Math.cos((lat * Math.PI) / 180), 0.05)) / 2;
  return { minLat: lat - dLat, maxLat: lat + dLat, minLon: lon - dLon, maxLon: lon + dLon };
}

/** Rough size of a view in km (width, height). */
export function viewSizeKm(b: BBox): [number, number] {
  const lat = (b.minLat + b.maxLat) / 2;
  return [(b.maxLon - b.minLon) * 111.32 * Math.cos((lat * Math.PI) / 180), (b.maxLat - b.minLat) * 110.57];
}

export function expandMin(b: BBox, minSpan = MIN_SPAN_DEG): BBox {
  const out = { ...b };
  if (b.maxLat - b.minLat < minSpan) {
    const c = (b.maxLat + b.minLat) / 2;
    out.minLat = c - minSpan / 2;
    out.maxLat = c + minSpan / 2;
  }
  if (b.maxLon - b.minLon < minSpan) {
    const c = (b.maxLon + b.minLon) / 2;
    out.minLon = c - minSpan / 2;
    out.maxLon = c + minSpan / 2;
  }
  return out;
}

/** Values the text blocks auto-fill with. Empty string = nothing to show. */
export function autoValues(p: Project, stats?: TrackStats, contourM?: number) {
  const imperial = p.units === 'imperial';
  const dist = (m: number) => (imperial ? formatMiles(m) : formatKm(m));
  const ele = (m: number) => (imperial ? formatFeet(m) : formatMeters(m));
  const center = stats?.peak ?? (p.points.length ? p.points[0] : undefined);
  const coordPt = center ?? (p.feature ? { lat: p.feature.lat, lon: p.feature.lon } : undefined);
  return {
    title: p.lookup.peakName ?? p.feature?.name ?? DEFAULT_TITLE,
    location: p.lookup.location ?? '',
    coords: coordPt ? formatCoords(coordPt.lat, coordPt.lon) : '',
    info: {
      distance: stats ? dist(stats.distanceM) : '',
      gain: stats ? ele(stats.gainM) : '',
      maxEle: stats?.maxEleM !== undefined ? ele(stats.maxEleM) : '',
      duration: stats?.durationMs !== undefined ? formatDuration(stats.durationMs) : '',
      date: autoDate(stats?.startTime),
      contour: contourM ? (imperial ? `${contourM} m (${Math.round(metersToFeet(contourM))} ft)` : `${contourM} m`) : '',
    } as Record<InfoItem['key'], string>,
  };
}

interface Block { height: number; gapAfter: number; draw: (yTop: number) => Prim[] }

export interface View { frame: Rect; fit: Fit; bbox: BBox }
export interface Composed { scene: Scene; view?: View; landmarks?: LandmarkEntry[]; pool?: LandmarkPlacement['pool']; open?: LandmarkPlacement['open'] }

function compose(p: Project, terrain?: TerrainField, layoutOnly = false, osm?: OsmData): Composed {
  const { w: W, h: H } = posterMm(p);
  const prims: Prim[] = [];
  const mg = clampMargins(p.page.margins, W, H); // explicit page margins, paper edge to content
  const minMargin = Math.min(mg.top, mg.right, mg.bottom, mg.left);
  const t = p.text;
  const colorOf = (penId: string) => penFor(p.pens, penId).color;
  // the border goes first so it is drawn under everything else
  if (!layoutOnly) prims.push(...borderPrims(W, H, p.border, mg, colorOf(p.border.pen)));
  const fontFamily = FONTS[t.font];
  const anchor = t.align === 'left' ? 'start' : t.align === 'right' ? 'end' : 'middle';
  const contentL = mg.left;
  const contentR = W - mg.right;
  const tx = t.align === 'left' ? contentL : t.align === 'right' ? contentR : (contentL + contentR) / 2;
  const innerW = contentR - contentL;
  const stats = p.points.length ? computeStats(p.points) : undefined;
  const interval = p.terrain.enabled && terrain ? contourInterval(p.terrain.intervalM, terrain) : undefined;
  const auto = autoValues(p, stats, interval);
  const text = (penId: string, s: string, y: number, sizeMm: number, extra: Partial<Extract<Prim, { kind: 'text' }>> = {}, x = tx): Prim => ({
    kind: 'text', text: s, x, y, anchor, sizeMm, trackingMm: sizeMm * t.trackingEm, fontFamily, fontKey: t.font, color: colorOf(penId), pen: penId, ...extra,
  });

  // ---- text blocks (height + draw), stacked from the top and bottom margins
  const blocks: Record<Placement, Block[]> = { top: [], bottom: [] };

  const title = (t.title.value ?? auto.title).trim();
  if (t.title.visible && title) {
    const ts = t.title;
    const size = ts.sizePt * PT;
    const align = ts.align === 'inherit' ? t.align : ts.align;
    const justify = align === 'justify';
    const where = {
      anchor: (justify || align === 'left' ? 'start' : align === 'right' ? 'end' : 'middle') as 'start' | 'middle' | 'end',
      x: justify || align === 'left' ? contentL : align === 'right' ? contentR : (contentL + contentR) / 2,
      ...(justify ? { fitWidthMm: innerW } : {}),
    };
    const { x: titleX, ...place } = where;
    blocks[ts.placement].push({
      height: size * 0.75, gapAfter: size * 0.4,
      draw: (y) => {
        const base = y + size * 0.72;
        const outline = { ...place, mode: 'stroke' as const, strokeMm: ts.outlineMm };
        if (ts.style === 'outline') return [text(ts.pen, title.toUpperCase(), base, size, outline, titleX)];
        // inside first, so the outline sits on top of it
        if (ts.style === 'outlineFill') return [
          text(ts.fillPen, title.toUpperCase(), base, size, { ...place, hatch: ts.fillDensity }, titleX),
          text(ts.pen, title.toUpperCase(), base, size, outline, titleX),
        ];
        return [text(ts.pen, title.toUpperCase(), base, size, place, titleX)];
      },
    });
  }

  const loc = (t.location.value ?? auto.location).trim();
  const coords = t.location.showCoords ? auto.coords : '';
  if (t.location.visible && (loc || coords)) {
    const size = t.location.sizePt * PT;
    const small = size * 0.75;
    blocks[t.location.placement].push({
      height: (loc ? size * 0.75 : 0) + (loc && coords ? size * 0.5 : 0) + (coords ? small * 0.75 : 0),
      gapAfter: size * 0.8,
      draw: (y) => {
        const out: Prim[] = [];
        let cy = y;
        if (loc) { out.push(text(t.location.pen, loc, cy + size * 0.72, size)); cy += size * 1.25; }
        if (coords) out.push(text(t.location.pen, coords, cy + small * 0.72, small, { opacity: 0.7 }));
        return out;
      },
    });
  }

  const items = t.info.items
    .filter((i) => i.visible)
    .map((i) => ({ label: i.label, value: (i.value ?? auto.info[i.key]).trim() }))
    .filter((i) => i.value);
  if (t.info.visible && items.length) {
    const size = t.info.sizePt * PT;
    const ls = size * 0.45;
    const cell = ls * 1.5 + size * 0.75;
    const column = t.info.layout === 'column';
    const colGap = size * 0.6;
    const cellDraw = (it: (typeof items)[number], y: number, x: number): Prim[] => [
      text(t.info.pen, it.label.toUpperCase(), y + ls * 0.72, ls, { opacity: 0.65 }, x),
      text(t.info.pen, it.value, y + ls * 1.5 + size * 0.72, size, { trackingMm: size * t.trackingEm * 0.6 }, x),
    ];
    blocks[t.info.placement].push({
      height: column ? items.length * cell + (items.length - 1) * colGap : cell,
      gapAfter: size * 0.6,
      draw: (y) => {
        if (column) return items.flatMap((it, i) => cellDraw(it, y + i * (cell + colGap), tx));
        const cw = innerW / items.length;
        return items.flatMap((it, i) => {
          const x = t.align === 'left' ? contentL + i * cw : t.align === 'right' ? contentL + (i + 1) * cw : contentL + (i + 0.5) * cw;
          return cellDraw(it, y, x);
        });
      },
    });
  }

  let topCursor = mg.top;
  if (!layoutOnly) for (const b of blocks.top) { prims.push(...b.draw(topCursor)); topCursor += b.height + b.gapAfter; }
  else for (const b of blocks.top) topCursor += b.height + b.gapAfter;

  let bottomCursor = H - mg.bottom;
  if (p.showWatermark) {
    const size = 7 * PT;
    if (!layoutOnly) prims.push(text(p.watermarkPen, WATERMARK_TEXT, bottomCursor, size, { trackingMm: size * 0.04, opacity: 0.55 }));
    bottomCursor -= size * 2.4;
  }
  for (const b of [...blocks.bottom].reverse()) {
    bottomCursor -= b.height;
    if (!layoutOnly) prims.push(...b.draw(bottomCursor));
    bottomCursor -= b.gapAfter;
  }

  // ---- map
  const gap = Math.max(6, minMargin * 0.4);
  const hasMap = p.points.length >= 2 || !!p.feature;
  let view: View | undefined;
  let landmarks: LandmarkEntry[] | undefined;
  let pool: LandmarkPlacement['pool'] | undefined;
  let open: LandmarkPlacement['open'] | undefined;
  if (hasMap) {
    const profileH = p.profile.enabled && p.profile.position === 'bottom' && p.points.length ? H * 0.09 : 0;
    // distance tick labels hang below the profile, so reserve room for them
    const tickPad = p.profile.enabled && p.profile.labels.xTicks && p.points.length ? p.profile.labels.sizePt * PT * 2.4 : 0;
    const frame: Rect = { x: contentL, y: topCursor, w: innerW, h: bottomCursor - topCursor - (profileH ? profileH + gap : 0) - tickPad };
    const focus: BBox = p.points.length >= 2 ? bbox(p.points) : featureView(p.feature!);
    const fit = fitBBox(focus, frame);
    const [la1, lo1] = fit.fromMm(frame.x, frame.y + frame.h);
    const [la2, lo2] = fit.fromMm(frame.x + frame.w, frame.y);
    view = { frame, fit, bbox: { minLat: Math.min(la1, la2), maxLat: Math.max(la1, la2), minLon: Math.min(lo1, lo2), maxLon: Math.max(lo1, lo2) } };

    if (!layoutOnly) {
      // The route and the landmark labels are worked out first: contour numbers have to stay clear of both.
      // Labels may spill a little into the margin, but never onto or past the border.
      const innerBorder = p.border.enabled ? layoutBorder(W, H, p.border, mg).rects.at(-1)!.x + p.border.weightMm / 2 + 1.5 : 0;
      const withinBorder = (r: Rect): Rect => {
        const x0 = Math.max(r.x, innerBorder);
        const y0 = Math.max(r.y, innerBorder);
        return { x: x0, y: y0, w: Math.min(r.x + r.w, W - innerBorder) - x0, h: Math.min(r.y + r.h, H - innerBorder) - y0 };
      };
      const clean = p.points.length >= 2 ? cleanTrack(p.points, fit.metersPerMm * 0.1) : [];
      const routeXY: XY[] = clean.map((q) => fit.toMm(q.lat, q.lon));

      let landmarkOut: ReturnType<typeof landmarkPrims> | undefined;
      if (p.features.enabled) {
        const sizeMm = p.features.sizePt * PT;
        landmarkOut = landmarkPrims({
          landmarks: [...p.waypoints, ...(osm?.landmarks ?? [])],
          water: osm?.water ?? [],
          fit, frame, route: routeXY,
          labelBounds: withinBorder({ x: frame.x - mg.left * 0.5, y: frame.y - mg.top * 0.5, w: frame.w + (mg.left + mg.right) * 0.5, h: frame.h + mg.top * 0.5 }), settings: p.features, sizeMm,
          markerR: Math.min(W, H) * 0.0045,
          penFor: (kind) => penFor(p.pens, featurePenId(p.features, penKeyOf(kind))),
          fontFamily, fontKey: t.font, trackingMm: sizeMm * 0.05,
        });
      }

      if (p.terrain.enabled && terrain) {
        const paths = contourPaths(terrain, fit, frame, interval!, p.terrain.indexEvery);
        const tc = p.terrain;
        let { regular, index } = paths;
        let numbers: ReturnType<typeof placeContourLabels> = [];
        if (tc.labels.enabled && tc.indexEvery > 0) {
          const avoid: Box[] = [...(landmarkOut?.obstacles ?? [])];
          if (p.north.enabled) {
            const nb = northBox(frame, p.north.corner, p.north.sizeMm);
            avoid.push({ cx: nb.x + p.north.sizeMm / 2, cy: nb.y + p.north.sizeMm / 2, w: p.north.sizeMm, h: p.north.sizeMm, ang: 0 });
          }
          if (p.profile.enabled && p.profile.position === 'corner' && p.points.length)
            avoid.push({ cx: contentR - innerW * 0.2, cy: frame.y + frame.h - H * 0.04, w: innerW * 0.4, h: H * 0.08, ang: 0 });
          numbers = placeContourLabels(paths.pieces, {
            intervalM: interval!, indexEvery: tc.indexEvery, every: tc.labels.every, density: tc.labels.density, gap: tc.labels.gap,
            sizePt: tc.labels.sizePt, format: (lv) => formatLevel(lv, p.units), frame, obstacles: avoid, route: routeXY,
          });
          if (numbers.length && tc.labels.gap) ({ regular, index } = pathsWithGaps(paths.pieces, numbers, tc.labels.sizePt));
        }
        if (regular) prims.push({ kind: 'path', d: regular, color: colorOf(tc.pen), pen: tc.pen, mode: 'stroke', widthMm: tc.weightMm, opacity: tc.opacity });
        // heavy lines are drawn as two passes of the pen in the plotter export, so they stay heavier than the rest
        if (index) prims.push({ kind: 'path', d: index, color: colorOf(tc.pen), pen: tc.pen, mode: 'stroke', widthMm: tc.indexWeightMm, opacity: tc.opacity, minPasses: 2 });
        const nsize = tc.labels.sizePt * PT;
        for (const n of numbers) {
          // text sits centered on its line (gap) or just above it, always upright along the line
          const nx = Math.sin(n.angle);
          const ny = -Math.cos(n.angle);
          const lift = tc.labels.gap ? 0 : nsize * (1.15 / 2 + 0.2); // same offset the placement reserved
          prims.push({
            kind: 'text', text: n.text, x: n.x + nx * lift - nx * nsize * 0.36, y: n.y + ny * lift - ny * nsize * 0.36,
            anchor: 'middle', sizeMm: nsize, trackingMm: nsize * 0.04, fontFamily, fontKey: t.font, color: colorOf(tc.pen), pen: tc.pen,
            ...(n.angle ? { rotate: (n.angle * 180) / Math.PI } : {}),
          });
        }
      }

      if (p.features.enabled && p.features.water && osm) prims.push(...waterPrims(osm.water, fit, frame, p.features, penFor(p.pens, featurePenId(p.features, 'waterOutline'))));

      if (p.points.length >= 2) {
        const xy = routeXY;

        if (p.profile.enabled) {
          const corner = p.profile.position === 'corner';
          const pw = corner ? innerW * 0.4 : innerW;
          const ph = corner ? H * 0.08 : profileH;
          const px = corner ? contentR - pw : contentL;
          const py = corner ? frame.y + frame.h - ph : frame.y + frame.h + gap;
          const withEle = clean.filter((q) => q.ele !== undefined);
          if (withEle.length >= 2) {
            let d = 0;
            const series = withEle.map((q, i) => {
              if (i) d += haversine(withEle[i - 1]!.lat, withEle[i - 1]!.lon, q.lat, q.lon);
              return { d, e: q.ele! };
            });
            const eMin = Math.min(...series.map((s) => s.e));
            const eMax = Math.max(...series.map((s) => s.e));
            const span = Math.max(eMax - eMin, 1);
            const line = series.map((s): [number, number] => [px + (s.d / (d || 1)) * pw, py + ph - ((s.e - eMin) / span) * ph * 0.92 - ph * 0.04]);
            const topLine = polyline(line);
            prims.push({ kind: 'path', d: `${topLine}L${f(px + pw)} ${f(py + ph)}L${f(px)} ${f(py + ph)}Z`, color: colorOf(p.profile.pen), pen: p.profile.pen, mode: 'fill', opacity: p.profile.opacity, ...(p.profile.hatch !== 'off' ? { hatch: p.profile.hatch } : {}) });
            prims.push({ kind: 'path', d: topLine, color: colorOf(p.profile.pen), pen: p.profile.pen, mode: 'stroke', widthMm: 0.4 });

            const lb = p.profile.labels;
            if (lb.extremes || lb.yTicks || lb.xTicks) {
              const size = lb.sizePt * PT;
              const col = colorOf(p.profile.pen);
              const imperial = p.units === 'imperial';
              const yOf = (e: number) => py + ph - ((e - eMin) / span) * ph * 0.92 - ph * 0.04;
              const xOf = (dist: number) => px + (dist / (d || 1)) * pw;
              const txt = (s: string, x: number, y: number, anchor: 'start' | 'middle' | 'end', opacity?: number) =>
                prims.push({ kind: 'text', text: s, x, y, anchor, sizeMm: size, trackingMm: size * 0.04, fontFamily, fontKey: t.font, color: col, pen: p.profile.pen, opacity });
              const grid = (d: string, w: number, opacity?: number) =>
                prims.push({ kind: 'path', d, color: col, pen: p.profile.pen, mode: 'stroke', widthMm: w, opacity });

              if (lb.yTicks) {
                const toDisp = (m: number) => (imperial ? metersToFeet(m) : m);
                const fromDisp = (v: number) => (imperial ? v / 3.280839895 : v);
                const lines: string[] = [];
                for (const v of niceTicks(toDisp(eMin), toDisp(eMax), 4)) {
                  const y = yOf(fromDisp(v));
                  lines.push(`M${f(px)} ${f(y)}H${f(px + pw)}`);
                  txt(Math.round(v).toLocaleString('en-US'), px - size * 0.6, y + size * 0.35, 'end');
                }
                if (lines.length) grid(lines.join(''), 0.12, 0.45);
              }
              if (lb.xTicks) {
                const unitM = imperial ? 1609.344 : 1000;
                const unit = imperial ? 'mi' : 'km';
                const marks: string[] = [];
                for (const v of niceTicks(0, d / unitM, 5)) {
                  if (v <= 0) continue;
                  const x = xOf(v * unitM);
                  marks.push(`M${f(x)} ${f(py + ph)}v${f(size * 0.5)}`);
                  txt(`${v} ${unit}`, x, py + ph + size * 1.5, 'middle');
                }
                if (marks.length) grid(marks.join(''), 0.2);
              }
              if (lb.extremes) {
                const fmt = (m: number) => (imperial ? formatFeet(m) : formatMeters(m));
                const hi = series.reduce((a, b) => (b.e > a.e ? b : a));
                const lo = series.reduce((a, b) => (b.e < a.e ? b : a));
                const marks: string[] = [];
                for (const pt of hi === lo ? [hi] : [hi, lo]) {
                  const x = xOf(pt.d);
                  const y = yOf(pt.e);
                  marks.push(circle(x, y, size * 0.25));
                  const a = x < px + pw * 0.15 ? 'start' : x > px + pw * 0.85 ? 'end' : 'middle';
                  txt(fmt(pt.e), x, y - size * 0.8, a);
                }
                grid(marks.join(''), 0.3);
              }
            }
          }
        }

        prims.push({
          kind: 'path', d: polyline(xy), color: colorOf(p.route.pen), pen: p.route.pen, mode: 'stroke', widthMm: p.route.weightMm,
          ...dashFor(p.route.style, p.route.weightMm),
        });
      }

      if (p.north.enabled) {
        prims.push(...northPrims(frame, { ...p.north, color: colorOf(p.north.pen), fontFamily, fontKey: t.font }));
      }

      if (landmarkOut) {
        prims.push(...landmarkOut.prims);
        landmarks = landmarkOut.entries;
        pool = landmarkOut.pool;
        open = landmarkOut.open;
      }
    }
  }

  return { scene: { widthMm: W, heightMm: H, paper: p.paper, prims }, view, landmarks, pool, open };
}

export const composeScene = (p: Project, terrain?: TerrainField, osm?: OsmData): Composed => compose(p, terrain, false, osm);
export const buildScene = (p: Project, terrain?: TerrainField, osm?: OsmData): Scene => compose(p, terrain, false, osm).scene;

/** The geographic area the map frame shows; terrain must cover this. Cheap (no route/contour work). */
export const viewBBox = (p: Project): BBox | undefined => compose(p, undefined, true).view?.bbox;
