// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act, createElement } from 'react';
import { App } from '../src/ui/App';
import { useStore } from '../src/store';
import { defaultProject } from '../src/scene/project';
import { cityProject } from './fixture';
import { routeStops } from '../src/features/route';
import { composeScene } from '../src/scene/buildScene';

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
    expect(cards.map((c) => c.querySelector('b')?.textContent)).toEqual(['Classic', 'Engraved chart', 'Blueprint', 'Nolli', 'Minimal', 'Military', 'Kraft']);
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

describe('the Memory route group', () => {
  const click = async (el: Element | null | undefined) => { await act(async () => { (el as HTMLElement).click(); }); };
  const choose = async (sel: HTMLSelectElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(sel, value);
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
  };
  const type = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const group = () => host.querySelector('#group-route')!;

  it('adds stops, puts them in order and keeps a note for each', async () => {
    await show(cityProject((p) => {
      p.custom = [
        { id: 'custom-1', name: 'Home', kind: 'custom', lat: 47.6, lon: -122.33, icon: 'home' },
        { id: 'custom-2', name: 'Cafe', kind: 'custom', lat: 47.61, lon: -122.34, icon: 'default' },
      ];
    }));
    await click([...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Memory route') && b.getAttribute('aria-expanded') !== null));
    expect(group().textContent).toContain('Turn on the switch');
    await click(group().querySelector('[role="switch"]'));
    const add = () => group().querySelector('select') as HTMLSelectElement;
    await choose(add(), 'custom-2');
    await choose(add(), 'custom-1');
    expect(useStore.getState().project.route.enabled).toBe(true);
    expect(useStore.getState().project.route.stops).toEqual(['custom-2', 'custom-1']);

    await click(group().querySelector('[aria-label="Move Home earlier"]'));
    expect(useStore.getState().project.route.stops).toEqual(['custom-1', 'custom-2']);

    await type(group().querySelector('[aria-label="Note for Cafe"]') as HTMLInputElement, 'first date');
    expect(useStore.getState().project.custom.find((c) => c.id === 'custom-2')!.note).toBe('first date');

    await click(group().querySelector('[aria-label="Take Home off the route"]'));
    expect(useStore.getState().project.route.stops).toEqual(['custom-2']);
    expect(group().textContent).toContain('Add one more stop');
  });
});

describe('the Scale picker', () => {
  it('fixes the map at 1:25,000 and says what that means', async () => {
    await show(cityProject());
    await act(async () => { ([...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Region') && b.getAttribute('aria-expanded') !== null) as HTMLElement).click(); });
    const sel = host.querySelector('[data-edit="scale"]') as HTMLSelectElement;
    expect([...sel.options].map((o) => o.textContent)).toEqual(expect.arrayContaining(['1:10,000', '1:25,000', '1:50,000', '1:100,000']));
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(sel, '25000');
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(useStore.getState().project.region!.scale).toBe(25000);
    expect(text()).toContain('Fixed at 1:25,000');
    expect(text()).toContain('250 m on the ground');
  });
});

describe('memory route from photos', () => {
  const click = async (el: Element | null | undefined) => { await act(async () => { (el as HTMLElement).click(); }); };
  const fixture = async (name: string, type: string) => {
    const { readFileSync } = await import('node:fs');
    return new File([readFileSync(`test/fixtures/photos/${name}`)], name, { type });
  };

  it('reads the photos on the device, adds dated stops, and lists the one with no location to place by tap', async () => {
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:thumb', revokeObjectURL: () => {} }));
    await show(cityProject());
    await click([...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Memory route') && b.getAttribute('aria-expanded') !== null));
    const group = host.querySelector('#group-route')!;
    await click(group.querySelector('[role="switch"]'));

    const input = group.querySelector('input[type=file]') as HTMLInputElement;
    expect(input.accept).toContain('image/*');
    expect(input.multiple).toBe(true);
    const files = [await fixture('needle.jpg', 'image/jpeg'), await fixture('needle.avif', 'image/avif'), await fixture('no-gps.jpg', 'image/jpeg'), await fixture('sydney.jpg', 'image/jpeg')];
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

    const p = useStore.getState().project;
    // the JPEG and the HEIF of the same moment at the Space Needle are one stop; Sydney (2016) comes after it (2014)
    expect(routeStops(p.route, p.custom).map((s) => s.name)).toEqual(['21 Jun 2014', '2 Jan 2016']);
    expect(group.textContent).toContain('Added 2 stops from 4 photos');
    expect(group.textContent).toContain('1 taken where a stop already is that day');
    expect(group.textContent).toContain('1 without a location');
    expect(group.querySelectorAll('img.thumb').length).toBeGreaterThanOrEqual(2);

    // place the photo that had no location: the map waits for a tap, which calls back with the spot
    await click([...group.querySelectorAll('button')].find((b) => b.textContent === 'Place on map'));
    const placing = useStore.getState().placing!;
    expect(placing.label).toBe('31 Dec 2019');
    expect(text()).toContain('Tap the map where 31 Dec 2019 was taken');
    await act(async () => { useStore.getState().setPlacing(null); placing.done(47.61, -122.34); });
    const q = useStore.getState().project;
    expect(routeStops(q.route, q.custom).map((s) => s.name)).toEqual(['21 Jun 2014', '2 Jan 2016', '31 Dec 2019']);
    expect(group.textContent).not.toContain('Place on map');
  });
});

describe('photos from a phone, by QR code', () => {
  const click = async (el: Element | null | undefined) => { await act(async () => { (el as HTMLElement).click(); }); };
  /** the real Worker handler behind fetch, with a bucket in memory */
  const serve = async () => {
    const { handleDrop } = await import('../worker/drop');
    const { memoryBucket } = await import('../worker/memoryBucket');
    const bucket = memoryBucket();
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => (await handleDrop(new Request(new URL(url, 'https://city.example'), init), bucket)) ?? new Response('{}', { status: 404 })));
  };

  it('the computer shows a QR code for its link, and photos sent to it become stops', async () => {
    await serve();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      await show(cityProject());
      await click([...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Memory route') && b.getAttribute('aria-expanded') !== null));
      const group = host.querySelector('#group-route')!;
      await click(group.querySelector('[role="switch"]'));
      await click([...group.querySelectorAll('button')].find((b) => b.textContent === 'From your phone'));
      await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
      expect(group.querySelector('.qr svg')).not.toBeNull();
      const link = (group.querySelector('[aria-label="Link for your phone"]') as HTMLInputElement).value;
      const token = new URL(link).searchParams.get('drop')!;
      expect(token).toMatch(/^[2-9a-hjkmnp-z]{16}$/);
      expect(group.textContent).toContain('Waiting for photos');

      // the phone sends two photos; the next look at the box brings them in
      await fetch(`/api/drop/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ photos: [
        { file: 'a.jpg', info: { lat: 47.62, lon: -122.35, takenAt: '2014-06-21T15:00:00' }, thumb: 'data:image/jpeg;base64,/9j/' },
        { file: 'b.jpg', info: { takenAt: '2015-01-01T10:00:00' } },
      ] }) });
      await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
      await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
      const p = useStore.getState().project;
      expect(routeStops(p.route, p.custom).map((s) => s.name)).toEqual(['21 Jun 2014']);
      expect(group.textContent).toContain('2 photos so far');
      expect(group.textContent).toContain('1 without a location');
      expect((group.querySelector('img.thumb') as HTMLImageElement).src).toContain('data:image/jpeg');

      await click([...group.querySelectorAll('button')].find((b) => b.textContent === 'Done'));
      expect(group.querySelector('.qr')).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it('the phone page reads the photos and sends their locations and dates, in batches, never the files', async () => {
    const sent: { photos: Record<string, unknown>[] }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init!.body)));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }));
    const { PhoneDrop } = await import('../src/ui/PhoneDrop');
    await act(async () => { root.render(createElement(PhoneDrop, { token: 'abcdefghjkmnpqrs' })); });
    expect(text()).toContain('Send photos to City Plot');
    const { readFileSync } = await import('node:fs');
    const needle = readFileSync('test/fixtures/photos/needle.jpg');
    const stripped = readFileSync('test/fixtures/photos/no-gps.jpg');
    const files = [...Array.from({ length: 22 }, (_, i) => new File([needle], `IMG_${i}.jpg`, { type: 'image/jpeg' })), new File([stripped], 'IMG_x.jpg', { type: 'image/jpeg' })];
    const input = host.querySelector('input[type=file]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(sent.map((b) => b.photos.length)).toEqual([20, 3]);
    const first = sent[0]!.photos[0]!;
    expect(Object.keys(first).sort()).toEqual(['file', 'info']); // no thumbnail where the browser cannot draw one, and never the file itself
    expect(first.info).toMatchObject({ takenAt: '2014-06-21T15:42:07' });
    expect(text()).toContain('Sent 23 photos to your computer; 1 without a location');
  });
});

describe('naming stops', () => {
  const click = async (el: Element | null | undefined) => { await act(async () => { (el as HTMLElement).click(); }); };
  const type = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  it('a stop made from a photo can be renamed in place, and still says when the photo was taken', async () => {
    await show(cityProject((p) => {
      p.custom = [{ id: 'custom-1', name: '8 Aug 2026', kind: 'custom', lat: 47.6, lon: -122.33, icon: 'dot', takenAt: '2026-08-08T10:00:00' }];
      p.route = { ...p.route, enabled: true, stops: ['custom-1'] };
    }));
    await click([...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Memory route') && b.getAttribute('aria-expanded') !== null));
    const group = host.querySelector('#group-route')!;
    const name = group.querySelector('[aria-label="Name of stop 1"]') as HTMLInputElement;
    expect(name.value).toBe('8 Aug 2026');
    expect(group.textContent).not.toContain('Photo taken');
    await type(name, 'FOB Pit');
    expect(useStore.getState().project.custom[0]!.name).toBe('FOB Pit');
    expect(group.textContent).toContain('Photo taken 8 Aug 2026');
    // the new name is what the map and the key say
    const texts = composeScene(useStore.getState().project, { layers: {}, landmarks: [] }).scene.prims.filter((x) => x.kind === 'text').map((x) => (x as { text: string }).text);
    expect(texts).toContain('1. FOB Pit');
  });

  it('a photo waiting to be placed can be named first, and is placed under that name', async () => {
    const { addPhotoStop, photoStopName } = await import('../src/features/photoStops');
    const ph = { file: 'IMG_9.jpg', info: { takenAt: '2026-08-09T09:00:00' }, name: 'Gate 3' };
    expect(photoStopName(ph)).toBe('Gate 3');
    expect(photoStopName({ ...ph, name: '   ' })).toBe('9 Aug 2026');
    const p = cityProject();
    const id = addPhotoStop(p, ph, 47.6, -122.33);
    expect(p.custom.find((c) => c.id === id)!.name).toBe('Gate 3');
  });
});
