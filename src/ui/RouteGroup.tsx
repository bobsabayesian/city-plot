import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Group } from './Group';
import { PenSelect } from './PensPanel';
import { routeStops, type RouteStyle } from '../features/route';
import { addPhotos, addPhotoStop, byTime, photoStopName, routeRegion, type PhotoIn } from '../features/photoStops';
import { readPhotoInfo } from '../photos';
import { collectDrop, dropLink, openDrop, qrSvg } from '../drop';

/** How often the computer looks for photos sent from the phone. */
export const DROP_POLL_MS = 3000;
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

  /** Put photos on the route (from this device's picker, or sent from a phone), with their thumbnails. */
  const ingest = (items: { ph: PhotoIn; url?: string }[]) => {
    let result: ReturnType<typeof addPhotos> | undefined;
    set((x) => { result = addPhotos(x, items.map((i) => i.ph)); });
    const r = result!;
    const urlFor = (ph: PhotoIn) => items.find((i) => i.ph === ph)?.url ?? '';
    // thumbnails for the new stops, matched by place (addPhotos took them oldest first)
    const placed = items.map((i) => i.ph).filter((ph) => ph.info.lat !== undefined).sort(byTime);
    const now = useStore.getState().project;
    for (const id of r.added) {
      const c = now.custom.find((q) => q.id === id);
      const ph = placed.find((q) => q.info.lat === c?.lat && q.info.lon === c?.lon);
      if (ph && urlFor(ph)) thumbs.set(id, urlFor(ph));
    }
    setUnplaced((u) => [...u, ...r.unplaced.map((ph, i) => ({ key: `${Date.now()}-${i}-${ph.file}`, ph, url: urlFor(ph) }))]);
    const n = items.length;
    const parts = [
      r.added.length ? `Added ${r.added.length} ${r.added.length === 1 ? 'stop' : 'stops'} from ${n} ${n === 1 ? 'photo' : 'photos'}` : `No new stops from ${n} ${n === 1 ? 'photo' : 'photos'}`,
      r.merged ? `${r.merged} taken where a stop already is that day` : '',
      r.unplaced.length ? `${r.unplaced.length} without a location (below)` : '',
    ].filter(Boolean);
    setMsg(parts.join(' · ') + '.');
    // bring new stops into view
    if (r.added.some((id) => { const c = now.custom.find((q) => q.id === id); return c && !inView(bbox, c); })) fit();
  };

  const fromPhotos = async (files: FileList | null) => {
    if (!files?.length) return;
    setReading(true);
    setMsg('');
    try {
      const read = await Promise.all([...files].map(async (f) => ({ ph: { file: f.name, info: readPhotoInfo(await f.arrayBuffer()) }, url: URL.createObjectURL(f) })));
      ingest(read);
    } finally {
      setReading(false);
      if (picker.current) picker.current.value = '';
    }
  };

  // ---- photos sent from a phone: a QR code of a drop box's link, and what arrives in it, collected every few seconds
  const [phone, setPhone] = useState<{ token: string; link: string; svg: string; expiresAt: number; received: number } | null>(null);
  const [phoneErr, setPhoneErr] = useState('');
  const startPhone = async () => {
    setPhoneErr('');
    try {
      const { token, expiresAt } = await openDrop();
      const link = dropLink(token);
      setPhone({ token, link, svg: await qrSvg(link), expiresAt, received: 0 });
    } catch (e) { setPhoneErr(e instanceof Error ? e.message : 'Could not open the link for your phone'); }
  };
  const ingestRef = useRef(ingest);
  ingestRef.current = ingest;
  const token = phone?.token;
  useEffect(() => {
    if (!token) return;
    let live = true;
    const tick = async () => {
      try {
        const { photos } = await collectDrop(token);
        if (!live || !photos.length) return;
        ingestRef.current(photos.map((d) => ({ ph: { file: d.file, info: d.info }, url: d.thumb })));
        setPhone((ph) => (ph && ph.token === token ? { ...ph, received: ph.received + photos.length } : ph));
      } catch (e) {
        if (!live) return;
        setPhoneErr(e instanceof Error ? e.message : 'Lost the link to your phone');
        setPhone(null);
      }
    };
    const t = setInterval(() => void tick(), DROP_POLL_MS);
    return () => { live = false; clearInterval(t); };
  }, [token]);

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
        {!phone && <button type="button" onClick={() => void startPhone()} title="Show a QR code to send photos from your phone">From your phone</button>}
      </div>
      {phoneErr && <div className="err">{phoneErr}</div>}
      {phone && (
        <div className="field qr">
          <div className="code" dangerouslySetInnerHTML={{ __html: phone.svg }} />
          <div className="about">
            <b>Scan with your phone's camera</b>
            <span className="hint" style={{ margin: 0 }}>
              Pick photos there and they'll appear here: their locations, dates and small previews, not the photos themselves. {phone.received
                ? `${phone.received} ${phone.received === 1 ? 'photo' : 'photos'} so far.`
                : 'Waiting for photos…'} The code works until {new Date(phone.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.
            </span>
            <input type="text" readOnly value={phone.link} aria-label="Link for your phone" onFocus={(e) => e.target.select()} />
            <div className="row" style={{ margin: 0 }}><button type="button" onClick={() => setPhone(null)}>Done</button></div>
          </div>
        </div>
      )}
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
