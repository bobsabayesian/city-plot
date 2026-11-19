/** Saved projects: one JSON file per project in the shared `project-files` bucket, under `city/`. */

export const PREFIX = 'city/';
export const MAX_BYTES = 4 * 1024 * 1024;
/** No 0/o, 1/l/i: a code read aloud or typed from a phone stays unambiguous. */
const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
const CODE_LEN = 8;
export const CODE_RE = new RegExp(`^[${ALPHABET}]{${CODE_LEN}}$`);

export const MAX_THUMB_BYTES = 300 * 1024;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

export interface Bucket {
  get(key: string): Promise<{ text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> } | null>;
  head(key: string): Promise<{ customMetadata?: Record<string, string> } | null>;
  put(key: string, value: string | ArrayBuffer, opts?: { httpMetadata?: { contentType: string }; customMetadata?: Record<string, string> }): Promise<unknown>;
  list?(opts: { prefix: string; cursor?: string; include?: ('customMetadata')[] }): Promise<{
    objects: { key: string; size: number; uploaded: Date; customMetadata?: Record<string, string> }[]; truncated: boolean; cursor?: string;
  }>;
}

/** What is kept beside a project in the bucket (as object metadata), so a listing can say what each one is without opening its file. */
export function summarize(project: Record<string, any>, meta?: Record<string, any>): Record<string, string> {
  const text = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback).slice(0, 120);
  // the title and place as printed come from the app; without them fall back to what the project itself holds
  const name = text(meta?.title) || text(project.place?.name);
  const place = text(meta?.place) || text(project.place?.location);
  return { name, place, area: text(meta?.area), size: text(meta?.size), custom: String(Array.isArray(project.custom) ? project.custom.length : 0), savedAt: new Date().toISOString() };
}

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...extra } });

export function newCode(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  let out = '';
  // rejection sampling keeps every letter equally likely
  while (out.length < CODE_LEN) {
    for (const b of random(CODE_LEN * 2)) {
      if (b < 248 && out.length < CODE_LEN) out += ALPHABET[b % ALPHABET.length];
    }
  }
  return out;
}

/** A secret that lets the saver (and nobody who only has the code) save over this project again; only its hash is kept. */
export const newEditKey = (random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string =>
  [...random(16)].map((b) => b.toString(16).padStart(2, '0')).join('');
export async function hashKey(key: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
/** Compares in constant time, so the check does not leak how much of a key was right. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}
/** Does this request carry the edit key that was made when the project was first saved? */
async function mayEdit(req: Request, held: { customMetadata?: Record<string, string> }): Promise<boolean> {
  const want = held.customMetadata?.editHash;
  const key = req.headers.get('x-edit-key') ?? '';
  return !!want && /^[0-9a-f]{32}$/.test(key) && same(await hashKey(key), want);
}

/** Normalizes what a person typed or pasted: spaces and case are fine, and so is a whole link with `?p=code` in it. */
export const cleanCode = (s: string): string => {
  const t = s.trim().toLowerCase();
  const m = t.match(/[?&#]p=([^&#\s]+)/);
  const c = (m ? m[1]! : t).replace(/[\s-]/g, '');
  return CODE_RE.test(c) ? c : '';
};

/** The file a project is saved as: all the settings, the searched place, the region and the user's own landmarks, so one code restores everything. */
export async function handleProjects(req: Request, bucket: Bucket | undefined, url = new URL(req.url)): Promise<Response | null> {
  if (url.pathname !== '/api/project' && !url.pathname.startsWith('/api/project/')) return null;
  if (!bucket) return json({ error: 'saving is not set up on this server' }, 503);

  if (url.pathname === '/api/project') {
    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
    const declared = +(req.headers.get('content-length') ?? 0);
    if (declared > MAX_BYTES) return json({ error: 'project too large' }, 413);
    const text = await req.text();
    if (text.length > MAX_BYTES) return json({ error: 'project too large' }, 413);
    let doc: unknown;
    try { doc = JSON.parse(text); } catch { return json({ error: 'not valid JSON' }, 400); }
    const d = doc as { app?: unknown; version?: unknown; project?: unknown } | null;
    if (!d || d.app !== 'city-plot' || typeof d.version !== 'number' || typeof d.project !== 'object' || d.project === null) {
      return json({ error: 'not a City Plot project' }, 400);
    }
    // a new code every time; the key returned with it is what lets this saver (only) save over the project later
    const editKey = newEditKey();
    const editHash = await hashKey(editKey);
    for (let i = 0; i < 5; i++) {
      const code = newCode();
      if (await bucket.head(PREFIX + code + '.json')) continue;
      await bucket.put(PREFIX + code + '.json', text, { httpMetadata: { contentType: 'application/json' }, customMetadata: { ...summarize(d.project as Record<string, any>, (d as { meta?: Record<string, any> }).meta), editHash } });
      return json({ code, editKey }, 201);
    }
    return json({ error: 'could not make a code, try again' }, 503);
  }

  // the small picture saved beside a project, for the admin page: written once, so it cannot be swapped afterwards
  const thumb = /^\/api\/project\/([^/]+)\/thumb$/.exec(url.pathname);
  if (thumb) {
    if (req.method !== 'PUT') return json({ error: 'method not allowed' }, 405);
    const c = decodeURIComponent(thumb[1]!);
    if (!CODE_RE.test(c)) return json({ error: 'not a project code' }, 400);
    if (!(await bucket.head(PREFIX + c + '.json'))) return json({ error: 'no project with that code' }, 404);
    // written once, unless the request carries the project's edit key (saving over it makes a new picture)
    const held = await bucket.head(PREFIX + c + '.json');
    if (await bucket.head(PREFIX + c + '.png') && !(await mayEdit(req, held!))) return json({ error: 'already has a picture' }, 409);
    const bytes = await req.arrayBuffer();
    if (bytes.byteLength > MAX_THUMB_BYTES) return json({ error: 'picture too large' }, 413);
    const head = new Uint8Array(bytes.slice(0, 4));
    if (!PNG_MAGIC.every((b, i) => head[i] === b)) return json({ error: 'not a PNG' }, 400);
    await bucket.put(PREFIX + c + '.png', bytes, { httpMetadata: { contentType: 'image/png' } });
    return json({ ok: true }, 201);
  }

  const code = decodeURIComponent(url.pathname.slice('/api/project/'.length));
  if (req.method === 'PUT') {
    // save over a project: only with the edit key made when it was first saved (a code alone, which is shared, is not enough)
    if (!CODE_RE.test(code)) return json({ error: 'not a project code' }, 400);
    const held = await bucket.head(PREFIX + code + '.json');
    if (!held) return json({ error: 'no project with that code' }, 404);
    if (!(await mayEdit(req, held))) return json({ error: 'you can only save over a project you saved yourself, in this browser' }, 403);
    if (+(req.headers.get('content-length') ?? 0) > MAX_BYTES) return json({ error: 'project too large' }, 413);
    const text = await req.text();
    if (text.length > MAX_BYTES) return json({ error: 'project too large' }, 413);
    let doc: unknown;
    try { doc = JSON.parse(text); } catch { return json({ error: 'not valid JSON' }, 400); }
    const d = doc as { app?: unknown; version?: unknown; project?: unknown } | null;
    if (!d || d.app !== 'city-plot' || typeof d.version !== 'number' || typeof d.project !== 'object' || d.project === null) return json({ error: 'not a City Plot project' }, 400);
    await bucket.put(PREFIX + code + '.json', text, { httpMetadata: { contentType: 'application/json' }, customMetadata: { ...summarize(d.project as Record<string, any>, (d as { meta?: Record<string, any> }).meta), editHash: held.customMetadata!.editHash! } });
    return json({ code }, 200);
  }
  if (req.method !== 'GET') return json({ error: 'method not allowed' }, 405);
  if (!CODE_RE.test(code)) return json({ error: 'not a project code' }, 400);
  const obj = await bucket.get(PREFIX + code + '.json');
  if (!obj) return json({ error: 'no project with that code' }, 404);
  // a project can hold where someone lives (a landmark called Home): keep it out of shared caches
  return new Response(await obj.text(), { headers: { 'content-type': 'application/json', 'cache-control': 'private, max-age=0, must-revalidate' } });
}
