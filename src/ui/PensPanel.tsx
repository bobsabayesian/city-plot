import { useState } from 'react';
import { addPen, applySavedPen, contrast, inkWidth, isDarkPaper, loadSavedPens, MAX_PENS, MIN_INK_CONTRAST, PEN_KINDS, penFor, penKind, penSlots, penUsage, PAPER_COLORS, removePen, savedFromPen, storeSavedPens, withKind, withSavedPen, type Pen, type SavedPen } from '../scene/pens';
import type { Project } from '../scene/project';
import { summarizePasses } from '../export/offset';
import type { Scene } from '../scene/types';
import { useStore } from '../store';
import { Group, useShowGroup } from './Group';

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

/**
 * The paper and the pen palette: choose the paper, define the pens, and see and change which part of the design draws
 * with which pen, all in one place. Each part's name opens its own group of settings.
 */
export function PensPanel({ project: p, scene }: { project: Project; scene: Scene }) {
  const set = useStore((s) => s.set);
  const showGroup = useShowGroup();
  const usage = penUsage(p);
  const usedBy = (id: string) => usage.filter((u) => u.penId === id).map((u) => u.section);
  const [library, setLibrary] = useState<SavedPen[]>(() => loadSavedPens());
  const keep = (next: SavedPen[]) => { setLibrary(next); storeSavedPens(next); };
  const dark = isDarkPaper(p.paper);
  return (
    <Group id="pens" title="Pens and paper">
      <div className="row">
        <label>Paper</label>
        <span className="swatches" role="radiogroup" aria-label="Paper color">
          {PAPER_COLORS.map((c) => (
            <button key={c.color} type="button" role="radio" aria-checked={c.color === p.paper.toLowerCase()} aria-label={c.name} title={c.name}
              className={c.color === p.paper.toLowerCase() ? 'chip active' : 'chip'} style={{ background: c.color }} onClick={() => set((x) => { x.paper = c.color; })} />
          ))}
        </span>
        <input type="color" title="Any paper color" aria-label="Any paper color" value={p.paper} onChange={(e) => set((x) => { x.paper = e.target.value; })} />
      </div>
      {dark && <div className="hint">Dark paper: a light ink or a paint marker shows up on it; a dark ink will not. Pens that are hard to see are marked below.</div>}
      <h3>Pens</h3>
      <div className="hint">Define the pens you will plot with (isograph nibs, black, green and blue to start). Every part of the map picks one of them: its color comes from the pen, and the width one pass leaves (the nib plus the ink's spread) decides how many passes a thick line takes. Passes overlap by 20%.</div>
      {p.pens.map((pen, i) => {
        const sections = usedBy(pen.id);
        const kind = penKind(pen.kind);
        const ink = inkWidth(pen);
        const passes = summarizePasses(scene.prims.filter((x) => (x as { pen?: string }).pen === pen.id), ink);
        const faint = sections.length > 0 && contrast(pen.color, p.paper) < MIN_INK_CONTRAST;
        const update = (fn: (x: Pen) => Pen) => set((x) => { x.pens[i] = fn(x.pens[i]!); });
        return (
          <div className="field pen" key={pen.id}>
            <div className="penrow">
              <input type="color" value={pen.color} title="Ink color" onChange={(e) => set((x) => { x.pens[i]!.color = e.target.value; })} />
              <input type="text" value={pen.name} title="Name" onChange={(e) => set((x) => { x.pens[i]!.name = e.target.value; })} />
              <input type="number" min={0.05} max={5} step={0.05} value={pen.tipMm} title="Nib width, mm" onChange={(e) => set((x) => { x.pens[i]!.tipMm = Math.max(0.05, +e.target.value || 0.3); })} />
              <span className="unit">mm</span>
              <button title="Remove this pen (its parts move to the first pen)" disabled={p.pens.length <= 1} onClick={() => set((x) => { removePen(x, pen.id); })}>×</button>
            </div>
            <div className="row">
              <select title="Kind of pen" value={pen.kind ?? 'custom'} onChange={(e) => update((x) => withKind(x, e.target.value))}>
                {PEN_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
              </select>
              {kind.tipsMm.length > 0 && (
                <select title="Common tip sizes" value={kind.tipsMm.includes(pen.tipMm) ? String(pen.tipMm) : ''} onChange={(e) => e.target.value && update((x) => ({ ...x, tipMm: +e.target.value }))}>
                  {!kind.tipsMm.includes(pen.tipMm) && <option value="">{pen.tipMm} mm</option>}
                  {kind.tipsMm.map((t) => <option key={t} value={t}>{t} mm</option>)}
                </select>
              )}
            </div>
            <div className="row">
              <label title="How far the ink spreads past the tip on paper, each side">Spread</label>
              <input type="number" min={0} max={2} step={0.01} value={pen.gainMm ?? 0} onChange={(e) => update((x) => ({ ...x, gainMm: Math.max(0, +e.target.value || 0) }))} />
              <span className="unit">mm</span>
              <span className="hint">line on paper {ink} mm</span>
            </div>
            <div className="hint">
              {sections.length ? sections.join(', ') : 'Not used by anything'}
              {passes.length ? ` · thick lines: ${passes.map((q) => `${q.widthMm} mm = ${q.passes} passes`).join(', ')}` : ''}
            </div>
            {faint && <div className="hint warn">This ink is hard to see on {dark ? 'this dark' : 'this'} paper; try a {dark ? 'lighter' : 'darker'} color.</div>}
            <div className="row">
              <button title="Keep this pen in this browser, to use in any project" onClick={() => keep(withSavedPen(library, savedFromPen(pen.name, pen)))}>Save to library</button>
            </div>
          </div>
        );
      })}
      <div className="row">
        <button disabled={p.pens.length >= MAX_PENS} onClick={() => set((x) => { addPen(x); })}>Add pen</button>
        <span className="hint">{p.pens.length} of {MAX_PENS}</span>
      </div>
      <h3>Which pen draws what</h3>
      {(() => {
        const slots = penSlots(p);
        if (!slots.length) return <div className="hint">Nothing on the map draws with a pen yet.</div>;
        return (
          <div className="assign">
            {slots.map((s) => {
              const id = s.get(p);
              const faint = id !== undefined && contrast(penFor(p.pens, id).color, p.paper) < MIN_INK_CONTRAST;
              return (
                <div className="row" key={s.key}>
                  <button type="button" className="link part" title={`Open the ${s.section} settings`} onClick={() => showGroup(s.group)}>{s.section}</button>
                  <PenSelect pens={p.pens} value={id} allowDefault={s.base ? `Same as ${s.base(p).label} (${penFor(p.pens, s.base(p).id).name})` : undefined}
                    onChange={(v) => set((x) => { s.set(x, v); })} />
                  {faint && <span className="hint warn" title="This ink is hard to see on this paper">!</span>}
                </div>
              );
            })}
          </div>
        );
      })()}
      {library.length > 0 && (
        <div className="field">
          <div className="hint">Saved pens (kept in this browser). Choose one to put it into a pen of this project:</div>
          {p.pens.map((pen, i) => (
            <div className="row" key={pen.id}>
              <label>{pen.name}</label>
              <select value="" onChange={(e) => { const s = library.find((x) => x.name === e.target.value); if (s) set((x) => { x.pens[i] = applySavedPen(x.pens[i]!, s); }); }}>
                <option value="">use saved pen…</option>
                {library.map((s) => <option key={s.name} value={s.name}>{s.name} ({s.tipMm} mm)</option>)}
              </select>
            </div>
          ))}
          <div className="row">
            <select value="" onChange={(e) => e.target.value && keep(library.filter((x) => x.name !== e.target.value))}>
              <option value="">remove a saved pen…</option>
              {library.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
            </select>
          </div>
        </div>
      )}
    </Group>
  );
}
