import { defaultProject, type Project } from './scene/project';

export const FILE_APP = 'city-plot';
export const FILE_VERSION = 1;

/** What is kept beside a saved project so a listing can describe it without opening it. Typed by the app at save time and only ever displayed. */
export interface ProjectMeta { title?: string; place?: string; area?: string; size?: string }

export interface ProjectFile { app: typeof FILE_APP; version: number; savedAt: string; project: Project; meta?: ProjectMeta }

/** Everything needed to rebuild the map: all settings, the searched place, the region and the user's own landmarks. */
export const toFile = (p: Project, meta?: ProjectMeta): ProjectFile => ({ app: FILE_APP, version: FILE_VERSION, savedAt: new Date().toISOString(), project: p, ...(meta ? { meta } : {}) });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Lay saved values over the defaults, so a project saved before a setting existed still opens (the new setting
 * takes its default). Objects merge key by key; arrays and numbers, strings and so on are taken as saved.
 */
export function mergeDefaults<T>(base: T, saved: unknown): T {
  if (!isObj(base) || !isObj(saved)) return (saved === undefined ? base : (saved as T));
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(saved)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = k in base ? mergeDefaults((base as Record<string, unknown>)[k], v) : v;
  }
  return out as T;
}

export function fromFile(raw: unknown): Project {
  if (!isObj(raw) || raw.app !== FILE_APP || !isObj(raw.project)) throw new Error('Not a City Plot project');
  if (typeof raw.version === 'number' && raw.version > FILE_VERSION) throw new Error('This project was saved by a newer version of the app');
  const p = mergeDefaults(defaultProject(), raw.project);
  if (!Array.isArray(p.custom)) p.custom = [];
  if (!Array.isArray(p.pens) || !p.pens.length) p.pens = defaultProject().pens;
  // projects saved before an info item existed get it, switched off, at the end
  if (!Array.isArray(p.text.info.items)) p.text.info.items = defaultProject().text.info.items;
  for (const it of defaultProject().text.info.items) if (!p.text.info.items.some((x) => x.key === it.key)) p.text.info.items.push({ ...it, visible: false });
  return p;
}

/** The keys that let this browser save over the projects it saved: a code is shared, a key is not. Kept in this browser only. */
export const EDIT_KEYS = 'city-plot-edit-keys';
const MAX_KEYS = 200;
function readKeys(): Record<string, string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(EDIT_KEYS) ?? '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {};
  } catch { return {}; }
}
export const editKeyFor = (code: string): string | undefined => { const k = readKeys()[code]; return typeof k === 'string' ? k : undefined; };
export function rememberEditKey(code: string, key: string): void {
  try {
    const all = { ...readKeys() };
    delete all[code];
    all[code] = key; // newest last
    const codes = Object.keys(all);
    for (const c of codes.slice(0, Math.max(0, codes.length - MAX_KEYS))) delete all[c];
    localStorage.setItem(EDIT_KEYS, JSON.stringify(all));
  } catch { /* storage may be blocked */ }
}
export function forgetEditKey(code: string): void {
  try { const all = { ...readKeys() }; delete all[code]; localStorage.setItem(EDIT_KEYS, JSON.stringify(all)); } catch { /* ignore */ }
}

export class NotYoursError extends Error {}

/**
 * Save the project. With `over` (a code this browser holds the key for) the saved copy under that code is replaced; otherwise it is
 * saved under a new code, and the key to save over it later is remembered.
 */
export async function saveProject(p: Project, meta?: ProjectMeta, thumb?: () => Promise<Blob>, over?: string): Promise<string> {
  const key = over ? editKeyFor(over) : undefined;
  const replacing = !!(over && key);
  const r = await fetch(replacing ? `/api/project/${over}` : '/api/project', {
    method: replacing ? 'PUT' : 'POST',
    headers: { 'content-type': 'application/json', ...(replacing ? { 'x-edit-key': key! } : {}) },
    body: JSON.stringify(toFile(p, meta)),
  });
  const body = (await r.json().catch(() => ({}))) as { code?: string; editKey?: string; error?: string };
  if (r.status === 403 && over) { forgetEditKey(over); throw new NotYoursError(body.error ?? 'You can only save over a project you saved yourself'); }
  if (!r.ok || !body.code) throw new Error(body.error ?? 'Could not save');
  if (body.editKey) rememberEditKey(body.code, body.editKey);
  const useKey = body.editKey ?? key;
  // the small picture for the admin page: the project is saved either way, so a failure here is not an error
  if (thumb) {
    try { await fetch(`/api/project/${body.code}/thumb`, { method: 'PUT', headers: { 'content-type': 'image/png', ...(useKey ? { 'x-edit-key': useKey } : {}) }, body: await thumb() }); } catch { /* no thumbnail */ }
  }
  return body.code;
}

export async function loadProject(code: string): Promise<Project> {
  const r = await fetch(`/api/project/${encodeURIComponent(code)}`);
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? 'Could not load');
  return fromFile(await r.json());
}
