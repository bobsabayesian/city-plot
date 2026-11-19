// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act, createElement } from 'react';
import { App } from '../src/ui/App';
import { useStore } from '../src/store';
import { defaultProject } from '../src/scene/project';
import { cityProject } from './fixture';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  // no network: map data requests just fail, which the editor shows as a retry notice
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const show = async (project = defaultProject()) => {
  useStore.setState({ project, layers: {}, landmarks: { status: 'idle' } });
  await act(async () => { root.render(createElement(App)); });
};
const text = () => host.textContent ?? '';

describe('the editor renders', () => {
  it('shows the start screen before a place is chosen', async () => {
    await show();
    expect(text()).toContain('Draw a place');
    expect(text()).toContain('Open a saved project');
    expect(text()).toContain('OpenStreetMap contributors');
  });
  it('shows the settings groups, the action bar and the map once there is a place', async () => {
    await show(cityProject((p) => { p.custom = [{ id: 'custom-1', name: 'Home', kind: 'custom', lat: 47.6, lon: -122.3, icon: 'home' }]; }));
    for (const title of ['Place', 'Region', 'Pens and paper', 'Map layers', 'Landmarks', 'My landmarks', 'Print size', 'Page margin', 'Border margin', 'North arrow', 'Typography', 'Export', 'Saved project']) expect(text(), title).toContain(title);
    expect(text()).toContain('Design');
    expect(text()).toContain('Plotter');
    expect(host.querySelectorAll('input[role="switch"]').length).toBeGreaterThanOrEqual(3);
    expect(host.querySelector('.sheet svg')).not.toBeNull();
  });
  it('opens and closes a group of settings', async () => {
    await show(cityProject());
    const btn = host.querySelector<HTMLButtonElement>('#group-layers .group-title button')!;
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    await act(async () => { btn.click(); });
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('#group-body-layers')!.hasAttribute('hidden')).toBe(false);
    expect(host.querySelector('#group-body-layers')!.textContent).toContain('Major roads');
  });
  it('the header switch turns a part off, and its body says so', async () => {
    await show(cityProject((p) => { p.north.enabled = true; }));
    const sw = host.querySelector<HTMLInputElement>('#group-north input[role="switch"]')!;
    expect(sw.checked).toBe(true);
    await act(async () => { sw.click(); });
    expect(useStore.getState().project.north.enabled).toBe(false);
    expect(host.querySelector('#group-north')!.className).toContain('off');
  });
  it('the Plotter preview switches the map to how the pens will draw it', async () => {
    await show(cityProject());
    const plotter = [...host.querySelectorAll<HTMLButtonElement>('.seg button')].find((b) => b.textContent === 'Plotter')!;
    await act(async () => { plotter.click(); });
    expect(plotter.getAttribute('aria-checked')).toBe('true');
    expect(host.querySelector('.bar-status')!.textContent).toMatch(/Click-to-edit is off|Drawing/);
  });
  it('clicking a landmark label opens My landmarks and focuses its name box', async () => {
    await show(cityProject((p) => { p.custom = [{ id: 'custom-1', name: 'Home', kind: 'custom', lat: 47.6062, lon: -122.3321, icon: 'home' }]; }));
    const label = host.querySelector<SVGTextElement>('.sheet svg text[data-lm="custom-1"]');
    expect(label).not.toBeNull();
    vi.useFakeTimers();
    const sheet = host.querySelector('.sheet')!;
    await act(async () => {
      label!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 }));
      sheet.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 10, clientY: 10 }));
      await vi.advanceTimersByTimeAsync(200);
    });
    vi.useRealTimers();
    expect(host.querySelector('#group-mine .group-title button')!.getAttribute('aria-expanded')).toBe('true');
  });
  it('renders a coaster with a round preview', async () => {
    await show(cityProject((p) => { p.sizeId = 'coaster-circle'; }));
    expect((host.querySelector('.sheet') as HTMLElement).style.borderRadius).toBe('50%');
  });
});

describe('the Look group', () => {
  const click = async (el: Element | null | undefined) => { await act(async () => { (el as HTMLElement).click(); }); };
  const openLooks = async () => click([...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Look') && b.getAttribute('aria-expanded') !== null));

  it('offers every look as a card with a sketch, applies one, and undoes it', async () => {
    await show(cityProject());
    await openLooks();
    const cards = [...host.querySelectorAll('button.look')];
    expect(cards.map((c) => c.querySelector('b')?.textContent)).toEqual(['Classic', 'Engraved chart', 'Blueprint', 'Nolli', 'Minimal', 'Kraft']);
    for (const c of cards) expect(c.querySelector('svg')).not.toBeNull();

    const before = useStore.getState().project;
    await click(cards.find((c) => c.textContent?.includes('Blueprint')));
    expect(useStore.getState().project.paper).toBe('#16213e');
    expect(text()).toContain('Blueprint applied.');

    await click([...host.querySelectorAll('button')].find((b) => b.textContent === 'Undo'));
    expect(useStore.getState().project).toBe(before);
    expect(text()).not.toContain('Blueprint applied.');
  });

  it('stops offering Undo once something else changes, so a later edit is never thrown away', async () => {
    await show(cityProject());
    await openLooks();
    await click([...host.querySelectorAll('button.look')].find((c) => c.textContent?.includes('Kraft')));
    expect(text()).toContain('Kraft applied.');
    await act(async () => { useStore.getState().set((p) => { p.text.title.value = 'Our town'; }); });
    expect(text()).not.toContain('Kraft applied.');
  });
});
