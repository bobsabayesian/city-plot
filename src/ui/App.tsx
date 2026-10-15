import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { clampKm, useStore } from '../store';
import { saveExport } from '../lookup';
import { describePoolItem } from '../features/format';
import { CUSTOM_ICONS, ICON_LABELS, KIND_LABELS, LANDMARK_KINDS, type CustomIcon, type Side } from '../features/types';
import { composeScene, autoValues, parseLatLon, viewOf, type CityData } from '../scene/buildScene';
import { sceneToSvg } from '../export/svg';
import { pngSize, sceneToPng } from '../export/png';
import { loadFonts } from '../export/fonts';
import { prepareScene, tipFor, type ExportMode } from '../export/outlines';
import { passCount, passWidth, summarizePasses } from '../export/offset';
import { PenSelect, PensPanel } from './PensPanel';
import { PagePanel } from './PagePanel';
import { FEATURE_PEN_LABELS, penFor } from '../scene/pens';
import type { FeaturePenKey } from '../features/types';
import { inverseMercator, mercator } from '../geo/project';
import { isAreaLayer, LANDMARKS_MAX_KM, LAYER_KEYS, LAYER_LABELS, LAYER_MAX_KM, type LayerKey } from '../city/types';
import { REGION_MAX_KM, REGION_MIN_KM, CUSTOM_SIZE_ID, CUSTOM_SIZE_MAX_MM, CUSTOM_SIZE_MIN_MM, PRINT_SIZES, type SizeGroup, type Project, type Corner, type NorthStyle, type Align, type FontKey, type Placement } from '../scene/project';

const PlaceRow = ({ value, onChange }: { value: Placement; onChange: (v: Placement) => void }) => (
  <Row label="Position">
    <select value={value} onChange={(e) => onChange(e.target.value as Placement)}>
      <option value="top">Top</option><option value="bottom">Bottom</option>
    </select>
  </Row>
);

const Row = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="row"><label>{label}</label>{children}</div>
);

/**
 * Save a file to the user's disk, and keep a copy in the bucket when there is one, with the project's settings
 * beside it (same name, .json) so the design can be recreated.
 */
function download(name: string, data: string | Blob, type: string, project: Project) {
  const blob = typeof data === 'string' ? new Blob([data], { type }) : data;
  void saveExport(name, blob);
  void saveExport(name.replace(/\.\w+$/, '.json'), new Blob([JSON.stringify(project, null, 1)], { type: 'application/json' }));
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
}

const fmtKm = (km: number) => (km < 1 ? `${Math.round(km * 1000)} m` : `${+km.toFixed(km < 10 ? 2 : 1)} km`);

/** How many passes of the layer's pen a line thickness takes, and how thick that really draws. */
function Passes({ weightMm, tipMm }: { weightMm: number; tipMm: number }) {
  const n = passCount(weightMm, tipMm);
  return <span className="passes" title="Passes of the pen at a 20% overlap">{n} {n === 1 ? 'pass' : 'passes'} = {passWidth(n, tipMm).toFixed(2)} mm</span>;
}

/** Thickness in mm, with the passes it means for this pen, and − / + to add or remove a pass. */
function Weight({ value, tipMm, onChange }: { value: number; tipMm: number; onChange: (mm: number) => void }) {
  const n = passCount(value, tipMm);
  return (
    <>
      <button title="One pass fewer" disabled={n <= 1} onClick={() => onChange(+passWidth(n - 1, tipMm).toFixed(3))}>−</button>
      <input type="number" min={0.05} max={5} step={0.01} value={value} onChange={(e) => onChange(Math.max(0.05, +e.target.value || tipMm))} />
      <button title="One pass more" onClick={() => onChange(+passWidth(n + 1, tipMm).toFixed(3))}>+</button>
    </>
  );
}

export function App() {
  const { project: p, set, setRegion, searchResults, searchIndex, choosePlace, searchPlace, ensureData, retryData, addCustom, busy, notice } = useStore();
  const layerState = useStore((s) => s.layers);
  const landmarkState = useStore((s) => s.landmarks);
  const [query, setQuery] = useState('');
  const [err, setErr] = useState('');
  const [paperInExport, setPaperInExport] = useState(false);
  const [mode, setMode] = useState<ExportMode>('print');
  const [dpi, setDpi] = useState(150);
  const [pngBusy, setPngBusy] = useState(false);
  const [custom, setCustom] = useState({ name: '', where: '', icon: 'pin' as CustomIcon });

  const data = useMemo<CityData>(() => ({
    layers: Object.fromEntries(LAYER_KEYS.flatMap((k) => (layerState[k]?.data ? [[k, layerState[k]!.data!]] : []))),
    landmarks: landmarkState.data?.landmarks ?? [],
  }), [layerState, landmarkState.data]);
  const composed = useMemo(() => composeScene(p, data), [p, data]);
  const scene = composed.scene;
  const view = composed.view;
  const auto = useMemo(() => autoValues(p, view), [p, view]);
  const widest = view ? Math.max(view.widthKm, view.heightKm) : 0;

  // Fetch whatever the visible area, and the layers switched on, need that is not already here.
  const need = useMemo(() => viewOf(p)?.bbox, [p]);
  const needKey = need ? [need.minLat, need.maxLat, need.minLon, need.maxLon].map((v) => v.toFixed(5)).join() : '';
  const wanted = `${LAYER_KEYS.map((k) => +p.layers[k].enabled).join('')}${+p.features.enabled}`;
  useEffect(() => {
    if (!need) return;
    const t = setTimeout(() => ensureData(need, widest), 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needKey, widest, wanted, layerState, landmarkState.status]);

  // Which line weights in this design become several passes with their pens (plotter export).
  const passes = useMemo(() => summarizePasses(scene.prims, (x) => tipFor(x as { pen?: string }, { pens: p.pens })), [scene, p.pens]);
  const previewSvg = useMemo(() => sceneToSvg(scene, { paper: true }), [scene]);

  // ---- the map in the preview: drag to move, scroll to zoom
  const sheet = useRef<HTMLDivElement>(null);
  const live = useRef({ view, region: p.region, scene });
  live.current = { view, region: p.region, scene };
  useEffect(() => {
    const el = sheet.current;
    if (!el) return;
    /** pointer position as poster mm, if it is over the map */
    const toMm = (e: { clientX: number; clientY: number }) => {
      const svg = el.querySelector('svg');
      const { view: v, scene: sc } = live.current;
      if (!svg || !v) return undefined;
      const r = svg.getBoundingClientRect();
      const k = sc.widthMm / r.width;
      return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k, k, v };
    };
    const inFrame = (m: NonNullable<ReturnType<typeof toMm>>) => m.x >= m.v.frame.x && m.x <= m.v.frame.x + m.v.frame.w && m.y >= m.v.frame.y && m.y <= m.v.frame.y + m.v.frame.h;
    const onWheel = (e: WheelEvent) => {
      const m = toMm(e);
      const region = live.current.region;
      if (!m || !region) return;
      e.preventDefault();
      const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      const widthKm = clampKm(region.widthKm * Math.exp(delta * 0.0015));
      // keep the point under the cursor where it is
      let { lat, lon } = region;
      if (inFrame(m)) {
        const [cl, co] = m.v.fit.fromMm(m.x, m.y);
        const [px, py] = mercator(cl, co);
        const [rx, ry] = mercator(region.lat, region.lon);
        const k = widthKm / region.widthKm;
        [lat, lon] = inverseMercator(px + (rx - px) * k, py + (ry - py) * k);
      }
      useStore.getState().setRegion({ lat, lon, widthKm });
    };
    let drag: { x: number; y: number; lat: number; lon: number; k: number; merc: number; rot: number; spin?: { angle: number; from: number } } | undefined;
    let raf = 0;
    const onDown = (e: PointerEvent) => {
      const m = toMm(e);
      const region = live.current.region;
      if (!m || !region || !inFrame(m)) return;
      el.setPointerCapture(e.pointerId);
      const rot = region.rotationDeg ?? 0;
      // shift-drag turns the map about the frame's center instead of moving it
      const angleAt = (mm: { x: number; y: number }) => (Math.atan2(mm.y - (m.v.frame.y + m.v.frame.h / 2), mm.x - (m.v.frame.x + m.v.frame.w / 2)) * 180) / Math.PI;
      drag = { x: e.clientX, y: e.clientY, lat: region.lat, lon: region.lon, k: m.k, merc: m.v.fit.metersPerMm, rot, ...(e.shiftKey ? { spin: { angle: angleAt(m), from: rot } } : {}) };
      el.classList.add('dragging');
    };
    const onMove = (e: PointerEvent) => {
      if (!drag) return;
      const d = drag;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (d.spin) {
          const m = toMm(e);
          if (!m) return;
          const now = (Math.atan2(m.y - (m.v.frame.y + m.v.frame.h / 2), m.x - (m.v.frame.x + m.v.frame.w / 2)) * 180) / Math.PI;
          let deg = d.spin.from + (now - d.spin.angle);
          deg = ((((deg + 180) % 360) + 360) % 360) - 180;
          useStore.getState().setRegion({ rotationDeg: Math.round(deg) });
          return;
        }
        // the map follows the pointer: dragging right moves the center left. On a turned map the drag is turned back first.
        const a = (-d.rot * Math.PI) / 180;
        const [dx, dy] = [(e.clientX - d.x) * d.k, (e.clientY - d.y) * d.k];
        const [ux, uy] = [dx * Math.cos(a) - dy * Math.sin(a), dx * Math.sin(a) + dy * Math.cos(a)];
        const [cx, cy] = mercator(d.lat, d.lon);
        const [lat, lon] = inverseMercator(cx - ux * d.merc, cy + uy * d.merc);
        useStore.getState().setRegion({ lat, lon });
      });
    };
    const onUp = () => { drag = undefined; el.classList.remove('dragging'); };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
    };
  }, []);

  const region = p.region;
  const fileBase = `city-plot-${(p.place?.name ?? 'map').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'map'}`;
  const status = (key: LayerKey): ReactNode => {
    const st = layerState[key];
    if (widest > LAYER_MAX_KM[key]) return <span className="hint">Too wide: shown at {LAYER_MAX_KM[key]} km or less across. Zoom in.</span>;
    if (st?.status === 'loading') return <span className="hint">Loading…</span>;
    if (st?.status === 'error') return <span className="err">{st.error} <button onClick={retryData}>Retry</button></span>;
    if (st?.data?.truncated) return <span className="hint">Very dense: the map server cut this layer short. Zoom in for all of it.</span>;
    return null;
  };

  return (
    <div className="app">
      <aside className="panel">
        <h1>CITY PLOT</h1>
        <h2>Place</h2>
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (query.trim()) searchPlace(query.trim()); }}>
          <input type="text" placeholder="City, landmark, address, or lat, lon" value={query} onChange={(e) => setQuery(e.target.value)} />
          <button disabled={!!busy}>{busy || 'Go'}</button>
        </form>
        {notice && <div className="err">{notice}</div>}
        {searchResults.length > 0 && (
          <div className="results">
            {searchResults.map((r, i) => (
              <button key={`${r.lat},${r.lon},${i}`} className={i === searchIndex && p.place ? 'res sel' : 'res'} onClick={() => choosePlace(i)}>
                <b>{r.name}</b>
                <span>{[r.kind, r.location].filter(Boolean).join(' · ')}</span>
              </button>
            ))}
          </div>
        )}
        {!p.place && <div className="hint">Search for a city or a landmark to start. You can then move the map and set how much ground it covers.</div>}

        {region && view && (<>
          <h2>Region</h2>
          <div className="hint">Drag the map to move it. Scroll over it to zoom. The area follows the page shape, so a taller page shows more north to south.</div>
          <Row label="Width">
            <input type="range" min={Math.log(REGION_MIN_KM)} max={Math.log(REGION_MAX_KM)} step={0.01} value={Math.log(region.widthKm)} onChange={(e) => setRegion({ widthKm: +Math.exp(+e.target.value).toFixed(3) })} />
            <span>{fmtKm(region.widthKm)}</span>
          </Row>
          <Row label="Center">
            <input type="number" step={0.001} title="Latitude" value={+region.lat.toFixed(5)} onChange={(e) => setRegion({ lat: +e.target.value || 0 })} />
            <input type="number" step={0.001} title="Longitude" value={+region.lon.toFixed(5)} onChange={(e) => setRegion({ lon: +e.target.value || 0 })} />
          </Row>
          <Row label="Rotate">
            <input type="range" min={-180} max={180} step={1} value={region.rotationDeg ?? 0} onChange={(e) => setRegion({ rotationDeg: +e.target.value })} />
            <input type="number" min={-180} max={180} step={1} style={{ maxWidth: 64 }} value={Math.round(region.rotationDeg ?? 0)} onChange={(e) => setRegion({ rotationDeg: +e.target.value || 0 })} />
            <button disabled={!region.rotationDeg} title="North up" onClick={() => setRegion({ rotationDeg: 0 })}>↑</button>
          </Row>
          <div className="hint">Turns the map clockwise; the north arrow turns with it. Shift-drag the map to rotate it.</div>
          <div className="hint">Covers {fmtKm(view.widthKm)} × {fmtKm(view.heightKm)} · scale 1:{view.scale.toLocaleString('en-US')}</div>
          {p.place && <div className="row"><button onClick={() => { const pl = p.place!; setRegion({ lat: pl.lat, lon: pl.lon }); }}>Center on {p.place.name}</button></div>}
        </>)}

        <PensPanel project={p} scene={scene} />

        <h2>Map layers</h2>
        <div className="hint">Each layer is drawn with one of your pens. A line is drawn as passes of the pen side by side, overlapping by 20%, so its thickness is whole passes: a 0.3 mm pen draws 0.3, 0.54, 0.78, 1.02 mm… Anything thinner than the pen is one pass.</div>
        {[...LAYER_KEYS].reverse().map((key) => {
          const st = p.layers[key];
          const pen = penFor(p.pens, st.pen);
          return (
            <div className="field" key={key}>
              <Row label={LAYER_LABELS[key]}>
                <input type="checkbox" checked={st.enabled} onChange={(e) => set((x) => { x.layers[key].enabled = e.target.checked; })} />
                {st.enabled && <Passes weightMm={st.weightMm} tipMm={pen.tipMm} />}
              </Row>
              {st.enabled && (<>
                <Row label="Pen"><PenSelect pens={p.pens} value={st.pen} onChange={(id) => set((x) => { x.layers[key].pen = id!; })} /></Row>
                <Row label="Thickness"><Weight value={st.weightMm} tipMm={pen.tipMm} onChange={(mm) => set((x) => { x.layers[key].weightMm = mm; })} /><span className="unit">mm</span></Row>
                <Row label="Line">
                  <select value={st.style} onChange={(e) => set((x) => { x.layers[key].style = e.target.value as typeof st.style; })}>
                    <option value="solid">Solid</option><option value="dashed">Dashed</option><option value="dotted">Dotted</option>
                  </select>
                </Row>
                {isAreaLayer(key) && (
                  <Row label="Fill">
                    <select value={st.fill} onChange={(e) => set((x) => { x.layers[key].fill = e.target.value as typeof st.fill; })}>
                      <option value="off">Outline only</option><option value="light">Light hatching</option><option value="medium">Medium hatching</option><option value="solid">Solid hatching</option>
                    </select>
                  </Row>
                )}
              </>)}
              {st.enabled && status(key)}
            </div>
          );
        })}

        <h2>Landmarks</h2>
        <Row label="Show">
          <input type="checkbox" checked={p.features.enabled} onChange={(e) => set((x) => { x.features.enabled = e.target.checked; })} />
          <span>{landmarkState.status === 'loading' ? 'Loading landmarks…' : ''}</span>
        </Row>
        {landmarkState.status === 'error' && <div className="err">{landmarkState.error} <button onClick={retryData}>Retry</button></div>}
        {p.features.enabled && widest > LANDMARKS_MAX_KM && <div className="hint">Landmarks are found for views up to {LANDMARKS_MAX_KM} km across; your own are always shown.</div>}
        {p.features.enabled && widest > 8 && widest <= LANDMARKS_MAX_KM && <div className="hint">At this width only landmarks linked to Wikipedia/Wikidata are listed; zoom in for more.</div>}
        {p.features.enabled && (<>
          <Row label="Max labels"><input type="range" min={0} max={40} step={1} value={p.features.maxLabels} onChange={(e) => set((x) => { x.features.maxLabels = +e.target.value; })} /><span>{p.features.maxLabels}</span></Row>
          <div className="kinds">
            {LANDMARK_KINDS.filter((k) => k !== 'custom').map((k) => (
              <label key={k}><input type="checkbox" checked={p.features.kinds[k]} onChange={(e) => set((x) => { x.features.kinds[k] = e.target.checked; })} /> {KIND_LABELS[k]}</label>
            ))}
            <label title="Write river and lake names"><input type="checkbox" checked={p.features.waterLabels} onChange={(e) => set((x) => { x.features.waterLabels = e.target.checked; })} /> Water names</label>
          </div>
          {p.features.waterLabels && <Row label="Max water names"><input type="range" min={0} max={10} step={1} value={p.features.maxWaterLabels} onChange={(e) => set((x) => { x.features.maxWaterLabels = +e.target.value; })} /><span>{p.features.maxWaterLabels}</span></Row>}
          <Row label="Size (pt)"><input type="number" min={6} max={60} value={p.features.sizePt} onChange={(e) => set((x) => { x.features.sizePt = +e.target.value || 11; })} /></Row>
          <Row label="Pen"><PenSelect pens={p.pens} value={p.features.pens.default} onChange={(id) => set((x) => { x.features.pens.default = id!; })} /></Row>
          <details className="overrides">
            <summary>Pen for each kind</summary>
            {(Object.keys(FEATURE_PEN_LABELS) as FeaturePenKey[]).map((k) => (
              <Row key={k} label={FEATURE_PEN_LABELS[k]}>
                <PenSelect
                  pens={p.pens}
                  value={p.features.pens.overrides[k]}
                  allowDefault={`Same as landmarks (${penFor(p.pens, p.features.pens.default).name})`}
                  onChange={(id) => set((x) => { if (id === undefined) delete x.features.pens.overrides[k]; else x.features.pens.overrides[k] = id; })}
                />
              </Row>
            ))}
          </details>
          {composed.landmarks?.filter((l) => l.kind !== 'custom').map((l) => {
            const ov = p.features.overrides[l.id] ?? {};
            const edit = (patch: Partial<typeof ov>) => set((x) => { x.features.overrides[l.id] = { ...x.features.overrides[l.id], ...patch }; });
            return (
              <div className="lm" key={l.id}>
                <input type="checkbox" title="Show" checked={!l.hidden} onChange={(e) => edit({ hidden: !e.target.checked })} />
                <input type="text" title={KIND_LABELS[l.kind]} value={ov.name ?? l.name} onChange={(e) => edit({ name: e.target.value })} />
                <select title="Label side" value={ov.side ?? 'auto'} disabled={l.kind === 'lake' || l.kind === 'river'} onChange={(e) => edit({ side: e.target.value as Side })}>
                  <option value="auto">Auto</option><option value="right">Right</option><option value="left">Left</option>
                  <option value="above">Above</option><option value="below">Below</option>
                </select>
                {!l.placed && !l.hidden && <span className="hint" title="No room for this label">no room</span>}
              </div>
            );
          })}
          {(['point', 'water'] as const).map((group) => {
            const open = composed.open?.[group] ?? 0;
            const items = (composed.pool ?? []).filter((it) => it.group === group && it.kind !== 'custom');
            if (open <= 0 || (group === 'water' && !p.features.waterLabels)) return null;
            const noun = group === 'water' ? 'water name' : 'landmark';
            return (
              <div className="slot" key={group}>
                <div className="hint">
                  {open} open {noun} slot{open > 1 ? 's' : ''}. {items.length ? 'Choose what to add:' : `No other ${noun}s nearby.`}
                </div>
                {items.length > 0 && (
                  <select
                    value=""
                    onChange={(e) => {
                      const id = e.target.value;
                      if (id) set((x) => { x.features.overrides[id] = { ...x.features.overrides[id], pinned: true, hidden: false }; });
                    }}
                  >
                    <option value="">Add {noun}…</option>
                    {items.map((it) => <option key={it.id} value={it.id}>{describePoolItem(it)}</option>)}
                  </select>
                )}
              </div>
            );
          })}
        </>)}

        <h3>My landmarks</h3>
        <div className="hint">Mark your own places, like home. Give an address (or a place name) or latitude, longitude. A place you search for is added here, switched off; tick it to mark it on the map.</div>
        <form className="field" onSubmit={async (e) => {
          e.preventDefault();
          if (!custom.where.trim()) return;
          if (await addCustom(custom.name, custom.where.trim(), custom.icon)) setCustom({ ...custom, name: '', where: '' });
        }}>
          <Row label="Name"><input type="text" placeholder="Home" value={custom.name} onChange={(e) => setCustom({ ...custom, name: e.target.value })} /></Row>
          <Row label="Where"><input type="text" placeholder="123 Main St, Seattle  or  47.62, -122.35" value={custom.where} onChange={(e) => setCustom({ ...custom, where: e.target.value })} /></Row>
          <Row label="Marker">
            <select value={custom.icon} onChange={(e) => setCustom({ ...custom, icon: e.target.value as CustomIcon })}>
              {CUSTOM_ICONS.map((i) => <option key={i} value={i}>{ICON_LABELS[i]}</option>)}
            </select>
            <button disabled={!!busy || !custom.where.trim()}>Add</button>
          </Row>
        </form>
        {p.custom.map((c, i) => {
          const placed = composed.landmarks?.some((l) => l.id === c.id && l.placed);
          return (
            <div className="field" key={c.id}>
              <Row label="Name">
                <input type="checkbox" title="Show on the map" checked={!p.features.overrides[c.id]?.hidden} onChange={(e) => set((x) => { x.features.overrides[c.id] = { ...x.features.overrides[c.id], hidden: !e.target.checked }; })} />
                <input type="text" value={c.name} onChange={(e) => set((x) => { x.custom[i]!.name = e.target.value; })} />
                <button title="Remove" onClick={() => set((x) => { x.custom.splice(i, 1); })}>×</button></Row>
              <Row label="Marker">
                <select value={c.icon ?? 'pin'} onChange={(e) => set((x) => { x.custom[i]!.icon = e.target.value as CustomIcon; })}>
                  {CUSTOM_ICONS.map((k) => <option key={k} value={k}>{ICON_LABELS[k]}</option>)}
                </select>
                <button title="Move the map here" onClick={() => setRegion({ lat: c.lat, lon: c.lon })}>Center</button>
              </Row>
              <div className="hint">{c.lat.toFixed(5)}, {c.lon.toFixed(5)}{p.features.overrides[c.id]?.hidden ? ' · not shown' : region && !placed ? ' · outside the map, or no room for its label' : ''}</div>
            </div>
          );
        })}

        <h2>Print size</h2>
        <Row label="Size">
          <select value={p.sizeId} onChange={(e) => set((x) => { x.sizeId = e.target.value; })}>
            {(['US (inches)', 'ISO (A series)', 'Metric (cm)'] as SizeGroup[]).map((g) => (
              <optgroup key={g} label={g}>
                {PRINT_SIZES.filter((s) => s.group === g).map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </optgroup>
            ))}
            <option value={CUSTOM_SIZE_ID}>Custom size…</option>
          </select>
        </Row>
        {p.sizeId === CUSTOM_SIZE_ID && (() => {
          const inches = p.units === 'imperial';
          const conv = inches ? 25.4 : 10; // mm per displayed unit (in or cm)
          const show = (mm: number) => +(mm / conv).toFixed(2);
          const lim = (mm: number) => +(mm / conv).toFixed(1);
          const edit = (k: 'wMm' | 'hMm') => (e: React.ChangeEvent<HTMLInputElement>) => set((x) => { x.customSize[k] = Math.min(CUSTOM_SIZE_MAX_MM, Math.max(CUSTOM_SIZE_MIN_MM, (+e.target.value || 0) * conv)); });
          return (<>
            <Row label="Width"><input type="number" step={inches ? 0.5 : 1} min={lim(CUSTOM_SIZE_MIN_MM)} max={lim(CUSTOM_SIZE_MAX_MM)} value={show(p.customSize.wMm)} onChange={edit('wMm')} /><span className="unit">{inches ? 'in' : 'cm'}</span></Row>
            <Row label="Height"><input type="number" step={inches ? 0.5 : 1} min={lim(CUSTOM_SIZE_MIN_MM)} max={lim(CUSTOM_SIZE_MAX_MM)} value={show(p.customSize.hMm)} onChange={edit('hMm')} /><span className="unit">{inches ? 'in' : 'cm'}</span></Row>
            <div className="hint">Between {lim(CUSTOM_SIZE_MIN_MM)} and {lim(CUSTOM_SIZE_MAX_MM)} {inches ? 'in' : 'cm'}. Width and height are for a portrait page; use Orientation to turn it.</div>
          </>);
        })()}
        <Row label="Orientation">
          <select value={p.landscape ? 'l' : 'p'} onChange={(e) => set((x) => { x.landscape = e.target.value === 'l'; })}>
            <option value="p">Portrait</option><option value="l">Landscape</option>
          </select>
        </Row>
        <Row label="Paper"><input type="color" value={p.paper} onChange={(e) => set((x) => { x.paper = e.target.value; })} /></Row>
        <Row label="Units">
          <select value={p.units} onChange={(e) => set((x) => { x.units = e.target.value as typeof p.units; })}>
            <option value="imperial">mi / ft</option><option value="metric">km / m</option>
          </select>
        </Row>

        <PagePanel project={p} />

        <h2>North arrow</h2>
        <Row label="Show"><input type="checkbox" checked={p.north.enabled} onChange={(e) => set((x) => { x.north.enabled = e.target.checked; })} /></Row>
        {p.north.enabled && (<>
          <Row label="Style">
            <select value={p.north.style} onChange={(e) => set((x) => { x.north.style = e.target.value as NorthStyle; })}>
              <option value="arrow">North arrow</option><option value="circle">Circled arrow</option>
              <option value="compass">Compass (N E S W)</option><option value="rose">Compass rose</option>
            </select>
          </Row>
          <Row label="Position">
            <select value={p.north.corner} onChange={(e) => set((x) => { x.north.corner = e.target.value as Corner; })}>
              <option value="tl">Top left</option><option value="tr">Top right</option>
              <option value="bl">Bottom left</option><option value="br">Bottom right</option>
            </select>
          </Row>
          <Row label="Size"><input type="range" min={8} max={70} step={1} value={p.north.sizeMm} onChange={(e) => set((x) => { x.north.sizeMm = +e.target.value; })} /><span>{p.north.sizeMm} mm</span></Row>
          <Row label="Pen"><PenSelect pens={p.pens} value={p.north.pen} onChange={(id) => set((x) => { x.north.pen = id!; })} /></Row>
          <Row label="Line weight"><input type="range" min={0.1} max={1} step={0.05} value={p.north.weightMm} onChange={(e) => set((x) => { x.north.weightMm = +e.target.value; })} /></Row>
        </>)}

        <h2>Typography</h2>
        <Row label="Font">
          <select value={p.text.font} onChange={(e) => set((x) => { x.text.font = e.target.value as FontKey; })}>
            <option value="sans">Sans-serif</option><option value="serif">Serif</option>
          </select>
        </Row>
        <Row label="Tracking"><input type="range" min={0} max={0.5} step={0.01} value={p.text.trackingEm} onChange={(e) => set((x) => { x.text.trackingEm = +e.target.value; })} /></Row>
        <Row label="Align">
          <select value={p.text.align} onChange={(e) => set((x) => { x.text.align = e.target.value as Align; })}>
            <option value="left">Left</option><option value="center">Center</option><option value="right">Right</option>
          </select>
        </Row>

        <h3>Title</h3>
        <div className="field">
          <Row label="Text"><input type="text" placeholder={auto.title} value={p.text.title.value ?? ''} onChange={(e) => set((x) => { x.text.title.value = e.target.value || undefined; })} />
            <input type="checkbox" title="Show" checked={p.text.title.visible} onChange={(e) => set((x) => { x.text.title.visible = e.target.checked; })} /></Row>
          <Row label="Size (pt)"><input type="number" min={6} max={200} value={p.text.title.sizePt} onChange={(e) => set((x) => { x.text.title.sizePt = +e.target.value || 12; })} /></Row>
          <Row label="Align">
            <select value={p.text.title.align} onChange={(e) => set((x) => { x.text.title.align = e.target.value as typeof p.text.title.align; })}>
              <option value="inherit">Same as the other text</option>
              <option value="left">Left</option><option value="center">Center</option><option value="right">Right</option>
              <option value="justify">Justified (fill the width)</option>
            </select>
          </Row>
          <Row label="Style">
            <select value={p.text.title.style} onChange={(e) => set((x) => { x.text.title.style = e.target.value as typeof p.text.title.style; })}>
              <option value="fill">Filled letters</option>
              <option value="outline">Outline only</option>
              <option value="outlineFill">Outline with fill</option>
            </select>
          </Row>
          <Row label={p.text.title.style === 'fill' ? 'Pen' : 'Outline pen'}><PenSelect pens={p.pens} value={p.text.title.pen} onChange={(id) => set((x) => { x.text.title.pen = id!; })} /></Row>
          {p.text.title.style !== 'fill' && (
            <Row label="Outline weight"><input type="number" min={0.1} max={3} step={0.05} value={p.text.title.outlineMm} onChange={(e) => set((x) => { x.text.title.outlineMm = Math.max(0.1, +e.target.value || 0.35); })} /><span className="unit">mm</span></Row>
          )}
          {p.text.title.style === 'outlineFill' && (<>
            <Row label="Fill pen"><PenSelect pens={p.pens} value={p.text.title.fillPen} onChange={(id) => set((x) => { x.text.title.fillPen = id!; })} /></Row>
            <Row label="Fill (plotter)">
              <select value={p.text.title.fillDensity} onChange={(e) => set((x) => { x.text.title.fillDensity = e.target.value as typeof p.text.title.fillDensity; })}>
                <option value="solid">Solid hatching</option><option value="medium">Medium hatching</option><option value="light">Light hatching</option>
              </select>
            </Row>
          </>)}
          <PlaceRow value={p.text.title.placement} onChange={(v) => set((x) => { x.text.title.placement = v; })} />
        </div>

        <h3>Location</h3>
        <div className="field">
          <Row label="Text"><input type="text" placeholder={auto.location || 'e.g. Washington, USA'} value={p.text.location.value ?? ''} onChange={(e) => set((x) => { x.text.location.value = e.target.value || undefined; })} />
            <input type="checkbox" title="Show" checked={p.text.location.visible} onChange={(e) => set((x) => { x.text.location.visible = e.target.checked; })} /></Row>
          <Row label="Coordinates"><input type="checkbox" checked={p.text.location.showCoords} onChange={(e) => set((x) => { x.text.location.showCoords = e.target.checked; })} /></Row>
          <Row label="Size (pt)"><input type="number" min={6} max={120} value={p.text.location.sizePt} onChange={(e) => set((x) => { x.text.location.sizePt = +e.target.value || 12; })} /></Row>
          <Row label="Pen"><PenSelect pens={p.pens} value={p.text.location.pen} onChange={(id) => set((x) => { x.text.location.pen = id!; })} /></Row>
          <PlaceRow value={p.text.location.placement} onChange={(v) => set((x) => { x.text.location.placement = v; })} />
        </div>

        <h3>Map info</h3>
        <div className="field">
          <Row label="Show"><input type="checkbox" checked={p.text.info.visible} onChange={(e) => set((x) => { x.text.info.visible = e.target.checked; })} /></Row>
          <Row label="Layout">
            <select value={p.text.info.layout} onChange={(e) => set((x) => { x.text.info.layout = e.target.value as 'row' | 'column'; })}>
              <option value="row">Row</option><option value="column">Column</option>
            </select>
          </Row>
          <Row label="Size (pt)"><input type="number" min={6} max={120} value={p.text.info.sizePt} onChange={(e) => set((x) => { x.text.info.sizePt = +e.target.value || 12; })} /></Row>
          <Row label="Pen"><PenSelect pens={p.pens} value={p.text.info.pen} onChange={(id) => set((x) => { x.text.info.pen = id!; })} /></Row>
          <PlaceRow value={p.text.info.placement} onChange={(v) => set((x) => { x.text.info.placement = v; })} />
          {p.text.info.items.map((it, i) => (
            <div className="item" key={it.key}>
              <input type="checkbox" title="Show" checked={it.visible} onChange={(e) => set((x) => { x.text.info.items[i]!.visible = e.target.checked; })} />
              <input type="text" title="Label" value={it.label} onChange={(e) => set((x) => { x.text.info.items[i]!.label = e.target.value; })} />
              <input type="text" title="Value" placeholder={auto.info[it.key] || 'auto'} value={it.value ?? ''} onChange={(e) => set((x) => { x.text.info.items[i]!.value = e.target.value || undefined; })} />
              <button title="Move up" disabled={i === 0} onClick={() => set((x) => { const a = x.text.info.items; [a[i - 1], a[i]] = [a[i]!, a[i - 1]!]; })}>↑</button>
            </div>
          ))}
        </div>

        <h2>Export</h2>
        <Row label="Watermark">
          <label><input type="checkbox" checked={p.showWatermark} onChange={(e) => set((x) => { x.showWatermark = e.target.checked; })} /> Include attribution</label>
        </Row>
        {p.showWatermark && <Row label="Watermark pen"><PenSelect pens={p.pens} value={p.watermarkPen} onChange={(id) => set((x) => { x.watermarkPen = id!; })} /></Row>}
        <Row label="Paper color">
          <label><input type="checkbox" checked={paperInExport} onChange={(e) => setPaperInExport(e.target.checked)} /> Include in SVG</label>
        </Row>
        <Row label="SVG text">
          <select value={mode} onChange={(e) => setMode(e.target.value as ExportMode)}>
            <option value="print">Outlined, filled (print)</option>
            <option value="plotter">Outlined, single-line pen (plotter)</option>
            <option value="live">Live text (needs fonts)</option>
          </select>
        </Row>
        {mode === 'plotter' && (<>
          <div className="hint">
            Every line is drawn with its pen's tip width. Heavier lines are repeated side by side:{' '}
            {passes.length ? passes.map((x) => `${x.widthMm} mm = ${x.passes} passes${x.forced ? ' (kept heavier than the rest)' : ''}`).join(', ') : 'none with these pens'}.
          </div>
        </>)}
        <div className="row">
          <button className="primary" onClick={async () => {
            try {
              const out = prepareScene(scene, mode, mode === 'live' ? undefined : await loadFonts(), { pens: p.pens });
              download(`${fileBase}.svg`, sceneToSvg(out, { paper: paperInExport && mode !== 'plotter' }), 'image/svg+xml', p);
            } catch (e) {
              setErr(e instanceof Error ? e.message : 'SVG export failed');
            }
          }}>
            Download SVG (layer per color)
          </button>
        </div>
        <Row label="PNG">
          <select value={dpi} onChange={(e) => setDpi(+e.target.value)}>
            {[72, 150, 300].map((d) => <option key={d} value={d}>{d} dpi</option>)}
          </select>
          <button
            disabled={pngBusy}
            onClick={async () => {
              setPngBusy(true);
              try {
                const { blob } = await sceneToPng(scene, dpi);
                download(`${fileBase}.png`, blob, 'image/png', p);
              } catch (e) {
                setErr(e instanceof Error ? e.message : 'PNG export failed');
              } finally {
                setPngBusy(false);
              }
            }}
          >
            {pngBusy ? 'Rendering…' : 'Download PNG'}
          </button>
        </Row>
        {(() => {
          const s = pngSize(scene.widthMm, scene.heightMm, dpi);
          return <div className="hint">{s.width} × {s.height} px{s.capped ? ` (reduced to ${s.dpi} dpi, the largest this browser can render)` : ''}</div>;
        })()}
      </aside>
      <main className="stage">
        <div className="sheet" ref={sheet} style={{ cursor: region ? 'grab' : undefined }} dangerouslySetInnerHTML={{ __html: previewSvg }} />
      </main>
    </div>
  );
}
