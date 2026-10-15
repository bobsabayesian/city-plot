import type { PathPrim, Prim, Scene, TextPrim } from '../scene/types';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const f = (n: number) => +n.toFixed(3);

/** Normalize any #rgb / #rrggbb to lowercase #rrggbb so equal colors share a layer. */
export function normColor(c: string): string {
  const h = c.trim().toLowerCase();
  return /^#[0-9a-f]{3}$/.test(h) ? '#' + [...h.slice(1)].map((x) => x + x).join('') : h;
}

function pathEl(p: PathPrim): string {
  const col = normColor(p.color);
  const op = p.opacity !== undefined && p.opacity < 1 ? ` opacity="${f(p.opacity)}"` : '';
  if (p.mode === 'fill') return `<path d="${p.d}" fill="${col}" stroke="none"${op}/>`;
  const dash = p.dash ? ` stroke-dasharray="${p.dash.map(f).join(' ')}"` : '';
  return `<path d="${p.d}" fill="none" stroke="${col}" stroke-width="${f(p.widthMm ?? 0.5)}" stroke-linejoin="round" stroke-linecap="${p.round ? 'round' : 'butt'}"${dash}${op}/>`;
}

function textEl(t: TextPrim): string {
  const op = t.opacity !== undefined && t.opacity < 1 ? ` opacity="${f(t.opacity)}"` : '';
  const rot = t.rotate ? ` transform="rotate(${f(t.rotate)} ${f(t.x)} ${f(t.y)})"` : '';
  // justified text: let the viewer spread the letters to the width
  const fit = t.fitWidthMm !== undefined ? ` textLength="${f(t.fitWidthMm)}" lengthAdjust="spacing"` : '';
  const paint = t.mode === 'stroke'
    ? `fill="none" stroke="${normColor(t.color)}" stroke-width="${f(t.strokeMm ?? 0.35)}" stroke-linejoin="round"`
    : `fill="${normColor(t.color)}"`;
  return `<text x="${f(t.x)}" y="${f(t.y)}"${rot}${fit} text-anchor="${t.anchor}" font-size="${f(t.sizeMm)}" letter-spacing="${f(t.trackingMm)}" font-family="${esc(t.fontFamily)}" ${paint}${op}>${esc(t.text)}</text>`;
}

const el = (p: Prim) => (p.kind === 'path' ? pathEl(p) : textEl(p));
const colorOf = (p: Prim) => normColor(p.color);

export interface SvgOptions {
  /** include the paper-colored background rect (omit for plotting) */
  paper?: boolean;
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

/**
 * One <g> per distinct (color, stroke width), flagged as an Inkscape layer so each pen gets its own layer.
 * Layers are ordered by first appearance, which keeps painter's order for fills under lines.
 */
export function sceneToSvg(scene: Scene, opts: SvgOptions = {}): string {
  const order: string[] = [];
  const groups = new Map<string, { label: string; els: string[] }>();
  for (const p of scene.prims) {
    const { id, label } = layerOf(p);
    if (!groups.has(id)) {
      groups.set(id, { label, els: [] });
      order.push(id);
    }
    groups.get(id)!.els.push(el(p));
  }
  const { widthMm: w, heightMm: h } = scene;
  const layers = order
    .map((id, i) => {
      const g = groups.get(id)!;
      return `<g id="${id}" inkscape:groupmode="layer" inkscape:label="Layer ${i + 1} ${g.label}">${g.els.join('')}</g>`;
    })
    .join('\n');
  const paper = opts.paper ? `<rect id="paper" width="${f(w)}" height="${f(h)}" fill="${normColor(scene.paper)}"/>\n` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="${f(w)}mm" height="${f(h)}mm" viewBox="0 0 ${f(w)} ${f(h)}">\n${paper}${layers}\n</svg>`;
}
