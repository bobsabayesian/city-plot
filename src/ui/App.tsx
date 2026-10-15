import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useStore } from '../store';
import { parseGpx, parseWaypoints } from '../gpx/parse';
import { sampleTrack, sampleWaypoints } from '../sample';
import { describePoolItem } from '../features/format';
import { KIND_LABELS, LANDMARK_KINDS, requestCovers, requestIsEmpty, wantedRequest, type Side } from '../features/types';
import { composeScene, viewBBox, autoValues, featureView, viewSizeKm } from '../scene/buildScene';
import { computeStats } from '../geo/stats';
import { covers, loadTerrain, padBBox } from '../topo/terrain';
import { sceneToSvg } from '../export/svg';
import { pngSize, sceneToPng } from '../export/png';
import { loadFonts } from '../export/fonts';
import { SPAN_MAX_KM, SPAN_MIN_KM, wheelSpan } from './wheel';
import { prepareScene, tipFor, type ExportMode } from '../export/outlines';
import { summarizePasses } from '../export/offset';
import { PenSelect, PensPanel } from './PensPanel';
import { PagePanel } from './PagePanel';
import { FEATURE_PEN_LABELS, penFor } from '../scene/pens';
import type { FeaturePenKey } from '../features/types';
import { CUSTOM_SIZE_ID, CUSTOM_SIZE_MAX_MM, CUSTOM_SIZE_MIN_MM, PRINT_SIZES, type SizeGroup, type Corner, type NorthStyle, type Align, type FontKey, type Placement, type StrokeStyle } from '../scene/project';

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

function download(name: string, data: string | Blob, type: string) {
  const url = URL.createObjectURL(typeof data === 'string' ? new Blob([data], { type }) : data);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
}

/** The "Showing <feature>" block: hover it and use the mouse wheel to zoom (wheel up = slider left = closer). */
function FeatureStatus({ feature, onSpan }: { feature: NonNullable<ReturnType<typeof useStore.getState>['project']['feature']>; onSpan: (km: number | undefined) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, h] = viewSizeKm(featureView(feature));
  const shown = Math.min(SPAN_MAX_KM, Math.max(SPAN_MIN_KM, Math.round(w)));
  const latest = useRef(shown);
  latest.current = shown;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // A non-passive listener is needed so the page doesn't scroll while the wheel is used here.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY; // lines -> pixels
      onSpan(wheelSpan(latest.current, delta));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [onSpan]);

  return (
    <div className="found" ref={ref} title="Scroll the mouse wheel here to zoom: up zooms in, down zooms out">
      <div>Showing <b>{feature.name}</b>{feature.kind ? ` (${feature.kind})` : ''}</div>
      <div className="hint">{feature.lat.toFixed(4)}°, {feature.lon.toFixed(4)}° · view about {Math.round(w)} × {Math.round(h)} km · scroll to zoom</div>
      <Row label="View width">
        <input type="range" min={SPAN_MIN_KM} max={SPAN_MAX_KM} step={1} value={shown} onChange={(e) => onSpan(+e.target.value)} />
        <span>{shown} km</span>
        <button disabled={feature.spanKm === undefined} onClick={() => onSpan(undefined)}>Auto</button>
      </Row>
    </div>
  );
}

export function App() {
  const { project: p, set, terrain, terrainStatus, terrainError, setTerrain, loadPoints, searchResults, searchIndex, chooseResult, osm, osmStatus, osmError, loadOsm, retryOsm, searchFeature, busy, notice } = useStore();
  const [query, setQuery] = useState('');
  const [err, setErr] = useState('');
  const [over, setOver] = useState(false);
  const [paperInExport, setPaperInExport] = useState(false);
  const [mode, setMode] = useState<ExportMode>('print');
  const [dpi, setDpi] = useState(150);
  const [pngBusy, setPngBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const composed = useMemo(() => composeScene(p, terrain, osm), [p, terrain, osm]);
  const scene = composed.scene;
  // Route and elevation-profile controls only mean something once a GPX track is loaded.
  const hasTrack = p.points.length > 0;
  const need = useMemo(() => viewBBox(p), [p]);
  const auto = useMemo(() => autoValues(p, p.points.length ? computeStats(p.points) : undefined), [p]);

  // Fetch landmarks/water whenever the visible area, or what we want to show, is not covered by what we have.
  const want = useMemo(() => wantedRequest(p.features), [p.features.kinds, p.features.water, p.features.waterLabels]);
  useEffect(() => {
    if (!p.features.enabled || !need || requestIsEmpty(want)) return;
    const c = osm?.covers;
    const inside = c && need.minLat >= c.minLat && need.maxLat <= c.maxLat && need.minLon >= c.minLon && need.maxLon <= c.maxLon;
    if (inside && requestCovers(osm?.requested, want)) return;
    const t = setTimeout(() => loadOsm(padBBox(need, 0.05), want), 600);
    return () => clearTimeout(t);
  }, [need, p.features.enabled, osm, want, loadOsm]);

  // Fetch terrain whenever the visible map area is not covered by what we already have.
  useEffect(() => {
    if (!p.terrain.enabled || !need) return;
    if (terrain && covers(terrain, need)) return;
    let live = true;
    const t = setTimeout(() => {
      useStore.setState({ terrainStatus: 'loading' });
      loadTerrain(padBBox(need, 0.1))
        .then((field) => live && setTerrain(field, 'idle'))
        .catch((e) => live && setTerrain(undefined, 'error', e instanceof Error ? e.message : 'Terrain failed'));
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [need, p.terrain.enabled, terrain, setTerrain]);
  // Which line weights in this design become several passes with the chosen pen (plotter export).
  const passes = useMemo(() => summarizePasses(scene.prims, (x) => tipFor(x as { pen?: string }, { pens: p.pens })), [scene, p.pens]);
  const previewSvg = useMemo(() => sceneToSvg(scene, { paper: true }), [scene]);

  async function load(file?: File) {
    if (!file) return;
    try {
      const xml = await file.text();
      loadPoints(parseGpx(xml), true, parseWaypoints(xml));
      setErr('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not read file');
    }
  }

  return (
    <div className="app">
      <aside className="panel">
        <h1>WALK OF FRAME</h1>
        <div
          className={`drop${over ? ' over' : ''}`}
          onClick={() => input.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); load(e.dataTransfer.files[0]); }}
        >
          Drop a .gpx file here, or click to browse
          <input ref={input} type="file" accept=".gpx" hidden onChange={(e) => load(e.target.files?.[0])} />
        </div>
        <div className="row"><button onClick={() => { const t = sampleTrack(); loadPoints(t, false, sampleWaypoints(t)); }}>Use sample route</button></div>
        {err && <div className="err">{err}</div>}
        <h2>Or search a feature</h2>
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (query.trim()) searchFeature(query.trim()); }}>
          <input type="text" placeholder="e.g. Mount Rainier" value={query} onChange={(e) => setQuery(e.target.value)} />
          <button disabled={!!busy}>{busy || 'Go'}</button>
        </form>
        {notice && <div className="err">{notice}</div>}
        {searchResults.length > 0 && (
          <div className="results">
            {searchResults.map((r, i) => (
              <button key={`${r.lat},${r.lon},${i}`} className={i === searchIndex && p.feature ? 'res sel' : 'res'} onClick={() => chooseResult(i)}>
                <b>{r.name}</b>
                <span>{[r.kind, r.location].filter(Boolean).join(' · ')}</span>
              </button>
            ))}
          </div>
        )}
        {p.feature && <FeatureStatus feature={p.feature} onSpan={(km) => set((x) => { x.feature!.spanKm = km; })} />}

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

        <PensPanel project={p} scene={scene} />

        {hasTrack && (<>
        <h2>Route</h2>
        <Row label="Pen"><PenSelect pens={p.pens} value={p.route.pen} onChange={(id) => set((x) => { x.route.pen = id!; })} /></Row>
        <Row label="Weight">
          <input type="range" min={0.2} max={3} step={0.1} value={p.route.weightMm} onChange={(e) => set((x) => { x.route.weightMm = +e.target.value; })} />
          <span>{p.route.weightMm.toFixed(1)} mm</span>
        </Row>
        <Row label="Style">
          <select value={p.route.style} onChange={(e) => set((x) => { x.route.style = e.target.value as StrokeStyle; })}>
            <option value="solid">Solid</option><option value="dashed">Dashed</option><option value="dotted">Dotted</option>
          </select>
        </Row>
        </>)}

        <h2>Contours</h2>
        <Row label="Show"><input type="checkbox" checked={p.terrain.enabled} onChange={(e) => set((x) => { x.terrain.enabled = e.target.checked; })} />
          <span>{terrainStatus === 'loading' ? 'Loading terrain…' : ''}</span></Row>
        {terrainError && <div className="err">{terrainError}</div>}
        {p.terrain.enabled && (<>
          <Row label="Interval">
            <select value={p.terrain.intervalM} onChange={(e) => set((x) => { x.terrain.intervalM = +e.target.value; })}>
              <option value={0}>Auto</option>
              {[10, 20, 25, 50, 100, 200, 500].map((n) => <option key={n} value={n}>{n} m</option>)}
            </select>
          </Row>
          <Row label="Heavy every">
            <select value={p.terrain.indexEvery} onChange={(e) => set((x) => { x.terrain.indexEvery = +e.target.value; })}>
              <option value={0}>None</option>
              {[4, 5, 10].map((n) => <option key={n} value={n}>{n}th line</option>)}
            </select>
          </Row>
          <Row label="Pen"><PenSelect pens={p.pens} value={p.terrain.pen} onChange={(id) => set((x) => { x.terrain.pen = id!; })} /></Row>
          <Row label="Weight"><input type="range" min={0.05} max={0.6} step={0.01} value={p.terrain.weightMm} onChange={(e) => set((x) => { x.terrain.weightMm = +e.target.value; x.terrain.indexWeightMm = +e.target.value * 2; })} /></Row>
          <Row label="Opacity"><input type="range" min={0.1} max={1} step={0.05} value={p.terrain.opacity} onChange={(e) => set((x) => { x.terrain.opacity = +e.target.value; })} /></Row>
          {p.terrain.indexEvery > 0 && (<>
            <Row label="Number heavy lines"><input type="checkbox" checked={p.terrain.labels.enabled} onChange={(e) => set((x) => { x.terrain.labels.enabled = e.target.checked; })} /><span>elevation along the line</span></Row>
            {p.terrain.labels.enabled && (<>
              <Row label="How many">
                <select value={p.terrain.labels.density} onChange={(e) => set((x) => { x.terrain.labels.density = e.target.value as typeof p.terrain.labels.density; })}>
                  <option value="sparse">Few per line</option><option value="normal">Some per line</option><option value="dense">Many per line</option>
                </select>
              </Row>
              <Row label="Which lines">
                <select value={p.terrain.labels.every} onChange={(e) => set((x) => { x.terrain.labels.every = +e.target.value; })}>
                  <option value={1}>Every heavy line</option><option value={2}>Every 2nd heavy line</option><option value={3}>Every 3rd heavy line</option>
                </select>
              </Row>
              <Row label="Break the line"><input type="checkbox" checked={p.terrain.labels.gap} onChange={(e) => set((x) => { x.terrain.labels.gap = e.target.checked; })} /><span>gap behind each number</span></Row>
              <Row label="Number size"><input type="number" min={5} max={30} value={p.terrain.labels.sizePt} onChange={(e) => set((x) => { x.terrain.labels.sizePt = +e.target.value || 8; })} /></Row>
            </>)}
          </>)}
        </>)}

        <h2>Landmarks</h2>
        <Row label="Show">
          <input type="checkbox" checked={p.features.enabled} onChange={(e) => set((x) => { x.features.enabled = e.target.checked; })} />
          <span>{osmStatus === 'loading' ? 'Loading landmarks…' : ''}</span>
        </Row>
        {osmError && <div className="err">{osmError} <button onClick={retryOsm}>Retry</button></div>}
        {osm?.partial?.length ? (
          <div className="hint">
            {osm.partial.includes('water') ? 'Rivers and lakes are unavailable for this area right now' : 'Some landmarks are unavailable right now'}
            {' '}(OpenStreetMap servers are busy or the area is large). <button onClick={retryOsm}>Retry</button>
            {osm.reason && <div title={osm.reason}>Details: {osm.reason}</div>}
          </div>
        ) : null}
        {p.features.enabled && (<>
          <Row label="Max points"><input type="range" min={0} max={20} step={1} value={p.features.maxLabels} onChange={(e) => set((x) => { x.features.maxLabels = +e.target.value; })} /><span>{p.features.maxLabels}</span></Row>
          <Row label="Max water names"><input type="range" min={0} max={10} step={1} value={p.features.maxWaterLabels} onChange={(e) => set((x) => { x.features.maxWaterLabels = +e.target.value; })} /><span>{p.features.maxWaterLabels}</span></Row>
          <div className="kinds">
            {LANDMARK_KINDS.map((k) => (
              <label key={k}><input type="checkbox" checked={p.features.kinds[k]} onChange={(e) => set((x) => { x.features.kinds[k] = e.target.checked; })} /> {KIND_LABELS[k]}</label>
            ))}
            <label title="Draw rivers and lake shapes"><input type="checkbox" checked={p.features.water} onChange={(e) => set((x) => { x.features.water = e.target.checked; })} /> Water outlines</label>
            <label title="Write river and lake names"><input type="checkbox" checked={p.features.waterLabels} onChange={(e) => set((x) => { x.features.waterLabels = e.target.checked; })} /> Water labels</label>
          </div>
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
          {composed.landmarks?.map((l) => {
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
            const items = (composed.pool ?? []).filter((it) => it.group === group);
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
                    {items.map((it) => <option key={it.id} value={it.id}>{describePoolItem(it, p.units)}</option>)}
                  </select>
                )}
              </div>
            );
          })}
        </>)}

        {hasTrack && (<>
        <h2>Elevation profile</h2>
        <Row label="Show"><input type="checkbox" checked={p.profile.enabled} onChange={(e) => set((x) => { x.profile.enabled = e.target.checked; })} /></Row>
        {p.profile.enabled && (<>
          <Row label="Position">
            <select value={p.profile.position} onChange={(e) => set((x) => { x.profile.position = e.target.value as typeof p.profile.position; })}>
              <option value="bottom">Bottom</option><option value="corner">Bottom corner</option>
            </select>
          </Row>
          <Row label="Pen"><PenSelect pens={p.pens} value={p.profile.pen} onChange={(id) => set((x) => { x.profile.pen = id!; })} /></Row>
          <Row label="Fill (plotter)">
            <select value={p.profile.hatch} onChange={(e) => set((x) => { x.profile.hatch = e.target.value as typeof p.profile.hatch; })}>
              <option value="off">Outline only</option><option value="light">Light hatching</option><option value="medium">Medium hatching</option><option value="solid">Solid hatching</option>
            </select>
          </Row>
          <Row label="Opacity"><input type="range" min={0} max={1} step={0.02} value={p.profile.opacity} onChange={(e) => set((x) => { x.profile.opacity = +e.target.value; })} /></Row>
                  <Row label="Label peaks"><input type="checkbox" checked={p.profile.labels.extremes} onChange={(e) => set((x) => { x.profile.labels.extremes = e.target.checked; })} /><span>highest and lowest point</span></Row>
          <Row label="Elevation ticks"><input type="checkbox" checked={p.profile.labels.yTicks} onChange={(e) => set((x) => { x.profile.labels.yTicks = e.target.checked; })} /></Row>
          <Row label="Distance ticks"><input type="checkbox" checked={p.profile.labels.xTicks} onChange={(e) => set((x) => { x.profile.labels.xTicks = e.target.checked; })} /></Row>
          <Row label="Label size"><input type="number" min={5} max={30} value={p.profile.labels.sizePt} onChange={(e) => set((x) => { x.profile.labels.sizePt = +e.target.value || 9; })} /></Row>
        </>)}
        </>)}

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

        <h3>Route info</h3>
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
              download('hike-poster.svg', sceneToSvg(out, { paper: paperInExport && mode !== 'plotter' }), 'image/svg+xml');
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
                download('hike-poster.png', blob, 'image/png');
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
        <div className="sheet" dangerouslySetInnerHTML={{ __html: previewSvg }} />
      </main>
    </div>
  );
}
