import { describe, expect, it } from 'vitest';
import { hiddenLandmarks, unhide } from '../src/features/hidden';
import { composeScene } from '../src/scene/buildScene';
import { cityProject, SEATTLE } from './fixture';

const known = [
  { id: 'n1', name: 'Union Station', kind: 'station' as const },
  { id: 'n2', name: 'Space Needle', kind: 'attraction' as const },
  { id: 'n3', name: 'Green Lake', kind: 'lake' as const },
];

describe('the Hidden list', () => {
  it('lists every hidden landmark the main list does not show, by name and kind, named ones first in order', () => {
    const list = hiddenLandmarks({ n1: { hidden: true }, n2: { hidden: true }, n3: { hidden: false }, gone: { hidden: true } }, [], known);
    expect(list).toEqual([
      { id: 'n2', name: 'Space Needle', kind: 'attraction' },
      { id: 'n1', name: 'Union Station', kind: 'station' },
      { id: 'gone', name: undefined, kind: undefined },
    ]);
  });
  it('leaves out the ones already in the main list (they have their own Show box)', () => {
    expect(hiddenLandmarks({ n1: { hidden: true }, n2: { hidden: true } }, ['n1'], known).map((h) => h.id)).toEqual(['n2']);
  });
  it("uses the user's own name for it", () => {
    expect(hiddenLandmarks({ n2: { hidden: true, name: 'Needle' } }, [], known)[0]!.name).toBe('Needle');
  });
  it('is empty when nothing is hidden', () => {
    expect(hiddenLandmarks({ n1: { side: 'left' } }, [], known)).toEqual([]);
  });
  it('showing one again un-hides and pins it, and keeps its other edits', () => {
    expect(unhide({ hidden: true, name: 'Needle', icon: 'star' })).toEqual({ hidden: false, pinned: true, name: 'Needle', icon: 'star' });
    expect(unhide(undefined)).toEqual({ hidden: false, pinned: true });
  });
});

describe('showing a hidden landmark in the scene', () => {
  const data = { layers: {}, landmarks: [{ id: 'n1', name: 'Pike Place Market', kind: 'attraction' as const, lat: SEATTLE.lat + 0.003, lon: SEATTLE.lon - 0.002 }] };
  const texts = (p: ReturnType<typeof cityProject>) => composeScene(p, data).scene.prims.flatMap((x) => (x.kind === 'text' ? [x.text] : []));
  it('a hidden landmark is not drawn, and Show draws it again', () => {
    const p = cityProject();
    expect(texts(p)).toContain('Pike Place Market');
    p.features.overrides.n1 = { hidden: true };
    expect(texts(p)).not.toContain('Pike Place Market');
    p.features.overrides.n1 = unhide(p.features.overrides.n1);
    expect(texts(p)).toContain('Pike Place Market');
  });
});
