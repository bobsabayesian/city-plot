import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { clampKm, useStore } from '../store';
import { saveExport } from '../lookup';
import { describePoolItem } from '../features/format';
import { ICON_LABELS, ICONS, KIND_LABELS, LANDMARK_KINDS, type Icon, type Side } from '../features/types';
import { hiddenLandmarks, unhide } from '../features/hidden';
import { composeScene, autoValues, parseLatLon, viewOf, type CityData } from '../scene/buildScene';
import { sceneToSvg } from '../export/svg';
import { pngSize, sceneToPng } from '../export/png';
import { loadFonts } from '../export/fonts';
import { prepareScene, tipFor, type ExportMode, type PlotterText } from '../export/outlines';
import { createShareLink } from '../share';
import { OpenByCode, SaveGroup, linkFor, useProjectSave } from './SaveGroup';
import { PlotPlayer } from './PlotPlayer';
import type { Scene } from '../scene/types';
import { DEFAULT_SPEED, formatDuration, formatLength, loadSpeed, planPlot, storeSpeed, type PlotterSpeed } from '../export/plan';
import { LooksGroup } from './LooksGroup';
import { RouteGroup } from './RouteGroup';
import { GridGroup } from './GridGroup';
import type { Part } from '../scene/types';
import { isDarkPaper } from '../scene/pens';
import { passCount, passWidth, summarizePasses } from '../export/offset';
import { PenSelect, PensPanel } from './PensPanel';
import { Group, Groups, NARROW_QUERY, useMediaQuery, useShowGroup } from './Group';
import { PagePanel } from './PagePanel';
import { FEATURE_PEN_LABELS, inkWidth, penFor } from '../scene/pens';
import type { FeaturePenKey } from '../features/types';
import { inverseMercator, mercator } from '../geo/project';
import { DEFAULT_WATERLINES, isAreaLayer, LANDMARKS_MAX_KM, LAYER_KEYS, LAYER_LABELS, LAYER_MAX_KM, type LayerKey, type WaterlineStyle } from '../city/types';
import { coasterPreset, MAP_SCALES, sizeShape, REGION_MAX_KM, REGION_MIN_KM, CUSTOM_SIZE_ID, CUSTOM_SIZE_MAX_MM, CUSTOM_SIZE_MIN_MM, PRINT_SIZES, type SizeGroup, type Project, type Corner, type NorthStyle, type Align, type FontKey, type Placement } from '../scene/project';

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

const THUMB_PX = 480;

/**
 * What clicking each part of the map opens: its group, a name for the action bar, and the control to focus there
 * (by default the group's header button).
 */
const PARTS: Record<Part, { group: string; label: string; focus?: string }> = {
  border: { group: 'border', label: 'Border' },
  title: { group: 'type', label: 'Title', focus: '[data-edit="title"]' },
  location: { group: 'type', label: 'Location', focus: '[data-edit="location"]' },
  info: { group: 'type', label: 'Map info', focus: '[data-edit="info"]' },
  watermark: { group: 'export', label: 'Attribution', focus: '[data-edit="watermark"]' },
  water: { group: 'layers', label: 'Water', focus: '[data-edit="layer-water"]' },
  parks: { group: 'layers', label: 'Parks', focus: '[data-edit="layer-parks"]' },
  buildings: { group: 'layers', label: 'Buildings', focus: '[data-edit="layer-buildings"]' },
  paths: { group: 'layers', label: 'Footpaths', focus: '[data-edit="layer-paths"]' },
  minor: { group: 'layers', label: 'Minor streets', focus: '[data-edit="layer-minor"]' },
  secondary: { group: 'layers', label: 'Secondary streets', focus: '[data-edit="layer-secondary"]' },
  major: { group: 'layers', label: 'Major roads', focus: '[data-edit="layer-major"]' },
  rail: { group: 'layers', label: 'Railways', focus: '[data-edit="layer-rail"]' },
  north: { group: 'north', label: 'North arrow' },
  landmarks: { group: 'landmarks', label: 'Landmarks' },
  route: { group: 'route', label: 'Memory route' },
  routeKey: { group: 'route', label: 'Route key' },
  grid: { group: 'grid', label: 'Grid' },
};

/** The part of the map under the pointer, if any: a landmark's own label first, then the part an element draws. */
function clickTarget(target: EventTarget | null): { group: string; label: string; focus: string } | undefined {
  const el = target instanceof Element ? target : null;
  const lm = el?.closest('[data-lm]');
  const id = lm?.getAttribute('data-lm');
  if (id) return { group: id.startsWith('custom-') ? 'mine' : 'landmarks', label: `Landmark: ${lm!.textContent ?? ''}`, focus: `[data-lm-input="${CSS.escape(id)}"]` };
  const part = el?.closest('[data-part]')?.getAttribute('data-part') as Part | null | undefined;
  const info = part ? PARTS[part] : undefined;
  if (!info) return undefined;
  return { group: info.group, label: info.label, focus: info.focus ?? `#group-${info.group} .group-title button` };
}

/** How many passes of the layer's pen a line thickness takes, and how thick that really draws. */
function Passes({ weightMm, tipMm }: { weightMm: number; tipMm: number }) {
  // `tipMm` here is the width one pass leaves on paper (the pen's tip plus its ink spread)
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
  const narrow = useMediaQuery(NARROW_QUERY);
  return <Groups narrow={narrow} initial={['place']}><Editor narrow={narrow} /></Groups>;
}

function Editor({ narrow }: { narrow: boolean }) {
  const { project: p, set, setRegion, searchResults, searchIndex, choosePlace, searchPlace, ensureData, retryData, addCustom, openProject, busy, notice } = useStore();
  const layerState = useStore((s) => s.layers);
  const landmarkState = useStore((s) => s.landmarks);
  const [tab, setTab] = useState<'settings' | 'map'>('settings');
  // placing a photo by hand: on a phone, show the map for the tap, then go back to the settings
  const placing = useStore((s) => s.placing);
  const wasPlacing = useRef(false);
  useEffect(() => {
    if (placing && narrow) setTab('map');
    if (!placing && wasPlacing.current && narrow) setTab('settings');
    wasPlacing.current = !!placing;
  }, [placing, narrow]);
  const [query, setQuery] = useState('');
  const [err, setErr] = useState('');
  const [paperInExport, setPaperInExport] = useState(false);
  const [mode, setMode] = useState<ExportMode>('plotter');
  const [dpi, setDpi] = useState(150);
  const [pngBusy, setPngBusy] = useState(false);
  const [svgBusy, setSvgBusy] = useState(false);
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkMsg, setLinkMsg] = useState('');
  const [exportErr, setExportErr] = useState('');
  const [plotText, setPlotText] = useState<PlotterText>('auto');
  const [plotPreview, setPlotPreview] = useState(false);
  const [plotSvg, setPlotSvg] = useState('');
  /** the scene as the plotter draws it (prepared for the Plotter preview), planned into a timed plot */
  const [plotScene, setPlotScene] = useState<Scene | null>(null);
  const [speed, setSpeedState] = useState<PlotterSpeed>(() => loadSpeed());
  const setSpeed = (edit: Partial<PlotterSpeed>) => setSpeedState((s) => { const next = { ...s, ...edit }; storeSpeed(next); return next; });
  const [watching, setWatching] = useState(false);
  const [playerSlot, setPlayerSlot] = useState<HTMLDivElement | null>(null);
  const [hovered, setHovered] = useState('');
  const [pendingEdit, setPendingEdit] = useState<string | null>(null);
  const [custom, setCustom] = useState({ name: '', where: '', icon: 'default' as Icon });
  const showGroup = useShowGroup();

  const data = useMemo<CityData>(() => ({
    layers: Object.fromEntries(LAYER_KEYS.flatMap((k) => (layerState[k]?.data ? [[k, layerState[k]!.data!]] : []))),
    landmarks: landmarkState.data?.landmarks ?? [],
  }), [layerState, landmarkState.data]);
  // Waterlines take a moment to trace, so while the view moves they wait until it has been still for a moment.
  const [restingRegion, setRestingRegion] = useState(p.region);
  useEffect(() => {
    if (restingRegion === p.region) return;
    const t = setTimeout(() => setRestingRegion(p.region), 250);
    return () => clearTimeout(t);
  }, [p.region, restingRegion]);
  const moving = restingRegion !== p.region;
  const composed = useMemo(() => composeScene(p, data, moving), [p, data, moving]);
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
  // The plotter preview: the map as the pens will draw it (hatched, passes, ink width, translucency). Slower, so it follows edits after a pause.
  useEffect(() => {
    if (!plotPreview) return;
    let live = true;
    const t = setTimeout(async () => {
      try {
        const out = prepareScene(scene, 'plotter', await loadFonts(), { pens: p.pens, plotterText: plotText });
        const svg = sceneToSvg(out, { paper: true, ink: { pens: p.pens, dark: isDarkPaper(p.paper) } });
        if (live) { setPlotSvg(svg); setPlotScene(out); }
      } catch { if (live) { setPlotSvg(''); setPlotScene(null); } }
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [plotPreview, scene, p.pens, p.paper, plotText]);
  const plan = useMemo(() => (plotPreview && plotScene ? planPlot(plotScene, p.pens, speed) : null), [plotPreview, plotScene, p.pens, speed]);
  // a changed map is a new plot: stop watching the old one
  useEffect(() => { setWatching(false); }, [plotScene, plotPreview]);
  const designSvg = useMemo(() => sceneToSvg(scene, { paper: true, ids: true }), [scene]);
  const previewSvg = plotPreview && plotSvg ? plotSvg : designSvg;

  // ---- the map in the preview: drag to move, scroll to zoom
  const hasPlace = !!p.place;
  const sheet = useRef<HTMLDivElement>(null);
  const live = useRef({ view, region: p.region, scene, edit: (_t: EventTarget | null) => {} });
  live.current = { view, region: p.region, scene, edit: (t) => editAt(t) };
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
    let press: { x: number; y: number; target: EventTarget | null } | undefined;
    const onDown = (e: PointerEvent) => {
      press = { x: e.clientX, y: e.clientY, target: e.target };
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
    const onUp = (e: PointerEvent) => {
      drag = undefined;
      el.classList.remove('dragging');
      // a press that did not move is a click: place what is waiting to be placed there, or open what was clicked
      if (press && e.type === 'pointerup' && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 4) {
        const placing = useStore.getState().placing;
        const m = toMm(e);
        if (placing && m && inFrame(m)) {
          const [lat, lon] = m.v.fit.fromMm(m.x, m.y);
          useStore.getState().setPlacing(null);
          placing.done(lat, lon);
        } else if (!placing) live.current.edit(press.target);
      }
      press = undefined;
    };
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
  }, [hasPlace]);

  const region = p.region;
  const fileBase = `city-plot-${(p.place?.name ?? 'map').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'map'}`;
  // what is kept beside a saved project: the title and place as printed, the area, and the paper size
  const saveMeta = {
    title: auto.title, place: auto.location, area: auto.info.extent,
    size: `${PRINT_SIZES.find((x) => x.id === p.sizeId)?.label ?? 'custom'}${p.landscape ? ' landscape' : ''}`,
  };
  const saveThumb = async () => (await sceneToPng(scene, (THUMB_PX / scene.widthMm) * 25.4)).blob;
  const saver = useProjectSave({ project: p, openProject, meta: saveMeta, thumb: saveThumb });
  /** the SVG as the Export settings say (plotter: a layer per pen), for download or for a link */
  const makeSvg = async () => {
    const out = prepareScene(scene, mode, mode === 'live' ? undefined : await loadFonts(), { pens: p.pens, plotterText: plotText });
    return sceneToSvg(out, { paper: paperInExport && mode !== 'plotter', ...(mode === 'plotter' ? { layers: 'pen' as const, pens: p.pens } : {}) });
  };
  const downloadSvg = async () => {
    setSvgBusy(true); setExportErr('');
    try { download(`${fileBase}.svg`, await makeSvg(), 'image/svg+xml', p); }
    catch (e) { setExportErr(e instanceof Error ? e.message : 'SVG export failed'); }
    finally { setSvgBusy(false); }
  };
  const downloadPng = async () => {
    setPngBusy(true); setExportErr('');
    try { download(`${fileBase}.png`, (await sceneToPng(scene, dpi)).blob, 'image/png', p); }
    catch (e) { setExportErr(e instanceof Error ? e.message : 'PNG export failed'); }
    finally { setPngBusy(false); }
  };
  // Click any part of the map to edit it: open its group and focus the most useful control there (a landmark
  // label focuses its own name box). Hovering names what a click would open, in the action bar.
  const editAt = (target: EventTarget | null) => {
    const hit = clickTarget(target);
    if (!hit) return;
    setTab('settings');
    showGroup(hit.group);
    setPendingEdit(hit.focus);
  };
  useEffect(() => {
    if (!pendingEdit) return;
    // wait a moment for the group to open (and on a phone, for the Settings tab to show)
    const t = setTimeout(() => {
      const el = document.querySelector<HTMLElement>(pendingEdit);
      el?.scrollIntoView?.({ block: 'center' });
      el?.focus();
      if (el instanceof HTMLInputElement && el.type === 'text') el.select();
      setPendingEdit(null);
    }, 80);
    return () => clearTimeout(t);
  }, [pendingEdit]);
  const status = (key: LayerKey): ReactNode => {
    const st = layerState[key];
    if (widest > LAYER_MAX_KM[key]) return <span className="hint">Too wide: shown at {LAYER_MAX_KM[key]} km or less across. Zoom in.</span>;
    if (st?.status === 'loading') return <span className="hint">Loading…</span>;
    if (st?.status === 'error') return <span className="err">{st.error} <button onClick={retryData}>Retry</button></span>;
    if (st?.data?.truncated) return <span className="hint">Very dense: the map server cut this layer short. Zoom in for all of it.</span>;
    return null;
  };

  const footer = (
    <footer className="notice">
      Map data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a> (ODbL), served as vector tiles by <a href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a> (© <a href="https://www.openmaptiles.org/" target="_blank" rel="noreferrer">OpenMapTiles</a>), with Overpass as a fallback. Place search by Nominatim.
    </footer>
  );

  if (!p.place) return (
    <div className="app empty">
      <main className="start" id="preview">
        <h1>City Plot</h1>
        <p className="lede">Turn a city, a landmark or an address into a pen-plotter drawing: streets, buildings, water and parks, in your own pens.</p>
        {saver.busy === 'Opening…' ? <div className="hint">Opening the saved project…</div> : (<>
          <section className="choice">
            <h2>Draw a place</h2>
            <form className="row" role="search" onSubmit={(e) => { e.preventDefault(); if (query.trim()) void searchPlace(query.trim()); }}>
              <input type="text" aria-label="Place" placeholder="City, landmark, address, or lat, lon" autoFocus value={query} onChange={(e) => setQuery(e.target.value)} />
              <button disabled={!!busy}>{busy || 'Search'}</button>
            </form>
            {notice && <div className="err">{notice}</div>}
            <div className="hint">For example Seattle, Dixie Heights High School, 10 Downing Street, or 47.62, -122.35.</div>
          </section>
          <div className="start-more">
            <div className="open">
              <span className="hint">Open a saved project</span>
              <OpenByCode s={saver} />
            </div>
          </div>
          {saver.msg?.error && <div className="err">{saver.msg.text}</div>}
        </>)}
      </main>
      {footer}
    </div>
  );

  return (
    <div className={`app${narrow ? ' narrow' : ''}`}>
      {narrow ? (
        <div className="tabs" role="tablist" aria-label="View"
          onKeyDown={(e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            const next = tab === 'settings' ? 'map' : 'settings';
            setTab(next);
            document.getElementById(`tab-${next}`)?.focus();
            e.preventDefault();
          }}>
          {(['settings', 'map'] as const).map((t) => (
            <button key={t} type="button" role="tab" id={`tab-${t}`} aria-selected={tab === t} aria-controls={t === 'settings' ? 'panel-settings' : 'preview'} tabIndex={tab === t ? 0 : -1}
              className={tab === t ? 'tab active' : 'tab'} onClick={() => setTab(t)}>
              {t === 'settings' ? 'Settings' : 'Map'}
            </button>
          ))}
        </div>
      ) : (
        <a className="skip-link" href="#preview">Skip to the map</a>
      )}
      <aside className="panel" id="panel-settings" hidden={narrow && tab !== 'settings'} {...(narrow ? { role: 'tabpanel', 'aria-labelledby': 'tab-settings' } : {})}>
        <h1>City Plot</h1>
        <p className="about-link">Pen-plotter maps from OpenStreetMap</p>
        <Group id="place" title="Place">
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (query.trim()) void searchPlace(query.trim()).then(() => { if (narrow && !useStore.getState().notice) setTab('map'); }); }}>
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
        </Group>

        {region && view && (<>
        <Group id="region" title="Region">
          <div className="hint">Drag the map to move it. Scroll over it to zoom. The area follows the page shape, so a taller page shows more north to south.</div>
          <Row label="Scale">
            <select value={region.scale ?? ''} data-edit="scale" onChange={(e) => {
              const s = +e.target.value;
              // a fixed scale: the width follows the map frame (the scene works it out; this keeps the slider in step)
              setRegion(s ? { scale: s, widthKm: +((view.frame.w * s) / 1e6).toFixed(3) } : { scale: undefined, widthKm: view.widthKm });
            }}>
              <option value="">Free · 1:{view.scale.toLocaleString('en-US')}</option>
              {MAP_SCALES.map((s) => <option key={s} value={s}>1:{s.toLocaleString('en-US')}</option>)}
            </select>
          </Row>
          {region.scale
            ? <div className="hint">Fixed at 1:{region.scale.toLocaleString('en-US')}: 1 cm on paper is {fmtKm(region.scale / 1e5)} on the ground, whatever the page size. Zooming the map or moving the width lets go of it.</div>
            : null}
          <Row label="Width">
            <input type="range" min={Math.log(REGION_MIN_KM)} max={Math.log(REGION_MAX_KM)} step={0.01} value={Math.log(view.widthKm)} onChange={(e) => setRegion({ widthKm: +Math.exp(+e.target.value).toFixed(3) })} />
            <span>{fmtKm(view.widthKm)}</span>
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
        </Group>
        </>)}

        <LooksGroup />

        <Group id="layers" title="Map layers">
        <div className="hint">Each layer is drawn with one of your pens. A line is drawn as passes of the pen side by side, overlapping by 20%, so its thickness is whole passes: a 0.3 mm pen draws 0.3, 0.54, 0.78, 1.02 mm… Anything thinner than the pen is one pass.</div>
        {[...LAYER_KEYS].reverse().map((key) => {
          const st = p.layers[key];
          const pen = penFor(p.pens, st.pen);
          return (
            <div className="field" key={key}>
              <Row label={LAYER_LABELS[key]}>
                <input type="checkbox" data-edit={`layer-${key}`} checked={st.enabled} onChange={(e) => set((x) => { x.layers[key].enabled = e.target.checked; })} />
                {st.enabled && <Passes weightMm={st.weightMm} tipMm={inkWidth(pen)} />}
              </Row>
              {st.enabled && (<>
                <Row label="Pen"><PenSelect pens={p.pens} value={st.pen} onChange={(id) => set((x) => { x.layers[key].pen = id!; })} /></Row>
                <Row label="Thickness"><Weight value={st.weightMm} tipMm={inkWidth(pen)} onChange={(mm) => set((x) => { x.layers[key].weightMm = mm; })} /><span className="unit">mm</span></Row>
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
                {key === 'water' && (() => {
                  const wl = st.waterlines ?? DEFAULT_WATERLINES;
                  const setWl = (edit: (w: WaterlineStyle) => void) => set((x) => { const w = { ...(x.layers.water.waterlines ?? DEFAULT_WATERLINES) }; edit(w); x.layers.water.waterlines = w; });
                  return (<>
                    <Row label="Waterlines">
                      <input type="range" min={0} max={16} step={1} value={wl.count} data-edit="waterlines" onChange={(e) => setWl((w) => { w.count = +e.target.value; })} />
                      <span className="unit">{wl.count ? wl.count : 'Off'}</span>
                    </Row>
                    {wl.count > 0 && (<>
                      <Row label="First gap">
                        <input type="number" min={0.3} max={10} step={0.1} value={wl.gapMm} onChange={(e) => setWl((w) => { w.gapMm = Math.min(10, Math.max(0.3, +e.target.value || DEFAULT_WATERLINES.gapMm)); })} /><span className="unit">mm</span>
                      </Row>
                      <Row label="Spread">
                        <input type="range" min={0} max={0.8} step={0.05} value={wl.widen} onChange={(e) => setWl((w) => { w.widen = +e.target.value; })} />
                        <span className="unit">{Math.round(wl.widen * 100)}%</span>
                      </Row>
                      <div className="hint">Lines that follow the shore out into the water, like an engraved chart, drawn in one pass of the water pen. Each gap is wider than the one before by the spread.{st.fill !== 'off' ? ' They read best with the fill set to Outline only.' : ''}</div>
                    </>)}
                  </>);
                })()}
              </>)}
              {st.enabled && status(key)}
            </div>
          );
        })}
        </Group>

        <Group id="landmarks" title="Landmarks" toggle={{ on: p.features.enabled, onChange: (on) => set((x) => { x.features.enabled = on; }), status: landmarkState.status === 'loading' ? 'Loading…' : undefined }}>
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
          <Row label="Clear paper">
            <input type="range" min={0} max={6} step={0.25} value={p.features.clearMm} onChange={(e) => set((x) => { x.features.clearMm = +e.target.value; })} />
            <span>{p.features.clearMm ? `${p.features.clearMm} mm` : 'off'}</span>
          </Row>
          <div className="hint">Map lines are cut away this far around each label and its marker, so the name can be read.</div>
          <details className="overrides">
            <summary>Marker for each kind</summary>
            {LANDMARK_KINDS.filter((k) => k !== 'custom').map((k) => (
              <Row key={k} label={KIND_LABELS[k]}>
                <select value={p.features.icons[k] ?? 'default'} onChange={(e) => set((x) => { if (e.target.value === 'default') delete x.features.icons[k]; else x.features.icons[k] = e.target.value as Icon; })}>
                  {ICONS.map((i) => <option key={i} value={i}>{ICON_LABELS[i]}</option>)}
                </select>
              </Row>
            ))}
          </details>
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
            const isWater = l.kind === 'lake' || l.kind === 'river';
            return (
              <div className="lm2" key={l.id}>
                <input type="checkbox" title="Show" checked={!l.hidden} onChange={(e) => edit({ hidden: !e.target.checked })} />
                <input type="text" className="name" data-lm-input={l.id} title={KIND_LABELS[l.kind]} value={ov.name ?? l.name} onChange={(e) => edit({ name: e.target.value })} />
                <div className="opts">
                  <select title="Label side" value={ov.side ?? 'auto'} disabled={isWater} onChange={(e) => edit({ side: e.target.value as Side })}>
                    <option value="auto">Auto</option><option value="right">Right</option><option value="left">Left</option>
                    <option value="above">Above</option><option value="below">Below</option>
                  </select>
                  {!isWater && (
                    <select title="Marker" value={ov.icon ?? 'default'} onChange={(e) => edit({ icon: e.target.value === 'default' ? undefined : (e.target.value as Icon) })}>
                      {ICONS.map((i) => <option key={i} value={i}>{i === 'default' ? 'Marker: kind’s' : ICON_LABELS[i]}</option>)}
                    </select>
                  )}
                  <input type="number" min={0} max={12} step={0.5} title="Clear paper around this label, mm (blank = the general setting)" placeholder={String(p.features.clearMm)} value={ov.clearMm ?? ''} onChange={(e) => edit({ clearMm: e.target.value === '' ? undefined : Math.max(0, +e.target.value) })} />
                  {!l.placed && !l.hidden && <span className="hint" title="No room for this label">no room</span>}
                </div>
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
          {(() => {
            const known = [
              ...(data.landmarks ?? []).map((l) => ({ id: l.id, name: l.name, kind: l.kind as import('../features/types').LabelKind })),
              ...(composed.pool ?? []).map((it) => ({ id: it.id, name: it.name, kind: it.kind })),
              ...(composed.landmarks ?? []).map((l) => ({ id: l.id, name: l.name, kind: l.kind })),
            ];
            const list = hiddenLandmarks(
              Object.fromEntries(Object.entries(p.features.overrides).filter(([id]) => !id.startsWith('custom-'))),
              (composed.landmarks ?? []).map((l) => l.id), known);
            if (!list.length) return null;
            return (
              <details className="hidden-lms">
                <summary>Hidden ({list.length})</summary>
                {list.map((h) => (
                  <div className="hidden-lm" key={h.id}>
                    <span>{h.name ?? 'A landmark not in view'}{h.kind ? ` · ${KIND_LABELS[h.kind].toLowerCase().replace(/s$/, '')}` : ''}</span>
                    <button type="button" onClick={() => set((x) => { x.features.overrides[h.id] = unhide(x.features.overrides[h.id]); })}>Show</button>
                  </div>
                ))}
                {list.length > 1 && <button type="button" onClick={() => set((x) => { for (const h of list) x.features.overrides[h.id] = unhide(x.features.overrides[h.id]); })}>Show all</button>}
              </details>
            );
          })()}
        </>)}
        </Group>

        <Group id="mine" title="My landmarks">
        <div className="hint">Mark your own places, like home. Give an address (or a place name) or latitude, longitude. A place you search for is added here, switched off; tick it to mark it on the map.</div>
        <form className="field" onSubmit={async (e) => {
          e.preventDefault();
          if (!custom.where.trim()) return;
          if (await addCustom(custom.name, custom.where.trim(), custom.icon)) setCustom({ ...custom, name: '', where: '' });
        }}>
          <Row label="Name"><input type="text" placeholder="Home" value={custom.name} onChange={(e) => setCustom({ ...custom, name: e.target.value })} /></Row>
          <Row label="Where"><input type="text" placeholder="123 Main St, Seattle  or  47.62, -122.35" value={custom.where} onChange={(e) => setCustom({ ...custom, where: e.target.value })} /></Row>
          <Row label="Marker">
            <select value={custom.icon} onChange={(e) => setCustom({ ...custom, icon: e.target.value as Icon })}>
              {ICONS.filter((i) => i !== 'none').map((i) => <option key={i} value={i}>{i === 'default' ? 'Bullseye' : ICON_LABELS[i]}</option>)}
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
                <input type="text" data-lm-input={c.id} value={c.name} onChange={(e) => set((x) => { x.custom[i]!.name = e.target.value; })} />
                <button title="Remove" onClick={() => set((x) => { x.custom.splice(i, 1); })}>×</button></Row>
              <Row label="Marker">
                <select value={c.icon ?? 'default'} onChange={(e) => set((x) => { x.custom[i]!.icon = e.target.value as Icon; })}>
                  {ICONS.filter((k) => k !== 'none').map((k) => <option key={k} value={k}>{k === 'default' ? 'Bullseye' : ICON_LABELS[k]}</option>)}
                </select>
                <button title="Move the map here" onClick={() => setRegion({ lat: c.lat, lon: c.lon })}>Center</button>
              </Row>
              {(() => {
                const ov = p.features.overrides[c.id] ?? {};
                const edit = (patch: Partial<typeof ov>) => set((x) => { x.features.overrides[c.id] = { ...x.features.overrides[c.id], ...patch }; });
                return (<>
                  <Row label="Label">
                    <select value={ov.side ?? 'auto'} disabled={!!ov.noLabel || !!ov.noMarker} title="Where the name goes" onChange={(e) => edit({ side: e.target.value as Side })}>
                      <option value="auto">Auto</option><option value="right">Right</option><option value="left">Left</option>
                      <option value="above">Above</option><option value="below">Below</option>
                    </select>
                    <input type="number" min={4} max={60} placeholder={String(p.features.sizePt)} title="Text size, pt" style={{ maxWidth: 58 }} value={ov.sizePt ?? ''} onChange={(e) => edit({ sizePt: +e.target.value > 0 ? +e.target.value : undefined })} />
                    <span className="unit">pt</span>
                    <input type="number" min={0} max={12} step={0.5} placeholder={String(p.features.clearMm)} title="Clear paper around this label, mm (blank = the general setting)" style={{ maxWidth: 58 }} value={ov.clearMm ?? ''} onChange={(e) => edit({ clearMm: e.target.value === '' ? undefined : Math.max(0, +e.target.value) })} />
                    <span className="unit">mm clear</span>
                  </Row>
                  <div className="kinds">
                    <label><input type="checkbox" checked={!ov.noLabel} onChange={(e) => edit({ noLabel: !e.target.checked, ...(e.target.checked ? {} : { noMarker: false }) })} /> Name</label>
                    <label><input type="checkbox" checked={!ov.noMarker} onChange={(e) => edit({ noMarker: !e.target.checked, ...(e.target.checked ? {} : { noLabel: false }) })} /> Marker</label>
                  </div>
                </>);
              })()}
              <div className="hint">{c.lat.toFixed(5)}, {c.lon.toFixed(5)}{p.features.overrides[c.id]?.hidden ? ' · not shown' : region && !placed ? ' · outside the map, or no room for its label' : ''}</div>
            </div>
          );
        })}
        </Group>

        <RouteGroup bbox={view?.bbox} />

        {region && view && <GridGroup scale={view.scale} lat={region.lat} lon={region.lon} />}

        <Group id="north" title="North arrow" toggle={{ on: p.north.enabled, onChange: (on) => set((x) => { x.north.enabled = on; }) }}>
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
        </Group>

        <Group id="type" title="Typography">
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
          <Row label="Text"><input type="text" data-edit="title" placeholder={auto.title} value={p.text.title.value ?? ''} onChange={(e) => set((x) => { x.text.title.value = e.target.value || undefined; })} />
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
          <Row label="Text"><input type="text" data-edit="location" placeholder={auto.location || 'e.g. Washington, USA'} value={p.text.location.value ?? ''} onChange={(e) => set((x) => { x.text.location.value = e.target.value || undefined; })} />
            <input type="checkbox" title="Show" checked={p.text.location.visible} onChange={(e) => set((x) => { x.text.location.visible = e.target.checked; })} /></Row>
          <Row label="Coordinates"><input type="checkbox" checked={p.text.location.showCoords} onChange={(e) => set((x) => { x.text.location.showCoords = e.target.checked; })} /></Row>
          <Row label="Size (pt)"><input type="number" min={6} max={120} value={p.text.location.sizePt} onChange={(e) => set((x) => { x.text.location.sizePt = +e.target.value || 12; })} /></Row>
          <Row label="Pen"><PenSelect pens={p.pens} value={p.text.location.pen} onChange={(id) => set((x) => { x.text.location.pen = id!; })} /></Row>
          <PlaceRow value={p.text.location.placement} onChange={(v) => set((x) => { x.text.location.placement = v; })} />
        </div>

        <h3>Map info</h3>
        <div className="field">
          <Row label="Show"><input type="checkbox" data-edit="info" checked={p.text.info.visible} onChange={(e) => set((x) => { x.text.info.visible = e.target.checked; })} /></Row>
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

        </Group>

        <Group id="size" title="Print size">
        <Row label="Size">
          <select value={p.sizeId} onChange={(e) => set((x) => { x.sizeId = e.target.value; if (sizeShape(x)) coasterPreset(x); })}>
            {(['US (inches)', 'ISO (A series)', 'Metric (cm)', 'Coasters'] as SizeGroup[]).map((g) => (
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
        {sizeShape(p) && <div className="hint">Coaster: the map is cut to the {sizeShape(p)!.shape === 'circle' ? 'circle' : 'rounded rectangle'}, and the text blocks and attribution are switched off to make room. Margins are set to 5 mm. Turn the title back on under Typography if you want it. The map data is © OpenStreetMap contributors, so credit it on the product.</div>}
        <Row label="Orientation">
          <select value={p.landscape ? 'l' : 'p'} onChange={(e) => set((x) => { x.landscape = e.target.value === 'l'; })}>
            <option value="p">Portrait</option><option value="l">Landscape</option>
          </select>
        </Row>
        <Row label="Units">
          <select value={p.units} onChange={(e) => set((x) => { x.units = e.target.value as typeof p.units; })}>
            <option value="imperial">mi / ft</option><option value="metric">km / m</option>
          </select>
        </Row>
        </Group>

        <PagePanel project={p} />

        <PensPanel project={p} scene={scene} />

        <Group id="export" title="Export">
        <Row label="Watermark">
          <label><input type="checkbox" data-edit="watermark" checked={p.showWatermark} onChange={(e) => set((x) => { x.showWatermark = e.target.checked; })} /> Include attribution</label>
        </Row>
        {p.showWatermark && <Row label="Watermark pen"><PenSelect pens={p.pens} value={p.watermarkPen} onChange={(id) => set((x) => { x.watermarkPen = id!; })} /></Row>}
        <Row label="Paper color">
          <label><input type="checkbox" checked={paperInExport} onChange={(e) => setPaperInExport(e.target.checked)} /> Include in SVG</label>
        </Row>
        <Row label="SVG for">
          <select value={mode} onChange={(e) => setMode(e.target.value as ExportMode)}>
            <option value="plotter">Pen plotter: a layer per pen, lines only</option>
            <option value="print">Print or design: filled shapes, a layer per color</option>
            <option value="live">Design with live text (needs fonts)</option>
          </select>
        </Row>
        {mode === 'plotter' && (<>
          <Row label="Text">
            <select value={plotText} onChange={(e) => setPlotText(e.target.value as PlotterText)}>
              <option value="auto">Single strokes for small text, filled letters for large</option>
              <option value="single">Single strokes for all text</option>
              <option value="outline">Outlined and filled letters for all text</option>
            </select>
          </Row>
          <div className="hint">Single strokes draw each letter as a few lines of the pen: fast, and small labels stay readable. Filled letters are outlined and hatched: heavier, but small ones clot with a wide pen.</div>
          <div className="hint">
            One layer per pen, named after it and in the order of the Pens list, so a layer is a pen to load. Nothing is filled: shapes and letters are outlined, and filled with hatch lines in the same pen. Every line is drawn with the width one pass of its pen leaves. Thicker lines are repeated side by side:{' '}
            {passes.length ? passes.map((x) => `${x.widthMm} mm = ${x.passes} passes${x.forced ? ' (kept heavier than the rest)' : ''}`).join(', ') : 'none with these pens'}.
          </div>
        </>)}
        <h3>Plot time</h3>
        <div className="hint">For the time estimate and the playback in the Plotter preview. Kept in this browser: they describe your plotter, not the map.</div>
        <Row label="Drawing"><input type="number" min={1} max={2000} step={5} value={speed.drawMmS} onChange={(e) => setSpeed({ drawMmS: Math.min(2000, Math.max(1, +e.target.value || DEFAULT_SPEED.drawMmS)) })} /><span className="unit">mm/s</span></Row>
        <Row label="Pen up"><input type="number" min={1} max={2000} step={10} value={speed.travelMmS} onChange={(e) => setSpeed({ travelMmS: Math.min(2000, Math.max(1, +e.target.value || DEFAULT_SPEED.travelMmS)) })} /><span className="unit">mm/s</span></Row>
        <Row label="Pen lift"><input type="number" min={0} max={10} step={0.05} value={speed.liftS} onChange={(e) => setSpeed({ liftS: Math.min(10, Math.max(0, +e.target.value || 0)) })} /><span className="unit">s</span></Row>
        <Row label="Pen swap"><input type="number" min={0} max={3600} step={10} value={speed.swapS} onChange={(e) => setSpeed({ swapS: Math.min(3600, Math.max(0, +e.target.value || 0)) })} /><span className="unit">s</span></Row>
        {plan
          ? <div className="hint">{formatDuration(plan.totalS)}: {formatLength(plan.drawMm)} of line, {formatLength(plan.travelMm)} of pen-up travel, {plan.lifts.toLocaleString('en-US')} pen lifts{plan.swaps ? `, ${plan.swaps} pen ${plan.swaps === 1 ? 'swap' : 'swaps'}` : ''}. Lines are sorted to keep pen-up travel short, as plotting software does.</div>
          : <div className="hint">Switch the preview to Plotter to see how long this map takes to plot.</div>}
        <Row label="PNG">
          <select value={dpi} onChange={(e) => setDpi(+e.target.value)}>
            {[72, 150, 300].map((d) => <option key={d} value={d}>{d} dpi</option>)}
          </select>
        </Row>
        {(() => {
          const sz = pngSize(scene.widthMm, scene.heightMm, dpi);
          return <div className="hint">{sz.width} × {sz.height} px{sz.capped ? ` (reduced to ${sz.dpi} dpi, the largest this browser can render)` : ''}</div>;
        })()}
        <div className="hint">Download the SVG and PNG from the bar above the map; they follow these settings.</div>
        <div className="row">
          <button type="button" disabled={linkBusy} title="Put this SVG on the server and copy a link to it that works for one hour, to open it on another computer" onClick={async () => {
            setLinkBusy(true); setLinkMsg('Making the link…');
            try {
              const { url, expiresAt } = await createShareLink(await makeSvg());
              const until = new Date(expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
              try { await navigator.clipboard.writeText(url); setLinkMsg(`Link copied. Works until ${until}.`); } catch { setLinkMsg(`${url} (works until ${until})`); }
            } catch (e) {
              setLinkMsg(e instanceof Error ? e.message : 'Could not make the link.');
            } finally { setLinkBusy(false); }
          }}>Copy 1-hour link</button>
        </div>
        {linkMsg && <div className="hint">{linkMsg}</div>}
        </Group>

        <SaveGroup s={saver} />
      </aside>
      <main className="main" id="preview" tabIndex={-1} hidden={narrow && tab !== 'map'} {...(narrow ? { role: 'tabpanel', 'aria-labelledby': 'tab-map' } : {})}>
        <div className="actionbar">
          <div className="bar">
            <span className="seg" role="radiogroup" aria-label="Preview">
              <button type="button" role="radio" aria-checked={!plotPreview} className={plotPreview ? '' : 'on'} title="The design, with click-to-edit labels" onClick={() => setPlotPreview(false)}>Design</button>
              <button type="button" role="radio" aria-checked={plotPreview} className={plotPreview ? 'on' : ''} title="How the pens will draw it: hatched fills, passes, ink width and translucency" onClick={() => setPlotPreview(true)}>Plotter</button>
            </span>
            <span className="bar-status hint" aria-live="polite">{plotPreview ? (plan ? <>
              <span title={`${formatLength(plan.drawMm)} of line, ${formatLength(plan.travelMm)} of pen-up travel, ${plan.lifts.toLocaleString('en-US')} pen lifts. Plotter speeds are under Export.`}>
                {formatDuration(plan.totalS)} to plot · {plan.pens.length} {plan.pens.length === 1 ? 'pen' : 'pens'}{plan.swaps ? `, ${plan.swaps} ${plan.swaps === 1 ? 'swap' : 'swaps'}` : ''}
              </span>{' '}
              {!watching && plan.pens.length > 0 && <button type="button" className="link" onClick={() => setWatching(true)}>▶ Watch it plot</button>}
            </> : plotSvg ? 'Click-to-edit is off here' : 'Drawing…') : hovered ? `Click to edit: ${hovered}` : region ? 'Drag to move, scroll to zoom, click a part to edit it' : 'Search for a place to start'}</span>
            <span className="bar-actions">
              {saver.mine && saver.code && (
                <button type="button" disabled={!!saver.busy} onClick={() => void saver.save(true)} title={`Replace the saved copy under ${saver.code}: the same code and link, with these changes`}>
                  {saver.busy === 'Saving…' ? 'Saving…' : saver.changed ? 'Save over*' : 'Save over'}
                </button>
              )}
              <button type="button" disabled={!!saver.busy || !p.place} onClick={() => void saver.save()} title="Save the whole map under a new code you can open again">
                {saver.busy === 'Saving…' && !saver.mine ? 'Saving…' : saver.mine ? 'Save as new' : saver.changed ? 'Save*' : 'Save'}
              </button>
              <button type="button" className="primary" disabled={svgBusy || !p.place} onClick={() => void downloadSvg()}
                title={`${mode === 'plotter' ? 'Pen plotter SVG: a layer per pen, lines only' : mode === 'print' ? 'SVG for print or design: filled shapes, a layer per color' : 'SVG with live text'}. Change it under Export.`}>
                {svgBusy ? 'Preparing…' : `SVG · ${mode === 'plotter' ? 'plotter' : mode === 'print' ? 'print' : 'live text'}`}
              </button>
              <button type="button" disabled={pngBusy || !p.place} onClick={() => void downloadPng()} title={`PNG at ${dpi} dpi. Change it under Export.`}>
                {pngBusy ? 'Rendering…' : `PNG · ${dpi} dpi`}
              </button>
            </span>
          </div>
          <div ref={setPlayerSlot} />
          {exportErr && <div className="err" role="alert">{exportErr}</div>}
          {!exportErr && saver.msg && (
            <div className={saver.msg.error ? 'err' : 'hint'} role={saver.msg.error ? 'alert' : 'status'}>
              {saver.msg.text}
              {!saver.msg.error && saver.code && <> <button type="button" className="link" onClick={() => saver.copy(linkFor(saver.code))}>Copy link</button></>}
            </div>
          )}
        </div>
        <div className="stage">
          {placing && (
            <div className="placing" role="status">
              <span>Tap the map where <b>{placing.label}</b> was taken.</span>
              <button type="button" onClick={() => useStore.getState().setPlacing(null)}>Cancel</button>
            </div>
          )}
          <div className="sheet" ref={sheet} role="img" aria-label="Preview of the map" style={{ cursor: placing ? 'crosshair' : region ? 'grab' : undefined, ...sheetShape(scene) }}
            onMouseOver={(e) => setHovered(plotPreview ? '' : clickTarget(e.target)?.label ?? '')} onMouseLeave={() => setHovered('')} dangerouslySetInnerHTML={{ __html: previewSvg }} />
          {watching && plan && (
            <PlotPlayer key={plan.totalS} plan={plan} sheet={sheet} controls={playerSlot} widthMm={scene.widthMm} paper={p.paper} dark={isDarkPaper(p.paper)} onClose={() => setWatching(false)} />
          )}
        </div>
      </main>
      {footer}
    </div>
  );
}

/** The preview's outline for a coaster: the sheet itself is round or rounded, not just the paper drawn in it. */
function sheetShape(scene: { widthMm: number; heightMm: number; shape?: { kind: 'circle' } | { kind: 'roundrect'; radiusMm: number } }) {
  const sh = scene.shape;
  if (!sh) return {};
  const borderRadius = sh.kind === 'circle' ? '50%' : `${(sh.radiusMm / scene.widthMm) * 100}% / ${(sh.radiusMm / scene.heightMm) * 100}%`;
  return { borderRadius, overflow: 'hidden' as const };
}
