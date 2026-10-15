import { addPen, MAX_PENS, penFor, penUsage, removePen, type Pen } from '../scene/pens';
import type { Project } from '../scene/project';
import { summarizePasses } from '../export/offset';
import type { Scene } from '../scene/types';
import { useStore } from '../store';

/** A dropdown of the palette's pens, with a swatch of the chosen color. */
export function PenSelect({ pens, value, onChange, allowDefault }: { pens: Pen[]; value: string | undefined; onChange: (id: string | undefined) => void; allowDefault?: string }) {
  const current = value === undefined ? undefined : penFor(pens, value);
  return (
    <>
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}>
        {allowDefault !== undefined && <option value="">{allowDefault}</option>}
        {pens.map((pen) => <option key={pen.id} value={pen.id}>{pen.name} ({pen.tipMm} mm)</option>)}
      </select>
      {current && <span className="swatch" style={{ background: current.color }} title={current.color} />}
    </>
  );
}

/** The pen palette: define the pens, and see which parts of the design draw with which pen. */
export function PensPanel({ project: p, scene }: { project: Project; scene: Scene }) {
  const set = useStore((s) => s.set);
  const usage = penUsage(p);
  const usedBy = (id: string) => usage.filter((u) => u.penId === id).map((u) => u.section);
  return (
    <>
      <h2>Pens</h2>
      <div className="hint">Pens are what the plotter draws with. Each part of the design picks one; its color comes from the pen, and the tip width decides how many passes a heavy line needs.</div>
      {p.pens.map((pen, i) => {
        const sections = usedBy(pen.id);
        const passes = summarizePasses(scene.prims.filter((x) => (x as { pen?: string }).pen === pen.id), pen.tipMm);
        return (
          <div className="field pen" key={pen.id}>
            <div className="penrow">
              <input type="color" value={pen.color} title="Ink color" onChange={(e) => set((x) => { x.pens[i]!.color = e.target.value; })} />
              <input type="text" value={pen.name} title="Name" onChange={(e) => set((x) => { x.pens[i]!.name = e.target.value; })} />
              <input type="number" min={0.05} max={5} step={0.05} value={pen.tipMm} title="Tip width, mm" onChange={(e) => set((x) => { x.pens[i]!.tipMm = Math.max(0.05, +e.target.value || 0.3); })} />
              <span className="unit">mm</span>
              <button title="Remove this pen (its parts move to the first pen)" disabled={p.pens.length <= 1} onClick={() => set((x) => { removePen(x, pen.id); })}>×</button>
            </div>
            <div className="hint">
              {sections.length ? sections.join(', ') : 'Not used by anything'}
              {passes.length ? ` · heavy lines: ${passes.map((q) => `${q.widthMm} mm = ${q.passes} passes`).join(', ')}` : ''}
            </div>
          </div>
        );
      })}
      <div className="row">
        <button disabled={p.pens.length >= MAX_PENS} onClick={() => set((x) => { addPen(x); })}>Add pen</button>
        <span className="hint">{p.pens.length} of {MAX_PENS}</span>
      </div>
    </>
  );
}
