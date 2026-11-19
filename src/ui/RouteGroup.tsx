import type { ReactNode } from 'react';
import { Group } from './Group';
import { PenSelect } from './PensPanel';
import { routeStops, type RouteStyle } from '../features/route';
import { useStore } from '../store';

const Row = ({ label, children }: { label: string; children: ReactNode }) => <div className="row"><label>{label}</label>{children}</div>;

/** The memory route: pick some of your own landmarks, put them in order, give each a note. */
export function RouteGroup() {
  const p = useStore((s) => s.project);
  const set = useStore((s) => s.set);
  const r = p.route;
  const stops = routeStops(r, p.custom);
  const free = p.custom.filter((c) => !r.stops.includes(c.id));
  const move = (i: number, by: number) => set((x) => {
    const s = x.route.stops.filter((id) => x.custom.some((c) => c.id === id));
    const j = i + by;
    if (j < 0 || j >= s.length) return;
    [s[i], s[j]] = [s[j]!, s[i]!];
    x.route.stops = s;
  });
  const note = (id: string, v: string) => set((x) => { const c = x.custom.find((q) => q.id === id); if (c) c.note = v || undefined; });

  return (
    <Group id="route" title="Memory route" toggle={{ on: r.enabled, onChange: (on) => set((x) => { x.route.enabled = on; }) }}>
      <div className="hint">Join your own places in the order they happened, with a note for each: where you met, your first flat, where you got married. The route is drawn over the map, and the stops are listed under it.</div>
      {!p.custom.length && <div className="hint">Add your places under My landmarks first.</div>}
      {stops.map((s, i) => (
        <div className="field stop" key={s.id}>
          <div className="row">
            <span className="stop-no" aria-hidden="true">{i + 1}</span>
            <b className="stop-name">{s.name}</b>
            <button type="button" title="Earlier" aria-label={`Move ${s.name} earlier`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
            <button type="button" title="Later" aria-label={`Move ${s.name} later`} disabled={i === stops.length - 1} onClick={() => move(i, 1)}>↓</button>
            <button type="button" title="Take off the route" aria-label={`Take ${s.name} off the route`} onClick={() => set((x) => { x.route.stops = x.route.stops.filter((id) => id !== s.id); })}>×</button>
          </div>
          <div className="row">
            <input type="text" maxLength={80} placeholder="A note for the key, e.g. where we met, 2009" aria-label={`Note for ${s.name}`} data-edit={`route-note-${s.id}`} value={s.note ?? ''} onChange={(e) => note(s.id, e.target.value)} />
          </div>
          {p.features.overrides[s.id]?.hidden && <div className="hint" style={{ margin: 0 }}>Its marker is off (My landmarks); the route still passes through it.</div>}
        </div>
      ))}
      {free.length > 0 && (
        <Row label="Add stop">
          <select value="" onChange={(e) => { const id = e.target.value; if (id) set((x) => { x.route.stops = [...x.route.stops.filter((q) => x.custom.some((c) => c.id === q)), id]; x.route.enabled = true; }); }}>
            <option value="">Choose one of your places…</option>
            {free.map((c) => <option key={c.id} value={c.id}>{c.name || 'Unnamed'}</option>)}
          </select>
        </Row>
      )}
      {stops.length === 1 && <div className="hint">Add one more stop to draw the route.</div>}

      <h3>Line</h3>
      <Row label="Pen"><PenSelect pens={p.pens} value={r.pen} onChange={(id) => set((x) => { x.route.pen = id!; })} /></Row>
      <Row label="Thickness"><input type="number" min={0.1} max={3} step={0.05} value={r.weightMm} onChange={(e) => set((x) => { x.route.weightMm = Math.min(3, Math.max(0.1, +e.target.value || 0.78)); })} /><span className="unit">mm</span></Row>
      <Row label="Style">
        <select value={r.style} onChange={(e) => set((x) => { x.route.style = e.target.value as RouteStyle; })}>
          <option value="dotted">Dotted</option><option value="dashed">Dashed</option><option value="solid">Solid</option>
        </select>
      </Row>
      <div className="kinds">
        <label><input type="checkbox" checked={r.curved} onChange={(e) => set((x) => { x.route.curved = e.target.checked; })} /> Curved</label>
        <label><input type="checkbox" checked={r.arrows} onChange={(e) => set((x) => { x.route.arrows = e.target.checked; })} /> Arrows</label>
        <label><input type="checkbox" checked={r.numbers} onChange={(e) => set((x) => { x.route.numbers = e.target.checked; })} /> Numbered stops</label>
        <label><input type="checkbox" checked={r.key} onChange={(e) => set((x) => { x.route.key = e.target.checked; })} /> Key under the map</label>
      </div>
      {r.key && <Row label="Key size"><input type="number" min={5} max={40} value={r.keySizePt} onChange={(e) => set((x) => { x.route.keySizePt = Math.min(40, Math.max(5, +e.target.value || 10)); })} /><span className="unit">pt</span></Row>}
      <Row label="Clear paper"><input type="number" min={0} max={6} step={0.5} value={r.clearMm} onChange={(e) => set((x) => { x.route.clearMm = Math.min(6, Math.max(0, +e.target.value || 0)); })} /><span className="unit">mm each side</span></Row>
    </Group>
  );
}
