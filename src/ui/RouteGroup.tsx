import { useRef, useState, type ReactNode } from 'react';
import { Group } from './Group';
import { PenSelect } from './PensPanel';
import { routeStops, type RouteStyle } from '../features/route';
import { addPhotos, addPhotoStop, byTime, photoStopName, routeRegion, type PhotoIn } from '../features/photoStops';
import { readPhotoInfo } from '../photos';
import type { BBox } from '../geo/project';
import { useStore } from '../store';

/** Thumbnails of the photos stops were made from, for this visit only: photos stay on the device and are never saved. */
const thumbs = new Map<string, string>();
const inView = (b: BBox | undefined, s: { lat: number; lon: number }) => !!b && s.lat >= b.minLat && s.lat <= b.maxLat && s.lon >= b.minLon && s.lon <= b.maxLon;

const Row = ({ label, children }: { label: string; children: ReactNode }) => <div className="row"><label>{label}</label>{children}</div>;

/** The memory route: pick some of your own landmarks, put them in order, give each a note. */
export function RouteGroup({ bbox }: { bbox?: BBox }) {
  const p = useStore((s) => s.project);
  const set = useStore((s) => s.set);
  const setRegion = useStore((s) => s.setRegion);
  const picker = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false);
  const [msg, setMsg] = useState('');
  /** photos that came without a location, waiting to be placed by hand */
  const [unplaced, setUnplaced] = useState<{ key: string; ph: PhotoIn; url: string }[]>([]);
  const fit = () => { const r = routeRegion(routeStops(useStore.getState().project.route, useStore.getState().project.custom)); if (r) setRegion(r); };

  const fromPhotos = async (files: FileList | null) => {
    if (!files?.length) return;
    setReading(true);
    setMsg('');
    try {
      const list = [...files];
      const read = await Promise.all(list.map(async (f) => ({ f, ph: { file: f.name, info: readPhotoInfo(await f.arrayBuffer()) } })));
      let result: ReturnType<typeof addPhotos> | undefined;
      set((x) => { result = addPhotos(x, read.map((r) => r.ph)); });
      const r = result!;
      const urlFor = (ph: PhotoIn) => { const f = read.find((x) => x.ph === ph)?.f; return f ? URL.createObjectURL(f) : ''; };
      // thumbnails for the new stops, matched by the order addPhotos used (oldest first)
      const placedPhotos = read.map((x) => x.ph).filter((ph) => ph.info.lat !== undefined).sort(byTime);
      const now = useStore.getState().project;
      for (const id of r.added) {
        const c = now.custom.find((q) => q.id === id);
        const ph = placedPhotos.find((q) => q.info.lat === c?.lat && q.info.lon === c?.lon);
        if (ph) thumbs.set(id, urlFor(ph));
      }
      setUnplaced((u) => [...u, ...r.unplaced.map((ph, i) => ({ key: `${Date.now()}-${i}-${ph.file}`, ph, url: urlFor(ph) }))]);
      const parts = [
        r.added.length ? `Added ${r.added.length} ${r.added.length === 1 ? 'stop' : 'stops'} from ${list.length} ${list.length === 1 ? 'photo' : 'photos'}` : `No new stops from ${list.length} ${list.length === 1 ? 'photo' : 'photos'}`,
        r.merged ? `${r.merged} taken where a stop already is that day` : '',
        r.unplaced.length ? `${r.unplaced.length} without a location (below)` : '',
      ].filter(Boolean);
      setMsg(parts.join(' · ') + '.');
      // bring new stops into view
      if (r.added.some((id) => { const c = now.custom.find((q) => q.id === id); return c && !inView(bbox, c); })) fit();
    } finally {
      setReading(false);
      if (picker.current) picker.current.value = '';
    }
  };
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
      <div className="row">
        <button type="button" className="primary" disabled={reading} onClick={() => picker.current?.click()}>{reading ? 'Reading photos…' : 'Add from photos'}</button>
        {stops.length > 1 && <button type="button" onClick={fit} title="Move and zoom the map to show every stop">Fit map to route</button>}
        <input ref={picker} type="file" accept="image/*,.heic,.heif" multiple hidden onChange={(e) => void fromPhotos(e.target.files)} />
      </div>
      <div className="hint">Each photo's location and date are read on this device; the photos are never uploaded. Stops go in the order the photos were taken.</div>
      {msg && <div className="hint" role="status">{msg}</div>}
      {unplaced.length > 0 && (
        <div className="field">
          <div className="hint" style={{ marginTop: 0 }}>
            These came without a location. Phones often remove it when a photo is picked from the photo library in a browser; choosing the original file instead (from Files, or after AirDrop or email) usually keeps it. Or place them yourself:
          </div>
          {unplaced.map((u) => (
            <div className="row unplaced" key={u.key}>
              {u.url && <img src={u.url} alt="" className="thumb" />}
              <span className="stop-name">{photoStopName(u.ph)}</span>
              <button type="button" onClick={() => useStore.getState().setPlacing({
                label: photoStopName(u.ph),
                done: (lat, lon) => {
                  let id = '';
                  set((x) => { id = addPhotoStop(x, u.ph, lat, lon); });
                  if (u.url) thumbs.set(id, u.url);
                  setUnplaced((list) => list.filter((q) => q.key !== u.key));
                },
              })}>Place on map</button>
              <button type="button" title="Leave this photo out" aria-label={`Leave out ${photoStopName(u.ph)}`} onClick={() => setUnplaced((list) => list.filter((q) => q.key !== u.key))}>×</button>
            </div>
          ))}
        </div>
      )}
      {!p.custom.length && <div className="hint">Or add places by address under My landmarks, then choose them here.</div>}
      {stops.map((s, i) => (
        <div className="field stop" key={s.id}>
          <div className="row">
            <span className="stop-no" aria-hidden="true">{i + 1}</span>
            {thumbs.get(s.id) && <img src={thumbs.get(s.id)} alt="" className="thumb" />}
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
