import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { formatClock, type PlotPlan, type PlotStroke } from '../export/plan';

/** How long the whole plot takes to watch: a quick look, a closer one, or as long as the plotter really takes. */
const PLAYBACK = [
  { label: '20 s', seconds: 20 },
  { label: '1 min', seconds: 60 },
  { label: '5 min', seconds: 300 },
  { label: 'Real time', seconds: 0 },
] as const;

interface Flat { s: PlotStroke; pen: number }

/** Where the plot is at time t: the strokes before it are done, and the pen is on one stroke or travelling between two. */
function locate(all: Flat[], t: number): number {
  // index of the last stroke that has started by t (-1 if none)
  let lo = 0, hi = all.length - 1, at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (all[mid]!.s.t0 <= t) { at = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return at;
}

/** The first part of a stroke, `frac` of its length, as points. */
function partial(s: PlotStroke, frac: number): { pts: number[]; x: number; y: number } {
  const p = s.pts;
  if (frac >= 1) return { pts: Array.from(p), x: p[p.length - 2]!, y: p[p.length - 1]! };
  let left = frac * s.lenMm;
  const out = [p[0]!, p[1]!];
  for (let i = 2; i < p.length; i += 2) {
    const seg = Math.hypot(p[i]! - p[i - 2]!, p[i + 1]! - p[i - 1]!);
    if (seg >= left) {
      const k = seg ? left / seg : 0;
      const x = p[i - 2]! + k * (p[i]! - p[i - 2]!), y = p[i - 1]! + k * (p[i + 1]! - p[i - 1]!);
      out.push(x, y);
      return { pts: out, x, y };
    }
    left -= seg;
    out.push(p[i]!, p[i + 1]!);
  }
  return { pts: out, x: p[p.length - 2]!, y: p[p.length - 1]! };
}

/**
 * Watch the plotter draw the map: the ink appears in the order and at the pace the plan says, with the pen head
 * moving between lines and a pause at each pen swap. Drawn on two canvases laid over the preview: one keeps the ink
 * laid so far, the other shows the line being drawn and the pen.
 */
export function PlotPlayer({ plan, sheet, controls, widthMm, paper, dark, onClose }: {
  plan: PlotPlan; sheet: RefObject<HTMLDivElement | null>;
  /** where the playback controls go (the action bar above the map), so they never cover the drawing */
  controls: HTMLElement | null;
  widthMm: number; paper: string; dark: boolean; onClose: () => void;
}) {
  const base = useRef<HTMLCanvasElement>(null);
  const top = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState<{ left: number; top: number; w: number; h: number; radius: string } | null>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [playback, setPlayback] = useState<number>(PLAYBACK[0].seconds);
  const all = useMemo<Flat[]>(() => plan.pens.flatMap((p, pen) => p.strokes.map((s) => ({ s, pen }))), [plan]);
  /** how far the base canvas has been inked: strokes [0, done) */
  const done = useRef(0);

  // sit exactly over the preview's sheet, and follow it when the window changes
  useEffect(() => {
    const el = sheet.current;
    if (!el) return;
    // a coaster's sheet is round or rounded: the canvases take the same shape
    const place = () => setBox({ left: el.offsetLeft, top: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight, radius: getComputedStyle(el).borderRadius });
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [sheet]);

  const scale = box ? box.w / widthMm : 1;
  const dpr = typeof window === 'undefined' ? 1 : Math.min(2, window.devicePixelRatio || 1);

  const inkStroke = (ctx: CanvasRenderingContext2D, pts: ArrayLike<number>, pen: number) => {
    const p = plan.pens[pen]!;
    ctx.strokeStyle = p.pen.color;
    ctx.globalAlpha = p.alpha;
    ctx.lineWidth = Math.max(0.6 * dpr, p.inkMm * scale * dpr);
    ctx.beginPath();
    ctx.moveTo(pts[0]! * scale * dpr, pts[1]! * scale * dpr);
    for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i]! * scale * dpr, pts[i + 1]! * scale * dpr);
    ctx.stroke();
  };
  const prepare = (ctx: CanvasRenderingContext2D) => {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalCompositeOperation = dark ? 'source-over' : 'multiply';
  };
  const resetBase = () => {
    const c = base.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = paper;
    ctx.fillRect(0, 0, c.width, c.height);
    done.current = 0;
  };

  // a new size or a new plan: start the ink again from blank paper
  useEffect(() => { resetBase(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [box?.w, box?.h, plan, paper]);

  // the clock: advance while playing
  useEffect(() => {
    if (!playing) return;
    const rate = playback ? plan.totalS / playback : 1;
    let last = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setT((v) => {
        const next = Math.min(plan.totalS, v + dt * rate);
        if (next >= plan.totalS) setPlaying(false);
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, playback, plan]);

  // draw the state at time t
  const at = locate(all, t);
  const cur = at >= 0 ? all[at] : undefined;
  const drawing = !!cur && t < cur.s.t1;
  useEffect(() => {
    const bctx = base.current?.getContext('2d');
    const tctx = top.current?.getContext('2d');
    if (!bctx || !tctx || !box) return;
    // finished strokes go onto the base canvas; going back in time means starting it again
    const finished = drawing ? at : at + 1;
    if (finished < done.current) resetBase();
    prepare(bctx);
    for (let i = done.current; i < finished; i++) inkStroke(bctx, all[i]!.s.pts, all[i]!.pen);
    done.current = Math.max(done.current, finished);

    // the top canvas: the stroke being drawn, the pen's path to the next line, and the pen itself
    tctx.clearRect(0, 0, tctx.canvas.width, tctx.canvas.height);
    prepare(tctx);
    let x = 0, y = 0, penIndex = cur?.pen ?? 0;
    if (cur && drawing) {
      const part = partial(cur.s, (t - cur.s.t0) / Math.max(1e-9, cur.s.t1 - cur.s.t0));
      inkStroke(tctx, part.pts, cur.pen);
      ({ x, y } = part);
    } else {
      // travelling (pen up) from the end of the last stroke to the start of the next
      const prev = cur?.s;
      const next = all[at + 1];
      const from: [number, number] = prev ? [prev.pts[prev.pts.length - 2]!, prev.pts[prev.pts.length - 1]!] : [0, 0];
      if (next) {
        const to: [number, number] = [next.s.pts[0]!, next.s.pts[1]!];
        const t0 = prev ? prev.t1 : 0;
        const k = Math.min(1, Math.max(0, (t - t0) / Math.max(1e-9, next.s.t0 - t0)));
        [x, y] = [from[0] + k * (to[0] - from[0]), from[1] + k * (to[1] - from[1])];
        penIndex = next.pen;
      } else {
        [x, y] = from;
      }
    }
    tctx.globalCompositeOperation = 'source-over';
    tctx.globalAlpha = 1;
    tctx.beginPath();
    tctx.arc(x * scale * dpr, y * scale * dpr, 4.5 * dpr, 0, 2 * Math.PI);
    tctx.fillStyle = plan.pens[penIndex]?.pen.color ?? '#000';
    tctx.fill();
    tctx.lineWidth = 1.5 * dpr;
    tctx.strokeStyle = dark ? '#000' : '#fff';
    tctx.stroke();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, at, drawing, box, all]);

  // what is happening now
  const penNow = plan.pens.findIndex((p) => t < p.end);
  const swapping = penNow > 0 && t < plan.pens[penNow]!.start;
  const p = plan.pens[penNow < 0 ? plan.pens.length - 1 : penNow];
  const status = t >= plan.totalS ? 'Done'
    : swapping ? `Swap to ${p!.pen.name}`
    : `Pen ${(penNow < 0 ? plan.pens.length - 1 : penNow) + 1} of ${plan.pens.length}: ${p?.pen.name ?? ''}`;

  const px = (v: number) => `${v}px`;
  const canvasStyle = box ? { left: px(box.left), top: px(box.top), width: px(box.w), height: px(box.h), borderRadius: box.radius } : { display: 'none' };
  return (<>
    {box && <canvas ref={base} className="plot-canvas" width={Math.round(box.w * dpr)} height={Math.round(box.h * dpr)} style={canvasStyle} aria-hidden="true" />}
    {box && <canvas ref={top} className="plot-canvas" width={Math.round(box.w * dpr)} height={Math.round(box.h * dpr)} style={canvasStyle} aria-hidden="true" />}
    {controls && createPortal(
      <div className="player" role="group" aria-label="Plot playback">
        <button type="button" onClick={() => { if (t >= plan.totalS) setT(0); setPlaying(!playing); }} aria-label={playing ? 'Pause' : 'Play'} title={playing ? 'Pause' : 'Play'}>{playing ? '❚❚' : '▶'}</button>
        <input type="range" min={0} max={plan.totalS} step={plan.totalS / 1000} value={t} aria-label="Plot time" onChange={(e) => setT(+e.target.value)} />
        <span className="clock">{formatClock(t)} / {formatClock(plan.totalS)}</span>
        <select value={playback} aria-label="Playback length" title="How long the whole plot takes to watch" onChange={(e) => setPlayback(+e.target.value)}>
          {PLAYBACK.map((o) => <option key={o.label} value={o.seconds}>{o.label}</option>)}
        </select>
        <span className="hint player-status" aria-live="polite">{status}</span>
        <button type="button" onClick={onClose} aria-label="Stop watching" title="Stop watching">✕</button>
      </div>,
      controls,
    )}
  </>);
}
