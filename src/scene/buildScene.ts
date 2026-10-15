import { fitBBox, inverseMercator, mercator, rotateFit, type BBox, type Fit } from '../geo/project';
import type { Rect } from '../geo/clip';
import { formatCoords, formatKm, formatMiles } from '../geo/format';
import { layerPrims, waterLines } from '../city/draw';
import { LAYER_KEYS, LAYER_MAX_KM, type LayerData, type LayerKey } from '../city/types';
import { landmarkPrims } from '../features/draw';
import type { LandmarkEntry, LandmarkPlacement } from '../features/select';
import { penKeyOf, type Landmark } from '../features/types';
import { northPrims } from './north';
import { borderExtent, borderPrims, layoutBorder } from './border';
import { featurePenId, penFor } from './pens';
import type { Prim, Scene } from './types';
import { clampMargins, posterMm, type InfoItem, type Placement, type Project, type Region } from './project';

const PT = 25.4 / 72;
/** Poster title when nothing has been searched for yet. */
export const DEFAULT_TITLE = 'City Plot';
export const WATERMARK_TEXT = 'Map data © OpenStreetMap contributors · generated with City Plot';
export const FONTS = {
  sans: 'Inter, "Helvetica Neue", Helvetica, Arial, sans-serif',
  serif: '"Source Serif 4", Georgia, "Times New Roman", serif',
};

/** What has been fetched for the current view: map layers, and landmarks from OpenStreetMap. */
export interface CityData {
  layers: Partial<Record<LayerKey, LayerData>>;
  landmarks: Landmark[];
}

/**
 * The area a region covers on a frame `aspect` (height / width) tall. `widthKm` is real ground distance, so
 * the Mercator width is stretched by 1 / cos(latitude).
 */
export function regionBBox(r: Region, aspect: number): BBox {
  const lat = Math.max(-80, Math.min(80, r.lat));
  const mw = (r.widthKm * 1000) / Math.cos((lat * Math.PI) / 180);
  const [cx, cy] = mercator(lat, r.lon);
  const [la0, lo0] = inverseMercator(cx - mw / 2, cy - (mw * aspect) / 2);
  const [la1, lo1] = inverseMercator(cx + mw / 2, cy + (mw * aspect) / 2);
  return { minLat: Math.min(la0, la1), maxLat: Math.max(la0, la1), minLon: Math.min(lo0, lo1), maxLon: Math.max(lo0, lo1) };
}

/** Parse "47.62, -122.35" (or "47.62 -122.35") into coordinates, if that is what it is. */
export function parseLatLon(text: string): { lat: number; lon: number } | undefined {
  const m = text.trim().match(/^(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return undefined;
  const [lat, lon] = [+m[1]!, +m[2]!];
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : undefined;
}

/** Values the text blocks auto-fill with. Empty string = nothing to show. */
export function autoValues(p: Project, view?: View) {
  const imperial = p.units === 'imperial';
  const dist = (km: number) => (imperial ? formatMiles(km * 1000) : formatKm(km * 1000));
  const c = p.region ?? p.place;
  return {
    title: p.place?.name ?? DEFAULT_TITLE,
    location: p.place?.location ?? '',
    coords: c ? formatCoords(c.lat, c.lon) : '',
    info: {
      extent: view ? `${dist(view.widthKm)} × ${dist(view.heightKm)}` : '',
      scale: view ? `1:${view.scale.toLocaleString('en-US')}` : '',
    } as Record<InfoItem['key'], string>,
  };
}

interface Block { height: number; gapAfter: number; draw: (yTop: number) => Prim[] }

export interface View {
  frame: Rect;
  fit: Fit;
  bbox: BBox;
  /** ground size of the frame, km */
  widthKm: number;
  heightKm: number;
  /** the map's scale as 1:scale, rounded */
  scale: number;
}
export interface Composed { scene: Scene; view?: View; landmarks?: LandmarkEntry[]; pool?: LandmarkPlacement['pool']; open?: LandmarkPlacement['open'] }

const roundScale = (s: number) => { const q = s >= 2000 ? 100 : 10; return Math.max(1, Math.round(s / q) * q); };

function compose(p: Project, layoutOnly = false, data?: CityData): Composed {
  const { w: W, h: H } = posterMm(p);
  const prims: Prim[] = [];
  // The page margin is measured from the inside of the border (from the paper edge when there is none).
  const reach = borderExtent(p.border);
  const pm = p.page.margins;
  const mg = clampMargins({ top: pm.top + reach, right: pm.right + reach, bottom: pm.bottom + reach, left: pm.left + reach }, W, H);
  const minMargin = Math.min(mg.top, mg.right, mg.bottom, mg.left);
  const t = p.text;
  const colorOf = (penId: string) => penFor(p.pens, penId).color;
  // the border goes first so it is drawn under everything else
  if (!layoutOnly) prims.push(...borderPrims(W, H, p.border, colorOf(p.border.pen)));
  const fontFamily = FONTS[t.font];
  const anchor = t.align === 'left' ? 'start' : t.align === 'right' ? 'end' : 'middle';
  const contentL = mg.left;
  const contentR = W - mg.right;
  const tx = t.align === 'left' ? contentL : t.align === 'right' ? contentR : (contentL + contentR) / 2;
  const innerW = contentR - contentL;
  const auto = autoValues(p);
  // scale and extent need the map frame, which needs the text blocks' heights: they are filled in once the frame is known
  let infoAuto = auto.info;
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
    .filter((i) => i.visible && (i.value?.trim() || p.region))
    .map((i) => ({ key: i.key, label: i.label, value: (i.value ?? '').trim() }));
  if (t.info.visible && items.length) {
    const size = t.info.sizePt * PT;
    const ls = size * 0.45;
    const cell = ls * 1.5 + size * 0.75;
    const column = t.info.layout === 'column';
    const colGap = size * 0.6;
    const cellDraw = (it: (typeof items)[number], y: number, x: number): Prim[] => [
      text(t.info.pen, it.label.toUpperCase(), y + ls * 0.72, ls, { opacity: 0.65 }, x),
      text(t.info.pen, it.value || infoAuto[it.key], y + ls * 1.5 + size * 0.72, size, { trackingMm: size * t.trackingEm * 0.6 }, x),
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

  // Stack the blocks from the top and bottom margins; they are drawn once the map frame is known.
  const queue: (() => Prim[])[] = [];
  let topCursor = mg.top;
  for (const b of blocks.top) { const y = topCursor; queue.push(() => b.draw(y)); topCursor += b.height + b.gapAfter; }

  let bottomCursor = H - mg.bottom;
  if (p.showWatermark) {
    const size = 7 * PT;
    const y = bottomCursor;
    queue.push(() => [text(p.watermarkPen, WATERMARK_TEXT, y, size, { trackingMm: size * 0.04, opacity: 0.55 })]);
    bottomCursor -= size * 2.4;
  }
  for (const b of [...blocks.bottom].reverse()) {
    bottomCursor -= b.height;
    const y = bottomCursor;
    queue.push(() => b.draw(y));
    bottomCursor -= b.gapAfter;
  }

  // ---- map
  let view: View | undefined;
  let landmarks: LandmarkEntry[] | undefined;
  let pool: LandmarkPlacement['pool'] | undefined;
  let open: LandmarkPlacement['open'] | undefined;
  if (p.region) {
    const frame: Rect = { x: contentL, y: topCursor, w: innerW, h: Math.max(bottomCursor - topCursor, 1) };
    const flat = fitBBox(regionBBox(p.region, frame.h / frame.w), frame);
    const fit = rotateFit(flat, frame, p.region.rotationDeg ?? 0);
    // the ground the frame shows; turned, that is a tilted rectangle, so data is needed for its bounding box
    const corners = [[frame.x, frame.y], [frame.x + frame.w, frame.y], [frame.x, frame.y + frame.h], [frame.x + frame.w, frame.y + frame.h]].map(([x, y]) => fit.fromMm(x!, y!));
    const bboxView: BBox = {
      minLat: Math.min(...corners.map((c) => c[0])), maxLat: Math.max(...corners.map((c) => c[0])),
      minLon: Math.min(...corners.map((c) => c[1])), maxLon: Math.max(...corners.map((c) => c[1])),
    };
    const groundPerMm = fit.metersPerMm * Math.cos((p.region.lat * Math.PI) / 180);
    view = {
      frame, fit, bbox: bboxView,
      widthKm: (frame.w * groundPerMm) / 1000, heightKm: (frame.h * groundPerMm) / 1000,
      scale: roundScale(groundPerMm * 1000),
    };
    infoAuto = autoValues(p, view).info;
  }
  if (!layoutOnly) for (const draw of queue) prims.push(...draw());

  if (view && !layoutOnly) {
    const { frame, fit } = view;
    const widest = Math.max(view.widthKm, view.heightKm);
    // Landmark labels may spill a little into the margin, but never onto or past the border.
    const innerBorder = p.border.enabled ? layoutBorder(W, H, p.border).rects.at(-1)!.x + p.border.weightMm / 2 + 1.5 : 0;
    const withinBorder = (r: Rect): Rect => {
      const x0 = Math.max(r.x, innerBorder);
      const y0 = Math.max(r.y, innerBorder);
      return { x: x0, y: y0, w: Math.min(r.x + r.w, W - innerBorder) - x0, h: Math.min(r.y + r.h, H - innerBorder) - y0 };
    };

    // the map layers, bottom first; a layer is skipped when the view is wider than it is made for
    for (const key of LAYER_KEYS) {
      const style = p.layers[key];
      const layer = data?.layers[key];
      if (!style.enabled || !layer || widest > LAYER_MAX_KM[key]) continue;
      prims.push(...layerPrims(key, style, penFor(p.pens, style.pen), layer, fit, frame));
    }

    if (p.north.enabled) {
      prims.push(...northPrims(frame, { ...p.north, color: colorOf(p.north.pen), fontFamily, fontKey: t.font, rotateDeg: p.region?.rotationDeg }));
    }

    if (p.features.enabled) {
      const sizeMm = p.features.sizePt * PT;
      const out = landmarkPrims({
        landmarks: [...p.custom, ...(data?.landmarks ?? [])],
        water: p.features.waterLabels && p.layers.water.enabled && widest <= LAYER_MAX_KM.water ? waterLines(data?.layers.water) : [],
        fit, frame, route: [],
        labelBounds: withinBorder({ x: frame.x - mg.left * 0.5, y: frame.y - mg.top * 0.5, w: frame.w + (mg.left + mg.right) * 0.5, h: frame.h + mg.top * 0.5 }),
        settings: p.features, sizeMm,
        markerR: Math.min(W, H) * 0.0045,
        penFor: (kind) => penFor(p.pens, featurePenId(p.features, penKeyOf(kind))),
        fontFamily, fontKey: t.font, trackingMm: sizeMm * 0.05,
      });
      prims.push(...out.prims);
      landmarks = out.entries;
      pool = out.pool;
      open = out.open;
    }
  }

  return { scene: { widthMm: W, heightMm: H, paper: p.paper, prims }, view, landmarks, pool, open };
}

export const composeScene = (p: Project, data?: CityData): Composed => compose(p, false, data);
export const buildScene = (p: Project, data?: CityData): Scene => compose(p, false, data).scene;

/** The geographic area the map frame shows; data must cover this. Cheap (no map drawing). */
export const viewOf = (p: Project): View | undefined => compose(p, true).view;
