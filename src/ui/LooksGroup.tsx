import { useState } from 'react';
import { Group } from './Group';
import { applyLook, LOOKS, type Look } from '../scene/looks';
import { penFor } from '../scene/pens';
import type { Project } from '../scene/project';
import { useStore } from '../store';

/** A tiny sketch of a look in its own paper and inks: a shore with its waterlines, a park, a block, streets. */
function Thumb({ look }: { look: Look }) {
  const color = (id: string | undefined) => penFor(look.pens, id ?? look.ink).color;
  const L = look.layers;
  const water = color(L.water?.pen ?? 'blue');
  const ink = color(look.ink);
  const park = color(L.parks?.pen ?? 'green');
  const wl = L.water?.waterlines?.count ?? 0;
  const streets = L.minor?.enabled !== false;
  const blockFill = L.buildings?.fill === 'solid' ? ink : 'none';
  return (
    <svg viewBox="0 0 64 44" width="64" height="44" aria-hidden="true">
      <rect width="64" height="44" fill={look.paper} />
      <path d="M0 30C12 26 20 36 34 33S56 38 64 34" fill="none" stroke={water} strokeWidth="1" />
      {Array.from({ length: Math.min(4, Math.ceil(wl / 3)) }, (_, i) => (
        <path key={i} d={`M0 ${33 + i * 3}C12 ${29 + i * 3} 20 ${39 + i * 3} 34 ${36 + i * 3}S56 ${41 + i * 3} 64 ${37 + i * 3}`} fill="none" stroke={water} strokeWidth="0.6" />
      ))}
      {L.parks?.enabled !== false && <rect x="40" y="6" width="14" height="10" fill="none" stroke={park} strokeWidth="0.8" strokeDasharray={L.parks?.style === 'dotted' ? '0.5 1.5' : L.parks?.style === 'dashed' ? '2 1.5' : undefined} strokeLinecap="round" />}
      {L.buildings?.enabled !== false && <rect x="8" y="8" width="9" height="7" fill={blockFill} stroke={ink} strokeWidth="0.7" />}
      {streets && <path d="M4 20H60M24 2V28M33 2L28 28" fill="none" stroke={ink} strokeWidth="0.7" />}
      {streets && <path d="M4 2L60 26" fill="none" stroke={ink} strokeWidth="1.6" />}
    </svg>
  );
}

/** Pick a whole look in one click, with one step of undo (offered until anything else changes). */
export function LooksGroup() {
  const set = useStore((s) => s.set);
  const current = useStore((s) => s.project);
  const [last, setLast] = useState<{ name: string; before: Project; after: Project } | null>(null);
  const undo = last && last.after === current ? last : null;
  const pick = (look: Look) => {
    const before = useStore.getState().project;
    set((x) => applyLook(x, look));
    setLast({ name: look.name, before, after: useStore.getState().project });
  };
  return (
    <Group id="looks" title="Look">
      <div className="hint">A whole style in one click: paper, pens, layers, type, border and north arrow. Your place, area, page size and text stay.</div>
      <div className="looks">
        {LOOKS.map((look) => (
          <button key={look.id} className="look" onClick={() => pick(look)} title={look.blurb}>
            <Thumb look={look} />
            <b>{look.name}</b>
            <span>{look.blurb}</span>
          </button>
        ))}
      </div>
      {undo && (
        <div className="row">
          <span className="hint" style={{ margin: 0, flex: 1 }}>{undo.name} applied.</span>
          <button onClick={() => { useStore.setState({ project: undo.before }); setLast(null); }}>Undo</button>
        </div>
      )}
    </Group>
  );
}
