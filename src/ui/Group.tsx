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

interface Open { isOpen: (id: string) => boolean; toggle: (id: string) => void }
const OpenGroups = createContext<Open>({ isOpen: () => true, toggle: () => {} });

/** Which groups of settings are open. Side by side any number can be; on a narrow screen only one at a time. */
export function Groups({ narrow, initial, children }: { narrow: boolean; initial: string[]; children: ReactNode }) {
  const [open, setOpen] = useState<string[]>(initial);
  const isOpen = useCallback((id: string) => (narrow ? open[0] === id : open.includes(id)), [narrow, open]);
  const toggle = useCallback((id: string) => setOpen((o) => (narrow ? (o[0] === id ? [] : [id]) : o.includes(id) ? o.filter((x) => x !== id) : [...o, id])), [narrow]);
  return <OpenGroups.Provider value={{ isOpen, toggle }}>{children}</OpenGroups.Provider>;
}

/** A section of settings that opens and closes (an accordion item: the heading holds a button that shows or hides the body). */
export function Group({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  const { isOpen, toggle } = useContext(OpenGroups);
  const open = isOpen(id);
  return (
    <section className="group" id={`group-${id}`}>
      <h2 className="group-title">
        <button type="button" aria-expanded={open} aria-controls={`group-body-${id}`} onClick={() => toggle(id)}>
          <span className="chevron" aria-hidden="true">▸</span>
          <span>{title}</span>
        </button>
      </h2>
      <div className="group-body" id={`group-body-${id}`} hidden={!open}>{children}</div>
    </section>
  );
}
