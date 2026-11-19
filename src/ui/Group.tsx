import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

/** Whether a CSS media query currently matches, kept up to date as the window changes. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => (typeof window === 'undefined' ? false : window.matchMedia(query).matches));
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return matches;
}

/** Below this width the settings and the map no longer fit side by side, so they become two tabs. */
export const NARROW_QUERY = '(max-width: 800px)';

interface Open { isOpen: (id: string) => boolean; toggle: (id: string) => void; show: (id: string) => void }
const OpenGroups = createContext<Open>({ isOpen: () => true, toggle: () => {}, show: () => {} });

/** Open a group of settings from elsewhere (and bring it into view). */
export const useShowGroup = () => useContext(OpenGroups).show;

/** Which groups of settings are open. Side by side any number can be; on a narrow screen only one at a time. */
export function Groups({ narrow, initial, children }: { narrow: boolean; initial: string[]; children: ReactNode }) {
  const [open, setOpen] = useState<string[]>(initial);
  const isOpen = useCallback((id: string) => (narrow ? open[0] === id : open.includes(id)), [narrow, open]);
  const toggle = useCallback((id: string) => setOpen((o) => (narrow ? (o[0] === id ? [] : [id]) : o.includes(id) ? o.filter((x) => x !== id) : [...o, id])), [narrow]);
  const show = useCallback((id: string) => {
    setOpen((o) => (narrow ? [id] : o.includes(id) ? o : [...o, id]));
    setTimeout(() => document.getElementById(`group-${id}`)?.scrollIntoView?.({ block: 'start' }), 50);
  }, [narrow]);
  return <OpenGroups.Provider value={{ isOpen, toggle, show }}>{children}</OpenGroups.Provider>;
}

/** A part of the map that can be turned on and off from its group's header. */
export interface Switch { on: boolean; onChange: (on: boolean) => void; /** a short note beside the switch, such as "Loading…" */ status?: string }

/**
 * A section of settings that opens and closes: the heading holds a button that shows or hides the body. A group for a
 * part of the map that can be left out also has an on/off switch in its header, beside (not inside) that button, so
 * the closed sidebar shows at a glance what is on. While it is off, the body says so instead of its settings.
 */
export function Group({ id, title, toggle, children }: { id: string; title: string; toggle?: Switch; children: ReactNode }) {
  const { isOpen, toggle: flip } = useContext(OpenGroups);
  const open = isOpen(id);
  const off = toggle && !toggle.on;
  return (
    <section className={`group${off ? ' off' : ''}`} id={`group-${id}`}>
      <div className="group-head">
        <h2 className="group-title">
          <button type="button" aria-expanded={open} aria-controls={`group-body-${id}`} onClick={() => flip(id)}>
            <span className="chevron" aria-hidden="true">▸</span>
            <span>{title}</span>
            {off && <span className="sr-only"> (off)</span>}
          </button>
        </h2>
        {toggle && (<>
          {toggle.status && <span className="group-status hint">{toggle.status}</span>}
          <label className="switch" title={toggle.on ? `${title} is on: click to leave it out` : `${title} is off: click to show it`}>
            <input type="checkbox" role="switch" aria-label={`Show ${title.toLowerCase()}`} checked={toggle.on} onChange={(e) => toggle.onChange(e.target.checked)} />
            <span className="track" aria-hidden="true" />
          </label>
        </>)}
      </div>
      <div className="group-body" id={`group-body-${id}`} hidden={!open}>
        {off ? <div className="hint off-note">Off. Turn on the switch above to show it on the map.</div> : children}
      </div>
    </section>
  );
}
