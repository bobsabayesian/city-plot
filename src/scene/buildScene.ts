import { fitBBox, inverseMercator, mercator, rotateFit, type BBox, type Fit } from '../geo/project';
import { circlePolygon, clipPolyline, clipPolylineConvex, roundRectPolygon, type Rect, type XY } from '../geo/clip';
import { formatCoords, formatCoordsDms, formatKm, formatMiles } from '../geo/format';
import { layerPrims, waterLines, type MapClip } from '../city/draw';
import { LAYER_KEYS, LAYER_MAX_KM, layerMaxKm, type LayerData, type LayerKey } from '../city/types';
import { landmarkPrims } from '../features/draw';
import { boxAt } from '../features/select';
import type { LandmarkEntry, LandmarkPlacement } from '../features/select';
import { penKeyOf, type Landmark } from '../features/types';
import { northBox, northPrims } from './north';
import { handPrim } from './hand';
import { graphFor, streetPath } from '../features/streetRoute';
import { barPrims, niceDistance, niceWalk, textWidthMm } from './scalebar';
import { cartouche } from './cartouche';
import { autoSpacingKm, gridGeometry, gridLines } from './grid';
import { legArrow, routeDash, routeHalos, routeLegs, routeStops, stopLabel, trimLeg } from '../features/route';
import { cutOutHalos } from '../features/halo';
import { effectiveWidth, flattenPath } from '../export/offset';
import { borderExtent, borderPrims, layoutBorder } from './border';
import { featurePenId, inkWidth, penFor } from './pens';
import type { Part, Prim, Scene } from './types';
import { clampMargins, posterMm, REGION_MAX_KM, REGION_MIN_KM, sizeShape, type InfoItem, type Placement, type Project, type Region } from './project';

const PT = 25.4 / 72;
/** Poster title when nothing has been searched for yet. */
export const DEFAULT_TITLE = 'City Plot';
export const WATERMARK_TEXT = 'Map data © OpenStreetMap contributors · generated with city.bobsabayesian.io';
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
    coords: c ? (p.text.location.coordFormat === 'dms' ? formatCoordsDms(c.lat, c.lon) : formatCoords(c.lat, c.lon)) : '',
    info: {
      extent: view ? `${dist(view.widthKm)} × ${dist(view.heightKm)}` : '',
      scale: view ? `1:${view.scale.toLocaleString('en-US')}` : '',
      // drawn as bars; the text is what the settings show as the automatic value
      bar: view ? 'a bar' : '',
      walk: view ? 'a bar of minutes' : '',
    } as Record<InfoItem['key'], string>,
  };
}

interface Block { part: Part; height: number; gapAfter: number; draw: (yTop: number) => Prim[] }
/** Mark primitives with the part of the map they draw, so the preview can open that part's settings when clicked. */
const tag = (part: Part) => (x: Prim): Prim => ({ ...x, part });

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
export interface Composed { scene: Scene; view?: View; landmarks?: LandmarkEntry[]; pool?: LandmarkPlacement['pool']; open?: LandmarkPlacement['open']; routeMisses?: number }

const roundScale = (s: number) => { const q = s >= 2000 ? 100 : 10; return Math.max(1, Math.round(s / q) * q); };

function compose(p: Project, layoutOnly = false, data?: CityData, moving = false): Composed {
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
  if (!layoutOnly) prims.push(...borderPrims(W, H, p.border, colorOf(p.border.pen)).map(tag('border')));
  const fontFamily = FONTS[t.font];
  const anchor = t.align === 'left' ? 'start' : t.align === 'right' ? 'end' : 'middle';
  const contentL = mg.left;
  const contentR = W - mg.right;
  const tx = t.align === 'left' ? contentL : t.align === 'right' ? contentR : (contentL + contentR) / 2;
  const innerW = contentR - contentL;
  const auto = autoValues(p);
  // scale and extent need the map frame, which needs the text blocks' heights: they are filled in once the frame is known
  let infoAuto = auto.info;
  /** map mm per metre of ground, for the scale bars; known once the frame is */
  let mmPerM = 0;
  // a cartouche frames the blocks on the title's side of the map; their text is set in from the frame
  const framed: Placement | undefined = t.title.visible && t.title.frame !== 'none' ? t.title.placement : undefined;
  const FRAME_PAD = 4;
  const L = (pl: Placement) => contentL + (pl === framed ? FRAME_PAD : 0);
  const R = (pl: Placement) => contentR - (pl === framed ? FRAME_PAD : 0);
  const X = (pl: Placement) => (t.align === 'left' ? L(pl) : t.align === 'right' ? R(pl) : (L(pl) + R(pl)) / 2);
  const text = (penId: string, s: string, y: number, sizeMm: number, extra: Partial<Extract<Prim, { kind: 'text' }>> = {}, x = tx): Prim => ({
    kind: 'text', text: s, x, y, anchor, sizeMm, trackingMm: sizeMm * t.trackingEm, fontFamily, fontKey: t.font, color: colorOf(penId), pen: penId, ...extra,
  });

  // ---- text blocks (height + draw), stacked from the top and bottom margins
  const blocks: Record<Placement, Block[]> = { top: [], bottom: [] };

  // the memory route's key: its stops in order, with their notes, right under the map
  const stops = p.route.enabled ? routeStops(p.route, p.custom) : [];
  if (stops.length && p.route.key) {
    const size = p.route.keySizePt * PT;
    const two = stops.length > 4;
    const rows = two ? Math.ceil(stops.length / 2) : stops.length;
    const lineH = size * 1.55;
    blocks.bottom.push({
      part: 'routeKey', height: (rows - 1) * lineH + size * 0.75, gapAfter: size * 1.6,
      draw: (y) => stops.map((s, i) => {
        const col = two ? Math.floor(i / rows) : 0;
        const row = two ? i % rows : i;
        const line = `${p.route.numbers ? `${i + 1}. ` : ''}${s.name}${s.note?.trim() ? ` — ${s.note.trim()}` : ''}`;
        const extra = two ? { anchor: 'start' as const } : {};
        const x = two ? L('bottom') + col * ((R('bottom') - L('bottom')) / 2) : X('bottom');
        return text(p.route.pen, line, y + row * lineH + size * 0.72, size, { trackingMm: size * t.trackingEm * 0.4, ...extra }, x);
      }),
    });
  }

  const title = (t.title.value ?? auto.title).trim();
  if (t.title.visible && title) {
    const ts = t.title;
    const size = ts.sizePt * PT;
    const align = ts.align === 'inherit' ? t.align : ts.align;
    const justify = align === 'justify';
    const pl = ts.placement;
    const where = {
      anchor: (justify || align === 'left' ? 'start' : align === 'right' ? 'end' : 'middle') as 'start' | 'middle' | 'end',
      x: justify || align === 'left' ? L(pl) : align === 'right' ? R(pl) : (L(pl) + R(pl)) / 2,
      ...(justify ? { fitWidthMm: R(pl) - L(pl) } : {}),
    };
    const { x: titleX, ...place } = where;
    blocks[ts.placement].push({
      part: 'title', height: size * 0.75, gapAfter: size * 0.4,
      draw: (y) => {
        const base = y + size * 0.72;
        const outline = { ...place, mode: 'stroke' as const, strokeMm: ts.outlineMm };
        if (ts.style === 'outline') return [text(ts.pen, title.toUpperCase(), base, size, outline, titleX)];
        // inside first, so the outline sits on top of it
        if (ts.style === 'outlineFill') return [
          text(ts.fillPen, title.toUpperCase(), base, size, { ...place, hatch: ts.fillDensity }, titleX),
          text(ts.pen, title.toUpperCase(), base, size, outline, titleX),
        ];
        return [text(ts.pen, title.toUpperCase(), base, size, { ...place, plotFill: ts.fillDensity }, titleX)];
      },
    });
  }

  const loc = (t.location.value ?? auto.location).trim();
  const coords = t.location.showCoords ? auto.coords : '';
  if (t.location.visible && (loc || coords)) {
    const size = t.location.sizePt * PT;
    const small = size * 0.75;
    blocks[t.location.placement].push({
      part: 'location',
      height: (loc ? size * 0.75 : 0) + (loc && coords ? size * 0.5 : 0) + (coords ? small * 0.75 : 0),
      gapAfter: size * 0.8,
      draw: (y) => {
        const out: Prim[] = [];
        let cy = y;
        const lx = X(t.location.placement);
        if (loc) { out.push(text(t.location.pen, loc, cy + size * 0.72, size, {}, lx)); cy += size * 1.25; }
        if (coords) out.push(text(t.location.pen, coords, cy + small * 0.72, small, { opacity: 0.7 }, lx));
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
    const pl = t.info.placement;
    const cellW = column ? R(pl) - L(pl) : (R(pl) - L(pl)) / items.length;
    const cellDraw = (it: (typeof items)[number], y: number, x: number): Prim[] => {
      const head = text(t.info.pen, it.label.toUpperCase(), y + ls * 0.72, ls, { opacity: 0.65 }, x);
      const base = y + ls * 1.5 + size * 0.72;
      if ((it.key === 'bar' || it.key === 'walk') && !it.value && mmPerM > 0) return [head, ...barCell(it.key, x, y + ls * 1.5, base)];
      // values too long for their cells are set smaller (all of the row alike) rather than run into the next one
      const value = it.value || infoAuto[it.key];
      const fit = column ? fitOf(value) : rowFit();
      return [head, text(t.info.pen, value, y + ls * 1.5 + size * fit * 0.72, size * fit, { trackingMm: track * fit }, x)];
    };
    const track = size * t.trackingEm * 0.6;
    const fitOf = (v: string) => Math.min(1, (cellW * 0.94) / Math.max(1e-6, textWidthMm(v, size, track, t.font === 'serif')));
    const isBar = (it: (typeof items)[number]) => (it.key === 'bar' || it.key === 'walk') && !it.value;
    const rowFit = () => Math.min(1, ...items.filter((it) => !isBar(it)).map((it) => fitOf(it.value || infoAuto[it.key])));
    /** a scale bar or a bar of minutes on foot, with its length written after it, in the cell at x */
    const barCell = (key: 'bar' | 'walk', x: number, top: number, base: number): Prim[] => {
      const lab = size * 0.6;
      const labTrack = lab * t.trackingEm * 0.5;
      const room = cellW * 0.92;
      const labelW = (s: string) => lab * 0.6 + textWidthMm(s, lab, labTrack, t.font === 'serif');
      const nice = (max: number) => (key === 'bar' ? niceDistance(max, mmPerM, p.units === 'imperial') : niceWalk(max, mmPerM));
      // the longest round length that fits in the cell with its own label after it
      let n = nice(room);
      while (n && n.m * mmPerM + labelW(n.label) > room) n = nice(n.m * mmPerM * 0.999);
      if (!n) return [];
      const len = n.m * mmPerM;
      const total = len + labelW(n.label);
      const x0 = t.align === 'left' ? x : t.align === 'right' ? x - total : x - total / 2;
      const barH = Math.max(1.2, size * 0.28);
      const pen = penFor(p.pens, t.info.pen);
      return [
        ...barPrims(x0, top + (size * 0.75 - barH) / 2, len, barH, key === 'bar' ? 4 : 2, pen.color, pen.id, inkWidth(pen)),
        { kind: 'text', text: n.label, x: x0 + len + lab * 0.6, y: base - (size - lab) * 0.36, anchor: 'start', sizeMm: lab, trackingMm: labTrack, fontFamily, fontKey: t.font, color: pen.color, pen: pen.id },
      ];
    };
    blocks[t.info.placement].push({
      part: 'info',
      height: column ? items.length * cell + (items.length - 1) * colGap : cell,
      gapAfter: size * 0.6,
      draw: (y) => {
        if (column) return items.flatMap((it, i) => cellDraw(it, y + i * (cell + colGap), X(pl)));
        return items.flatMap((it, i) => {
          const x = t.align === 'left' ? L(pl) + i * cellW : t.align === 'right' ? L(pl) + (i + 1) * cellW : L(pl) + (i + 0.5) * cellW;
          return cellDraw(it, y, x);
        });
      },
    });
  }

  // Stack the blocks from the top and bottom margins; they are drawn once the map frame is known.
  const queue: (() => Prim[])[] = [];
  /** the cartouche, once its blocks are stacked: from the top of the first to the bottom of the last, with room round them */
  const frameAround = (top: number, bottom: number) => queue.push(() => cartouche(contentL, top, contentR - contentL, bottom - top, t.title.frame, penFor(p.pens, t.title.pen)).map(tag('title')));
  let topCursor = mg.top;
  if (framed === 'top' && blocks.top.length) {
    const start = topCursor;
    topCursor += FRAME_PAD;
    blocks.top.forEach((b, i) => { const y = topCursor; queue.push(() => b.draw(y).map(tag(b.part))); topCursor += b.height + (i < blocks.top.length - 1 ? b.gapAfter : 0); });
    topCursor += FRAME_PAD;
    frameAround(start, topCursor);
    topCursor += Math.max(4, blocks.top.at(-1)!.gapAfter * 0.6);
  } else {
    for (const b of blocks.top) { const y = topCursor; queue.push(() => b.draw(y).map(tag(b.part))); topCursor += b.height + b.gapAfter; }
  }

  let bottomCursor = H - mg.bottom;
  if (p.showWatermark) {
    const size = 7 * PT;
    const y = bottomCursor;
    queue.push(() => [tag('watermark')(text(p.watermarkPen, WATERMARK_TEXT, y, size, { trackingMm: size * 0.04, opacity: 0.55 }))]);
    bottomCursor -= size * 2.4;
  }
  if (framed === 'bottom' && blocks.bottom.length) {
    const end = bottomCursor;
    bottomCursor -= FRAME_PAD;
    const rev = [...blocks.bottom].reverse();
    rev.forEach((b, i) => {
      bottomCursor -= b.height;
      const y = bottomCursor;
      queue.push(() => b.draw(y).map(tag(b.part)));
      if (i < rev.length - 1) bottomCursor -= b.gapAfter;
    });
    bottomCursor -= FRAME_PAD;
    frameAround(bottomCursor, end);
    bottomCursor -= Math.max(4, blocks.bottom[0]!.gapAfter * 0.6);
  } else {
    for (const b of [...blocks.bottom].reverse()) {
      bottomCursor -= b.height;
      const y = bottomCursor;
      queue.push(() => b.draw(y).map(tag(b.part)));
      bottomCursor -= b.gapAfter;
    }
  }

  // ---- map
  let view: View | undefined;
  /** legs of a route along the streets that had to be drawn as curves (no street path found) */
  let routeMisses: number | undefined;
  let landmarks: LandmarkEntry[] | undefined;
  let pool: LandmarkPlacement['pool'] | undefined;
  let open: LandmarkPlacement['open'] | undefined;
  if (p.region) {
    const frame: Rect = { x: contentL, y: topCursor, w: innerW, h: Math.max(bottomCursor - topCursor, 1) };
    // a fixed scale sets the ground width from the frame: 1 mm on paper is `scale` mm on the ground
    const region = p.region.scale ? { ...p.region, widthKm: Math.min(REGION_MAX_KM, Math.max(REGION_MIN_KM, (frame.w * p.region.scale) / 1e6)) } : p.region;
    const flat = fitBBox(regionBBox(region, frame.h / frame.w), frame);
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
    mmPerM = frame.w / (view.widthKm * 1000);
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

    // a coaster cuts the map to a circle or a rounded rectangle inside the frame
    const mapShape = sizeShape(p);
    let clip: MapClip | undefined;
    let northFrame = frame;
    if (mapShape?.shape === 'circle') {
      const r = Math.min(frame.w, frame.h) / 2;
      const [cx, cy] = [frame.x + frame.w / 2, frame.y + frame.h / 2];
      const half = r / Math.SQRT2;
      clip = { poly: circlePolygon(cx, cy, r), safe: { x: cx - half, y: cy - half, w: 2 * half, h: 2 * half } };
      northFrame = clip.safe;
    } else if (mapShape?.shape === 'roundrect') {
      // concentric with the paper's own corners
      const rad = Math.max(0, (mapShape.cornerMm ?? 0) - minMargin);
      clip = { poly: roundRectPolygon(frame, rad), safe: { x: frame.x, y: frame.y + rad, w: frame.w, h: Math.max(0, frame.h - 2 * rad) } };
      const inset = rad * 0.3;
      northFrame = { x: frame.x + inset, y: frame.y + inset, w: frame.w - 2 * inset, h: frame.h - 2 * inset };
    }
    const inClip = clip ? (x: number, y: number) => pointInConvex(x, y, clip!.poly) : undefined;

    // The memory route: its legs (stopping short of each marker) and the full line, which labels keep off.
    const markerR = Math.min(W, H) * 0.0045;
    const stopPts = stops.map((s) => fit.toMm(s.lat, s.lon));
    let legs = stopPts.length > 1 ? routeLegs(stopPts, p.route.curved) : [];
    // along the streets: each leg found in the map's street data; one it cannot find keeps its curve
    if (p.route.streets && legs.length && data) {
      const g = graphFor(data.layers);
      routeMisses = 0;
      legs = legs.map((leg, i) => {
        const path = g && streetPath(g, stops[i]!, stops[i + 1]!);
        if (!path) { routeMisses!++; return leg; }
        return path.map(([la, lo]) => fit.toMm(la, lo));
      });
    }
    const routeLine = legs.flatMap((l, i) => (i ? l.slice(1) : l));
    const shown = legs.map((l) => trimLeg(l, markerR * 1.4 + 1.2)).filter((l) => l.length > 1);
    const stopNo = new Map(stops.map((s, i) => [s.id, i + 1]));

    // Landmark labels are placed first: they keep clear of the north arrow, and the map lines are cut away around them.
    let placed: ReturnType<typeof landmarkPrims> | undefined;
    if (p.features.enabled) {
      const sizeMm = p.features.sizePt * PT;
      const arrow = p.north.enabled ? northBox(northFrame, p.north.corner, p.north.sizeMm) : undefined;
      placed = landmarkPrims({
        // stops on a numbered route are labelled with their number ("1. Home")
        landmarks: [...p.custom.map((c) => (stopNo.has(c.id) ? { ...c, name: stopLabel(stopNo.get(c.id)!, c.name, p.route.numbers) } : c)), ...(data?.landmarks ?? [])],
        water: p.features.waterLabels && p.layers.water.enabled && widest <= LAYER_MAX_KM.water ? waterLines(data?.layers.water) : [],
        waterNames: p.features.waterLabels && p.layers.water.enabled && widest <= LAYER_MAX_KM.water ? data?.layers.water?.waterNames : undefined,
        fit, frame, route: routeLine,
        obstacles: arrow ? [boxAt(arrow.x, arrow.y, arrow.x + p.north.sizeMm, arrow.y + p.north.sizeMm)] : [],
        labelBounds: withinBorder({ x: frame.x - mg.left * 0.5, y: frame.y - mg.top * 0.5, w: frame.w + (mg.left + mg.right) * 0.5, h: frame.h + mg.top * 0.5 }),
        settings: p.features, sizeMm, inside: inClip,
        markerR,
        penFor: (kind) => penFor(p.pens, featurePenId(p.features, penKeyOf(kind))),
        fontFamily, fontKey: t.font, trackingMm: sizeMm * 0.05,
      });
    }

    // the map lines are also cut away under the north arrow, so it sits on clear paper like a label does, and along the route
    const halos = [...(placed?.halos ?? []), ...routeHalos(shown, p.route.clearMm)];
    if (p.north.enabled) {
      const s = p.north.sizeMm;
      const at = northBox(northFrame, p.north.corner, s);
      halos.push({ box: { cx: at.x + s / 2, cy: at.y + s / 2, w: s, h: s, ang: ((p.region?.rotationDeg ?? 0) * Math.PI) / 180 }, r: 1, fills: true });
    }

    // the map layers, bottom first; a layer is skipped when the view is wider than it is made for
    const firstMapPrim = prims.length;
    const gridLabels: Prim[] = [];
    for (const key of LAYER_KEYS) {
      const style = p.layers[key];
      const layer = data?.layers[key];
      if (!style.enabled || !layer || widest > layerMaxKm(key, style)) continue;
      prims.push(...layerPrims(key, style, penFor(p.pens, style.pen), layer, fit, frame, clip, halos, moving));
    }
    // the kilometre grid over the map layers, cut around the labels; its numbers go in the margin, outside the frame
    if (p.grid.enabled) {
      const pen = penFor(p.pens, p.grid.pen);
      const spacing = p.grid.spacingKm > 0 ? p.grid.spacingKm : autoSpacingKm(view.scale);
      const g = gridLines(fit, frame, spacing);
      const sizeMm = p.grid.labelSizePt * PT;
      const geo = gridGeometry(g.lines, frame, clip, 1.2, sizeMm);
      const d = cutOutHalos(geo.pieces, halos).map((l) => l.map(([x, y], i) => `${i ? 'L' : 'M'}${+x.toFixed(2)} ${+y.toFixed(2)}`).join('')).join('');
      if (d) prims.push({ kind: 'path', part: 'grid', d, color: pen.color, pen: pen.id, mode: 'stroke', widthMm: inkWidth(pen), round: true });
      if (p.grid.labels) gridLabels.push(...geo.labels.map((lb): Prim => ({
        kind: 'text', part: 'grid', text: lb.text, x: lb.x, y: lb.y, anchor: lb.anchor, sizeMm, trackingMm: 0,
        fontFamily, fontKey: t.font, color: pen.color, pen: pen.id,
      })));
    }
    // the route over the map: dotted legs and an arrow on each, cut to the map and kept off the labels
    if (shown.length) {
      const pen = penFor(p.pens, p.route.pen);
      const w = effectiveWidth(p.route.weightMm, inkWidth(pen));
      const cut = (lines: XY[][]) => cutOutHalos(lines.flatMap((l) => (clip ? clipPolylineConvex(l, clip.poly, clip.safe) : clipPolyline(l, frame))), placed?.halos ?? []);
      const d = (lines: XY[][]) => lines.map((l) => l.map(([x, y], i) => `${i ? 'L' : 'M'}${+x.toFixed(2)} ${+y.toFixed(2)}`).join('')).join('');
      const line = d(cut(shown));
      if (line) prims.push({ kind: 'path', part: 'route', d: line, color: pen.color, pen: pen.id, mode: 'stroke', widthMm: w, round: true, ...(routeDash(p.route.style, w) ? { dash: routeDash(p.route.style, w) } : {}) });
      if (p.route.arrows) {
        const arrows = shown.map((l) => legArrow(l, Math.max(3, w * 4.5))).filter(Boolean).flatMap((a) => flattenPath(a).map((s) => s.pts as XY[]));
        const ad = d(cut(arrows));
        if (ad) prims.push({ kind: 'path', part: 'route', d: ad, color: pen.color, pen: pen.id, mode: 'stroke', widthMm: w, round: true });
      }
    }
    // drawn by hand: the map lines tremble and drift, and are cut to the map again; the border is redrawn by hand too
    if (p.hand.amount > 0) {
      for (let i = 0; i < prims.length; i++) {
        const x = prims[i]!;
        if (x.kind !== 'path') continue;
        if (i >= firstMapPrim) prims[i] = handPrim(x, p.hand, frame, clip);
        else if (x.part === 'border') prims[i] = handPrim(x, p.hand);
      }
    }

    prims.push(...gridLabels);
    if (p.north.enabled) {
      prims.push(...northPrims(northFrame, { ...p.north, color: colorOf(p.north.pen), fontFamily, fontKey: t.font, rotateDeg: p.region?.rotationDeg }).map((x) => ({ ...x, part: 'north' as const })));
    }

    if (placed) {
      prims.push(...placed.prims);
      landmarks = placed.entries;
      pool = placed.pool;
      open = placed.open;
    }
  }

  const cut = sizeShape(p);
  const shape: Scene['shape'] = cut?.shape === 'circle' ? { kind: 'circle' } : cut?.shape === 'roundrect' ? { kind: 'roundrect', radiusMm: cut.cornerMm ?? 0 } : undefined;
  return { scene: { widthMm: W, heightMm: H, paper: p.paper, ...(shape ? { shape } : {}), prims }, view, landmarks, pool, open, routeMisses };
}

/** `moving`: the map is being dragged, zoomed or turned; slow extras (waterlines) are left out until it rests. */
export const composeScene = (p: Project, data?: CityData, moving = false): Composed => compose(p, false, data, moving);
export const buildScene = (p: Project, data?: CityData): Scene => compose(p, false, data).scene;

/** The geographic area the map frame shows; data must cover this. Cheap (no map drawing). */
export const viewOf = (p: Project): View | undefined => compose(p, true).view;

/** Is (x, y) inside a convex polygon? */
function pointInConvex(x: number, y: number, poly: XY[]): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i]!;
    const [bx, by] = poly[(i + 1) % poly.length]!;
    const c = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (c !== 0) { if (sign && Math.sign(c) !== sign) return false; sign = Math.sign(c); }
  }
  return true;
}
