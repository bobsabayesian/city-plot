import type { TextPrim } from '../scene/types';
import { SANS, SERIF } from './hersheyData';

type Pt = [number, number];
interface Glyph { /** the letter's full advance, in font units */ adv: number; strokes: Pt[][] }

const BASELINE = 22;
const CAP_HEIGHT = 21;
/** The sans face's capital height as a share of its size, so single-stroke text is about as tall as the regular text it stands in for. */
const CAP_SHARE = 0.72;
const SPACE_ADV = 16;

function parse(row: string): Glyph {
  const bar = row.indexOf('|');
  const strokes: Pt[][] = [];
  let cur: Pt[] = [];
  // "M4,3 L8,5 10,7 M..." : a move starts a new stroke; every pair after it continues the line
  for (const tok of row.slice(bar + 1).split(/\s+/)) {
    if (!tok) continue;
    const body = tok[0] === 'M' || tok[0] === 'L' ? tok.slice(1) : tok;
    if (tok[0] === 'M') { if (cur.length) strokes.push(cur); cur = []; }
    const [x, y] = body.split(',').map(Number) as [number, number];
    cur.push([x, y]);
  }
  if (cur.length) strokes.push(cur);
  return { adv: 2 * Number(row.slice(0, bar)), strokes };
}

const circle = (cx: number, cy: number, r: number): Pt[] => Array.from({ length: 13 }, (_, i) => [cx + r * Math.cos((i / 12) * Math.PI * 2), cy + r * Math.sin((i / 12) * Math.PI * 2)] as Pt);
/** characters the Hershey set does not have but the poster uses: the degree sign, a middle dot, dashes and a few quotes */
const EXTRA: Record<string, Glyph> = {
  '°': { adv: 12, strokes: [circle(6, 5, 3)] },
  '·': { adv: 8, strokes: [[[4, 12], [4, 13]]] },
  '–': { adv: 24, strokes: [[[2, 13], [22, 13]]] },
  '—': { adv: 32, strokes: [[[1, 13], [31, 13]]] },
  '’': { adv: 8, strokes: [[[4, 1], [3, 5]]] },
  '×': { adv: 20, strokes: [[[4, 8], [16, 20]], [[16, 8], [4, 20]]] },
};

const cache = new Map<string, Glyph | null>();
/** The glyph for a character in a face, or null if the set has none (and so single-stroke text cannot be used for that text). */
function glyphOf(face: 'sans' | 'serif', ch: string): Glyph | null {
  const key = face + ch;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const code = ch.charCodeAt(0);
  const set = face === 'sans' ? SANS : SERIF;
  let g: Glyph | null = null;
  if (ch === ' ') g = { adv: SPACE_ADV, strokes: [] };
  else if (code >= 33 && code <= 126 && set[code - 33]) g = parse(set[code - 33]!);
  else if (EXTRA[ch]) g = EXTRA[ch]!;
  cache.set(key, g);
  return g;
}

/** Can every character of this text be drawn with single strokes? */
export const canStroke = (text: string, face: 'sans' | 'serif'): boolean => [...text].every((c) => glyphOf(face, c) !== null);

const f = (n: number) => +n.toFixed(3);

/**
 * The text as lines for a pen: path data of `M x y L x y …` strokes in poster mm, placed like the filled text it replaces
 * (anchor, letter-spacing, justified width, turn about its anchor point). Undefined if a character has no single-stroke shape.
 */
export function textToStrokes(t: TextPrim): string | undefined {
  if (!canStroke(t.text, t.fontKey)) return undefined;
  const glyphs = [...t.text].map((c) => glyphOf(t.fontKey, c)!);
  const k = (t.sizeMm * CAP_SHARE) / CAP_HEIGHT;
  let tracking = t.trackingMm;
  const natural = glyphs.reduce((a, g) => a + g.adv * k, 0);
  if (t.fitWidthMm !== undefined && glyphs.length > 1) tracking = Math.max(-0.05 * t.sizeMm, (t.fitWidthMm - natural) / (glyphs.length - 1));
  const width = natural + tracking * (glyphs.length - 1);
  let x = t.anchor === 'start' ? t.x : t.anchor === 'middle' ? t.x - width / 2 : t.x - width;
  const rot = t.rotate ? (t.rotate * Math.PI) / 180 : 0;
  const c = Math.cos(rot), s = Math.sin(rot);
  const place = (px: number, py: number): string => {
    if (!rot) return `${f(px)} ${f(py)}`;
    return `${f(t.x + (px - t.x) * c - (py - t.y) * s)} ${f(t.y + (px - t.x) * s + (py - t.y) * c)}`;
  };
  const out: string[] = [];
  for (const g of glyphs) {
    for (const stroke of g.strokes) {
      out.push(stroke.map(([gx, gy], i) => `${i ? 'L' : 'M'}${place(x + gx * k, t.y + (gy - BASELINE) * k)}`).join(''));
    }
    x += g.adv * k + tracking;
  }
  return out.join('');
}
