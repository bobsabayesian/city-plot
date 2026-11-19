import type { LayerData } from '../city/types';

/**
 * Walking paths along the streets for the memory route, found in the street data the map already has (the map
 * tiles), so no stop ever goes to a routing service. The footpaths and streets become a graph: points where ways meet
 * (or nearly meet: a way cut at a tile edge continues in the next tile a fraction of a metre away) are one node.
 * The shortest walk between two stops is then Dijkstra's, from the node nearest each stop.
 */

/** Ends closer than this are one point (tile edges, rounding). */
const JOIN_M = 1.5;
/** A stop further than this from any street is not on the network: that leg is drawn as a curve instead. */
export const MAX_SNAP_M = 250;
/** Main roads are walked, but a little less gladly than side streets and footpaths. */
const COST: Record<string, number> = { paths: 1, minor: 1, secondary: 1.1, major: 1.3 };

interface Graph {
  /** node positions, metres east and north of the reference point */
  x: Float64Array;
  y: Float64Array;
  lat: Float64Array;
  lon: Float64Array;
  /** adjacency: for node i, edges[start[i] .. start[i+1]) as (to, cost) */
  start: Int32Array;
  to: Int32Array;
  cost: Float64Array;
  /** for finding the node nearest a point */
  cells: Map<string, number[]>;
  ref: { lat: number; lon: number; kx: number; ky: number };
}

const CELL_M = 50;

/** Build the street graph from the street layers. */
export function buildGraph(layers: Partial<Record<string, LayerData>>): Graph | undefined {
  const keys = Object.keys(COST).filter((k) => layers[k]?.ways.length);
  if (!keys.length) return undefined;
  // a flat local projection is plenty over a city
  const first = layers[keys[0]!]!.ways.find((w) => w.pts.length >= 2);
  if (!first) return undefined;
  const rlat = first.pts[0]!, rlon = first.pts[1]!;
  const ky = 111_320, kx = 111_320 * Math.cos((rlat * Math.PI) / 180);
  const ref = { lat: rlat, lon: rlon, kx, ky };

  const xs: number[] = [], ys: number[] = [], lats: number[] = [], lons: number[] = [];
  const snap = new Map<string, number[]>();
  const nodeAt = (lat: number, lon: number): number => {
    const x = (lon - rlon) * kx, y = (lat - rlat) * ky;
    const cx = Math.floor(x / JOIN_M), cy = Math.floor(y / JOIN_M);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      for (const n of snap.get(`${cx + i},${cy + j}`) ?? []) if (Math.hypot(xs[n]! - x, ys[n]! - y) < JOIN_M) return n;
    }
    const n = xs.length;
    xs.push(x); ys.push(y); lats.push(lat); lons.push(lon);
    const k = `${cx},${cy}`;
    (snap.get(k) ?? snap.set(k, []).get(k)!).push(n);
    return n;
  };
  const edges: [number, number, number][] = [];
  for (const k of keys) {
    for (const w of layers[k]!.ways) {
      let prev = -1;
      for (let i = 0; i + 1 < w.pts.length; i += 2) {
        const n = nodeAt(w.pts[i]!, w.pts[i + 1]!);
        if (prev >= 0 && prev !== n) {
          const c = Math.hypot(xs[n]! - xs[prev]!, ys[n]! - ys[prev]!) * COST[k]!;
          edges.push([prev, n, c], [n, prev, c]);
        }
        prev = n;
      }
    }
  }
  const N = xs.length;
  const start = new Int32Array(N + 1);
  for (const [a] of edges) start[a + 1]!++;
  for (let i = 0; i < N; i++) start[i + 1]! += start[i]!;
  const to = new Int32Array(edges.length), cost = new Float64Array(edges.length);
  const fill = start.slice(0, N);
  for (const [a, b, c] of edges) { const at = fill[a]!++; to[at] = b; cost[at] = c; }
  const cells = new Map<string, number[]>();
  for (let n = 0; n < N; n++) {
    const k = `${Math.floor(xs[n]! / CELL_M)},${Math.floor(ys[n]! / CELL_M)}`;
    (cells.get(k) ?? cells.set(k, []).get(k)!).push(n);
  }
  return { x: Float64Array.from(xs), y: Float64Array.from(ys), lat: Float64Array.from(lats), lon: Float64Array.from(lons), start, to, cost, cells, ref };
}

/** The node nearest a place, if one is within MAX_SNAP_M. */
function nearest(g: Graph, lat: number, lon: number): number | undefined {
  const x = (lon - g.ref.lon) * g.ref.kx, y = (lat - g.ref.lat) * g.ref.ky;
  const cx = Math.floor(x / CELL_M), cy = Math.floor(y / CELL_M);
  const reach = Math.ceil(MAX_SNAP_M / CELL_M);
  let best: number | undefined, bestD = MAX_SNAP_M;
  for (let i = -reach; i <= reach; i++) for (let j = -reach; j <= reach; j++) {
    for (const n of g.cells.get(`${cx + i},${cy + j}`) ?? []) {
      const d = Math.hypot(g.x[n]! - x, g.y[n]! - y);
      if (d < bestD) { bestD = d; best = n; }
    }
  }
  return best;
}

/** A binary heap of (cost, node), smallest first. */
class Heap {
  private c: number[] = [];
  private n: number[] = [];
  get size() { return this.c.length; }
  push(cost: number, node: number) {
    const c = this.c, n = this.n;
    let i = c.length;
    c.push(cost); n.push(node);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (c[p]! <= cost) break;
      c[i] = c[p]!; n[i] = n[p]!; i = p;
    }
    c[i] = cost; n[i] = node;
  }
  pop(): [number, number] {
    const c = this.c, n = this.n;
    const top: [number, number] = [c[0]!, n[0]!];
    const lc = c.pop()!, ln = n.pop()!;
    if (c.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i, mc = lc;
        if (l < c.length && c[l]! < mc) { m = l; mc = c[l]!; }
        if (r < c.length && c[r]! < mc) { m = r; mc = c[r]!; }
        if (m === i) break;
        c[i] = c[m]!; n[i] = n[m]!; i = m;
      }
      c[i] = lc; n[i] = ln;
    }
    return top;
  }
}

/**
 * The walk along the streets from one place to another, as [lat, lon] points: from the first place to the street,
 * along it, and from the street to the second place. Undefined if either is off the network or they are not connected.
 */
export function streetPath(g: Graph, from: { lat: number; lon: number }, to: { lat: number; lon: number }): [number, number][] | undefined {
  const memo = paths.get(g) ?? paths.set(g, new Map()).get(g)!;
  const key = `${from.lat},${from.lon}>${to.lat},${to.lon}`;
  if (memo.has(key)) return memo.get(key);
  const found = findPath(g, from, to);
  memo.set(key, found);
  return found;
}

/** Paths already found, per graph: the route is redrawn on every change elsewhere on the page. */
const paths = new WeakMap<Graph, Map<string, [number, number][] | undefined>>();

function findPath(g: Graph, from: { lat: number; lon: number }, to: { lat: number; lon: number }): [number, number][] | undefined {
  const a = nearest(g, from.lat, from.lon), b = nearest(g, to.lat, to.lon);
  if (a === undefined || b === undefined) return undefined;
  const N = g.x.length;
  const dist = new Float64Array(N).fill(Infinity);
  const prev = new Int32Array(N).fill(-1);
  dist[a] = 0;
  const h = new Heap();
  h.push(0, a);
  while (h.size) {
    const [d, u] = h.pop();
    if (u === b) break;
    if (d > dist[u]!) continue;
    for (let e = g.start[u]!; e < g.start[u + 1]!; e++) {
      const v = g.to[e]!, nd = d + g.cost[e]!;
      if (nd < dist[v]!) { dist[v] = nd; prev[v] = u; h.push(nd, v); }
    }
  }
  if (a !== b && prev[b] === -1) return undefined;
  const nodes: number[] = [];
  for (let v = b; v !== -1; v = v === a ? -1 : prev[v]!) nodes.push(v);
  nodes.reverse();
  return [[from.lat, from.lon], ...nodes.map((n): [number, number] => [g.lat[n]!, g.lon[n]!]), [to.lat, to.lon]];
}

/** The street graph for these layers, kept while the layers stay the same (building it is the slow part). */
let cached: { layers: unknown[]; graph: Graph | undefined } | undefined;
export function graphFor(layers: Partial<Record<string, LayerData>>): Graph | undefined {
  const used = Object.keys(COST).map((k) => layers[k]);
  if (cached && cached.layers.length === used.length && cached.layers.every((l, i) => l === used[i])) return cached.graph;
  cached = { layers: used, graph: buildGraph(layers) };
  return cached.graph;
}
