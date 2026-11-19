import type { ReactNode } from 'react';
import { Group } from './Group';
import { PenSelect } from './PensPanel';
import { autoSpacingKm, utmBand, utmZone } from '../scene/grid';
import { useStore } from '../store';

const Row = ({ label, children }: { label: string; children: ReactNode }) => <div className="row"><label>{label}</label>{children}</div>;

/** The kilometre grid: on or off, how far apart, its pen, and the grid numbers in the margin. */
export function GridGroup({ scale, lat, lon }: { scale: number; lat: number; lon: number }) {
  const g = useStore((s) => s.project.grid);
  const pens = useStore((s) => s.project.pens);
  const set = useStore((s) => s.set);
  const auto = autoSpacingKm(scale);
  return (
    <Group id="grid" title="Grid" toggle={{ on: g.enabled, onChange: (on) => set((x) => { x.grid.enabled = on; }) }}>
      <div className="hint">A kilometre grid as on military and survey maps: UTM zone {utmZone(lon)}{utmBand(lat)}, with each line's grid number in the margin, so places can be given as grid references.</div>
      <Row label="Every">
        <select value={g.spacingKm} data-edit="grid" onChange={(e) => set((x) => { x.grid.spacingKm = +e.target.value; })}>
          <option value={0}>Auto ({auto} km at this scale)</option>
          {[1, 2, 5, 10].map((k) => <option key={k} value={k}>{k} km</option>)}
        </select>
      </Row>
      <Row label="Pen"><PenSelect pens={pens} value={g.pen} onChange={(id) => set((x) => { x.grid.pen = id!; })} /></Row>
      <Row label="Numbers">
        <label><input type="checkbox" checked={g.labels} onChange={(e) => set((x) => { x.grid.labels = e.target.checked; })} /> In the margin</label>
        {g.labels && <><input type="number" min={4} max={20} style={{ maxWidth: 58 }} value={g.labelSizePt} onChange={(e) => set((x) => { x.grid.labelSizePt = Math.min(20, Math.max(4, +e.target.value || 7)); })} /><span className="unit">pt</span></>}
      </Row>
    </Group>
  );
}
