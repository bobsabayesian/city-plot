import { useEffect, useRef, useState } from 'react';
import { Group } from './Group';
import { editKeyFor, loadProject, NotYoursError, saveProject, type ProjectMeta } from '../projectFile';
import { cleanCode } from '../../worker/projects';
import type { Project } from '../scene/project';

export const linkFor = (code: string) => `${location.origin}/?p=${code}`;

export type SaveMsg = { text: string; error?: boolean } | null;

/**
 * Saving the whole map (settings, place, region and your own landmarks) under a short code, and opening one by its code.
 * Used by both the action bar (Save) and the start screen and sidebar (Open), so it lives in one place.
 */
export function useProjectSave({ project, openProject, meta, thumb }: { project: Project; openProject: (p: Project) => void; meta?: ProjectMeta; thumb?: () => Promise<Blob> }) {
  const [code, setCode] = useState('');
  /** the project as it was when last saved or opened, to tell whether there are changes since */
  const [savedAs, setSavedAs] = useState<Project | null>(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<SaveMsg>(null);
  const started = useRef(false);

  const open = async (raw: string) => {
    const c = cleanCode(raw);
    if (!c) { setMsg({ text: 'That is not a project code (8 letters and numbers).', error: true }); return; }
    setBusy('Opening…'); setMsg(null);
    try {
      const p = await loadProject(c);
      openProject(p);
      setCode(c);
      setSavedAs(p);
      history.replaceState(null, '', `?p=${c}`);
      setMsg({ text: `Opened ${c}.` });
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : 'Could not open', error: true });
    } finally { setBusy(''); }
  };

  // a link with ?p=code opens that project straight away
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const c = new URLSearchParams(location.search).get('p');
    if (c) void open(c);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** this browser saved the open code, so it may save over it */
  const [mine, setMine] = useState(false);
  useEffect(() => { setMine(!!code && !!editKeyFor(code)); }, [code]);

  /** `over`: replace the saved copy under the open code; otherwise save under a new code */
  const save = async (over = false) => {
    setBusy('Saving…'); setMsg(null);
    try {
      const c = await saveProject(project, meta, thumb, over ? code : undefined);
      setCode(c);
      setMine(!!editKeyFor(c));
      setSavedAs(project);
      history.replaceState(null, '', `?p=${c}`);
      setMsg({ text: over ? `Saved over ${c}. The same code and link now show these changes.` : `Saved as ${c}. Anyone with this code can open it, so share it only with people who may see where your landmarks are.` });
    } catch (e) {
      if (e instanceof NotYoursError) setMine(false);
      setMsg({ text: e instanceof Error ? e.message : 'Could not save', error: true });
    } finally { setBusy(''); }
  };

  const copy = (text: string) => { void navigator.clipboard?.writeText(text).then(() => setMsg({ text: 'Copied.' }), () => {}); };

  /** edited since the last save or open: the code (and the ?p= link) point at the older copy */
  const changed = !!code && savedAs !== project;
  return { code, busy, msg, setMsg, open, save, copy, changed, mine };
}

export type ProjectSave = ReturnType<typeof useProjectSave>;

/** Type a project code (or paste a link) and open it. */
export function OpenByCode({ s }: { s: ProjectSave }) {
  const [typed, setTyped] = useState('');
  return (
    <div className="row">
      <input type="text" aria-label="Project code" placeholder="Project code or link" value={typed} onChange={(e) => setTyped(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void s.open(typed); }} />
      <button type="button" onClick={() => void s.open(typed)} disabled={!!s.busy || !typed.trim()}>Open</button>
    </div>
  );
}

/** The sidebar group: the current code with copy buttons, and opening another project. Saving is in the action bar. */
export function SaveGroup({ s }: { s: ProjectSave }) {
  return (
    <Group id="saved" title="Saved project">
      {s.code ? (
        <div className="row">
          <b className="code" title="Project code">{s.code}</b>
          <button type="button" onClick={() => s.copy(s.code)}>Copy code</button>
          <button type="button" onClick={() => s.copy(linkFor(s.code))}>Copy link</button>
        </div>
      ) : <div className="hint">Not saved yet. Use Save above the map.</div>}
      {s.changed && <div className="hint">{s.mine ? 'Changed since this code was saved. Save over it to keep the same code, or save as new.' : 'Changed since this code was saved. Save again for a code with the changes.'}</div>}
      <OpenByCode s={s} />
      {s.msg && <div className={s.msg.error ? 'err' : 'hint'}>{s.msg.text}</div>}
      <div className="hint">Saving keeps all settings, the place and region, and your own landmarks. Save makes a new code; on a project you saved yourself in this browser, Save over keeps the code and replaces the copy.</div>
    </Group>
  );
}
