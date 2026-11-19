import type { PathPrim, Prim, Scene, TextPrim } from '../scene/types';
import { penFor, penKind, type Pen } from '../scene/pens';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const f = (n: number) => +n.toFixed(3);

/** Normalize any #rgb / #rrggbb to lowercase #rrggbb so equal colors share a layer. */
export function normColor(c: string): string {
  const h = c.trim().toLowerCase();
  return /^#[0-9a-f]{3}$/.test(h) ? '#' + [...h.slice(1)].map((x) => x + x).join('') : h;
}

/** How the preview draws what a pen leaves: translucent ink lets what is under it show (and darkens where lines overlap, on light paper). */
export interface InkLook { pens: Pen[]; /** dark paper: inks are drawn over it, not multiplied into it */ dark: boolean }

/** How much of a pen's color one pass shows: an opaque pen 1, a very translucent marker about a half. */
export const inkAlpha = (pen: Pen): number => +(1 - 0.55 * (pen.transparency ?? penKind(pen.kind).transparency)).toFixed(3);

/** wide enough to click on screen: a map is shown at about 1 px per mm, so a hairline needs help */
const HIT_MM = 4;

function pathEl(p: PathPrim, look?: InkLook, ids = false): string {
  const part = ids && p.part ? ` data-part="${p.part}"` : '';
  const col = normColor(p.color);
  let op = p.opacity !== undefined && p.opacity < 1 ? ` opacity="${f(p.opacity)}"` : '';
  if (look && p.mode === 'stroke' && p.pen !== undefined) {
    const pen = penFor(look.pens, p.pen);
    const a = inkAlpha(pen) * (p.opacity ?? 1);
    op = ` stroke-opacity="${f(a)}"${look.dark ? '' : ' style="mix-blend-mode:multiply"'}`;
  }
  if (p.mode === 'fill') return `<path${part} d="${p.d}" fill="${col}" fill-rule="evenodd" stroke="none"${op}/>`;
  const dash = p.dash ? ` stroke-dasharray="${p.dash.map(f).join(' ')}"` : '';
  const line = `<path${part} d="${p.d}" fill="none" stroke="${col}" stroke-width="${f(p.widthMm ?? 0.5)}" stroke-linejoin="round" stroke-linecap="${p.round ? 'round' : 'butt'}"${dash}${op}/>`;
  // an invisible, wider copy of the line to click on (editor preview only)
  const hit = part ? `<path${part} d="${p.d}" fill="none" stroke="transparent" stroke-width="${HIT_MM}" stroke-linejoin="round" pointer-events="stroke"/>` : '';
  return line + hit;
}

function textEl(t: TextPrim, ids = false): string {
  const op = t.opacity !== undefined && t.opacity < 1 ? ` opacity="${f(t.opacity)}"` : '';
  const rot = t.rotate ? ` transform="rotate(${f(t.rotate)} ${f(t.x)} ${f(t.y)})"` : '';
  // justified text: let the viewer spread the letters to the width
  const fit = t.fitWidthMm !== undefined ? ` textLength="${f(t.fitWidthMm)}" lengthAdjust="spacing"` : '';
  const paint = t.mode === 'stroke'
    ? `fill="none" stroke="${normColor(t.color)}" stroke-width="${f(t.strokeMm ?? 0.35)}" stroke-linejoin="round"`
    : `fill="${normColor(t.color)}"`;
  const ref = (ids && t.ref ? ` data-lm="${esc(t.ref)}"` : '') + (ids && t.part ? ` data-part="${t.part}"` : '');
  return `<text${ref} x="${f(t.x)}" y="${f(t.y)}"${rot}${fit} text-anchor="${t.anchor}" font-size="${f(t.sizeMm)}" letter-spacing="${f(t.trackingMm)}" font-family="${esc(t.fontFamily)}" ${paint}${op}>${esc(t.text)}</text>`;
}

const el = (p: Prim, ids = false, look?: InkLook) => (p.kind === 'path' ? pathEl(p, look, ids) : textEl(p, ids));
const colorOf = (p: Prim) => normColor(p.color);

export interface SvgOptions {
  /** include the paper-colored background rect (omit for plotting) */
  paper?: boolean;
  /**
   * tag landmark labels with their id, and everything with the part of the map it draws (with wider invisible lines
   * to click on): the editor preview uses it for click to edit; exports leave it off
   */
  ids?: boolean;
  /**
   * 'style' (the default): one layer per color and stroke width, which is what a design file wants.
   * 'pen': one layer per pen of the palette, named after it, in palette order, which is what a plotter wants: a layer is a pen.
   */
  layers?: 'style' | 'pen';
  /** the pen palette, for `layers: 'pen'` */
  pens?: Pen[];
  /** draw lines the way their pens lay ink on paper (the editor's plotter preview); exports leave it off */
  ink?: InkLook;
}

/**
 * Layer key for a primitive. Pen plotters need one pen per layer, so every distinct color AND every distinct
 * stroke width is its own layer. Fills (and live <text>, which is filled) cannot be plotted and go in separate
 * fill layers by color.
 */
export function layerOf(p: Prim): { id: string; label: string } {
  const c = colorOf(p);
  // outlined text is drawn with a pen like any other line
  const width = p.kind === 'path' && p.mode === 'stroke' ? (p.widthMm ?? 0.5) : p.kind === 'text' && p.mode === 'stroke' ? (p.strokeMm ?? 0.35) : undefined;
  if (width !== undefined) {
    const w = +width.toFixed(2);
    return { id: `layer-${c.slice(1)}-${w}mm`, label: `${c} ${w}mm` };
  }
  return { id: `layer-${c.slice(1)}-fill`, label: `${c} fill` };
}

/** The layer a primitive belongs to when layers follow pens. Anything without a pen of the palette falls back to its color and width. */
export function penLayerOf(p: Prim, pens: Pen[]): { id: string; label: string; rank: number } {
  const i = p.pen === undefined ? -1 : pens.findIndex((x) => x.id === p.pen);
  if (i >= 0) {
    const pen = pens[i]!;
    return { id: `pen-${i + 1}-${pen.id}`, label: `Pen ${i + 1}: ${pen.name} (${+pen.tipMm.toFixed(2)} mm, ${normColor(pen.color)})`, rank: i };
  }
  const l = layerOf(p);
  return { id: l.id, label: `No pen: ${l.label}`, rank: pens.length };
}

/**
 * One <g> per distinct (color, stroke width), flagged as an Inkscape layer so each pen gets its own layer.
 * Layers are ordered by first appearance, which keeps painter's order for fills under lines.
 */
export function sceneToSvg(scene: Scene, opts: SvgOptions = {}): string {
  const byPen = opts.layers === 'pen' && !!opts.pens;
  const order: string[] = [];
  const rank = new Map<string, number>();
  const groups = new Map<string, { label: string; els: string[] }>();
  for (const p of scene.prims) {
    const { id, label, rank: r } = byPen ? penLayerOf(p, opts.pens!) : { ...layerOf(p), rank: 0 };
    rank.set(id, r);
    if (!groups.has(id)) {
      groups.set(id, { label, els: [] });
      order.push(id);
    }
    groups.get(id)!.els.push(el(p, opts.ids, opts.ink));
  }
  // pen layers follow the palette's order (the order the pens are swapped in); style layers keep first appearance
  if (byPen) order.sort((a, b) => rank.get(a)! - rank.get(b)!);
  const { widthMm: w, heightMm: h } = scene;
  const layers = order
    .map((id, i) => {
      const g = groups.get(id)!;
      return `<g id="${id}" inkscape:groupmode="layer" inkscape:label="${byPen ? esc(g.label) : `Layer ${i + 1} ${g.label}`}">${g.els.join('')}</g>`;
    })
    .join('\n');
  const sh = scene.shape;
  const fillPaper = normColor(scene.paper);
  const paper = !opts.paper ? ''
    : sh?.kind === 'circle' ? `<circle id="paper" cx="${f(w / 2)}" cy="${f(h / 2)}" r="${f(Math.min(w, h) / 2)}" fill="${fillPaper}"/>\n`
    : sh?.kind === 'roundrect' ? `<rect id="paper" width="${f(w)}" height="${f(h)}" rx="${f(sh.radiusMm)}" fill="${fillPaper}"/>\n`
    : `<rect id="paper" width="${f(w)}" height="${f(h)}" fill="${fillPaper}"/>\n`;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="${f(w)}mm" height="${f(h)}mm" viewBox="0 0 ${f(w)} ${f(h)}">\n${paper}${layers}\n</svg>`;
}
