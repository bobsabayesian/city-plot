import { clampMargins, posterMm, type Margins, type Project } from '../scene/project';
import { borderExtent } from '../scene/border';
import { PenSelect } from './PensPanel';
import { useStore } from '../store';

const SIDES: { key: keyof Margins; label: string }[] = [
  { key: 'top', label: 'Top' }, { key: 'right', label: 'Right' }, { key: 'bottom', label: 'Bottom' }, { key: 'left', label: 'Left' },
];

/** Margin values are stored in mm; shown in inches or mm to match the poster's units. */
export const marginToUnits = (mm: number, units: Project['units']) => (units === 'imperial' ? +(mm / 25.4).toFixed(3) : +mm.toFixed(1));
export const marginFromUnits = (v: number, units: Project['units']) => Math.max(0, (units === 'imperial' ? v * 25.4 : v) || 0);

/** Page margins: how far the content stays from the paper edge, per side or all together. */
export function PagePanel({ project: p }: { project: Project }) {
  const set = useStore((s) => s.set);
  const { w, h } = posterMm(p);
  const reach = borderExtent(p.border);
  const m = p.page.margins;
  const used = clampMargins({ top: m.top + reach, right: m.right + reach, bottom: m.bottom + reach, left: m.left + reach }, w, h);
  const unit = p.units === 'imperial' ? 'in' : 'mm';
  const step = p.units === 'imperial' ? 0.05 : 1;
  const clamped = SIDES.some(({ key }) => Math.abs(used[key] - p.page.margins[key] - reach) > 0.01);

  const setSide = (key: keyof Margins, v: number) =>
    set((x) => {
      const mm = marginFromUnits(v, x.units);
      if (x.page.linked) x.page.margins = { top: mm, right: mm, bottom: mm, left: mm };
      else x.page.margins[key] = mm;
    });

  return (
    <>
      <h2>Page margin</h2>
      <div className="row">
        <label><input type="checkbox" checked={p.page.linked} onChange={(e) => set((x) => {
          x.page.linked = e.target.checked;
          if (e.target.checked) { const v = x.page.margins.top; x.page.margins = { top: v, right: v, bottom: v, left: v }; }
        })} /> Same on all sides</label>
      </div>
      {(p.page.linked ? [SIDES[0]!] : SIDES).map(({ key, label }) => (
        <div className="row" key={key}>
          <label>{p.page.linked ? 'All sides' : label}</label>
          <input type="number" min={0} step={step} value={marginToUnits(p.page.margins[key], p.units)} onChange={(e) => setSide(key, +e.target.value)} />
          <span className="unit">{unit}</span>
        </div>
      ))}
      <div className="hint">
        {p.border.enabled ? 'Space between the inside of the border and the map and text. ' : 'Distance from the paper edge to the map and text. '}Margins stay the same when you change the poster size.
        {clamped ? ' Reduced to leave room for the content (at least 20% of the page each way).' : ''}
      </div>
      <h2>Border margin</h2>
      <div className="row">
        <label><input type="checkbox" checked={p.border.enabled} onChange={(e) => set((x) => { x.border.enabled = e.target.checked; })} /> Draw a border</label>
      </div>
      {p.border.enabled && (() => {
        return (<>
          <div className="row">
            <label>Style</label>
            <select value={p.border.style} onChange={(e) => set((x) => { x.border.style = e.target.value as 'single' | 'double'; })}>
              <option value="single">Single line</option><option value="double">Double line</option>
            </select>
          </div>
          <div className="row">
            <label>Border margin</label>
            <input type="number" min={0} step={step} value={marginToUnits(p.border.offsetMm, p.units)} onChange={(e) => set((x) => { x.border.offsetMm = marginFromUnits(+e.target.value, x.units); })} />
            <span className="unit">{unit}</span>
          </div>
          {p.border.style === 'double' && (
            <div className="row">
              <label>Gap between</label>
              <input type="number" min={0} step={step / 2} value={marginToUnits(p.border.gapMm, p.units)} onChange={(e) => set((x) => { x.border.gapMm = marginFromUnits(+e.target.value, x.units); })} />
              <span className="unit">{unit}</span>
            </div>
          )}
          <div className="row">
            <label>Line weight</label>
            <input type="number" min={0.1} max={3} step={0.1} value={p.border.weightMm} onChange={(e) => set((x) => { x.border.weightMm = Math.max(0.1, +e.target.value || 0.5); })} />
            <span className="unit">mm</span>
          </div>
          <div className="row"><label>Pen</label><PenSelect pens={p.pens} value={p.border.pen} onChange={(id) => set((x) => { x.border.pen = id!; })} /></div>
          <div className="hint">Distance from the paper edge to the border. The page margin is measured from inside it.</div>
        </>);
      })()}
    </>
  );
}
