import { PREFIX } from './projects';
import { newShareToken, type ShareBucket } from './share';

/**
 * A photo drop box, so a phone can hand photos to the computer the map is being made on: the computer opens a box
 * and shows its link as a QR code, the phone posts to it, and the computer collects what arrived.
 *
 * The photos themselves never come here. The phone reads each one's location and date on the device and sends only
 * those, its file name, and a small thumbnail (so they can be told apart on the computer). What arrives is deleted as
 * soon as the computer collects it, and a box lasts an hour; the token (16 characters, about 80 bits) is its only key.
 *
 *   POST /api/drop            -> { token, expiresAt }       the computer opens a box
 *   POST /api/drop/<token>    { photos: [...] } -> { ok }   the phone sends a batch (as many batches as it likes)
 *   GET  /api/drop/<token>    -> { photos, expiresAt }      the computer collects (and so deletes) what has arrived
 */
export const DROP_PREFIX = PREFIX + 'drop/';
export const DROP_TTL_MS = 60 * 60 * 1000;
export const MAX_BATCH_BYTES = 4 * 1024 * 1024;
export const MAX_PHOTOS = 60;
/** a thumbnail: a small JPEG as a data URL */
export const MAX_THUMB_CHARS = 80_000;
export const MAX_BATCHES = 40;
const TOKEN = /^[2-9a-hjkmnp-z]{16}$/;

export interface DropPhoto { file: string; info: { lat?: number; lon?: number; takenAt?: string }; thumb?: string }

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).buffer as ArrayBuffer;

/** One photo from the phone, kept only if every field is what it should be (anything else is dropped, not stored). */
export function cleanDropPhoto(raw: unknown): DropPhoto | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const file = typeof r.file === 'string' ? r.file.replace(/[\u0000-\u001f]/g, '').slice(0, 120) : '';
  const i = (r.info && typeof r.info === 'object' ? r.info : {}) as Record<string, unknown>;
  const info: DropPhoto['info'] = {};
  if (typeof i.lat === 'number' && typeof i.lon === 'number' && Number.isFinite(i.lat) && Number.isFinite(i.lon) && Math.abs(i.lat) <= 90 && Math.abs(i.lon) <= 180) {
    info.lat = i.lat;
    info.lon = i.lon;
  }
  if (typeof i.takenAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(i.takenAt)) info.takenAt = i.takenAt;
  const thumb = typeof r.thumb === 'string' && r.thumb.length <= MAX_THUMB_CHARS && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(r.thumb) ? r.thumb : undefined;
  return { file: file || 'photo', info, ...(thumb ? { thumb } : {}) };
}

/** Delete boxes past their hour, and anything in them (a few at a time, so a request never waits long). */
export async function sweepDrops(bucket: ShareBucket, now: number): Promise<number> {
  if (!bucket.list) return 0;
  const { objects } = await bucket.list({ prefix: DROP_PREFIX, limit: 200 });
  const old = objects.filter((o) => now - o.uploaded.getTime() >= DROP_TTL_MS).map((o) => o.key);
  if (old.length) await bucket.delete(old);
  return old.length;
}

/** When the box was opened, or undefined if there is no such box (or it has expired, in which case it is cleared). */
async function opened(bucket: ShareBucket, token: string, now: number): Promise<number | undefined> {
  const s = await bucket.get(`${DROP_PREFIX}${token}/box`);
  if (!s) return undefined;
  // the box records when it was opened (the object's upload time stands in if that is unreadable)
  let at = s.uploaded.getTime();
  try { const o = JSON.parse(new TextDecoder().decode(await s.arrayBuffer())) as { opened?: unknown }; if (typeof o.opened === 'number') at = o.opened; } catch { /* keep the upload time */ }
  if (now - at >= DROP_TTL_MS) {
    const items = bucket.list ? (await bucket.list({ prefix: `${DROP_PREFIX}${token}/` })).objects.map((o) => o.key) : [];
    await bucket.delete([...items, `${DROP_PREFIX}${token}/box`]);
    return undefined;
  }
  return at;
}

export async function handleDrop(req: Request, bucket: ShareBucket | undefined, now = Date.now(), random?: (n: number) => Uint8Array): Promise<Response | null> {
  const m = /^\/api\/drop(?:\/([^/]+))?\/?$/.exec(new URL(req.url).pathname);
  if (!m) return null;
  if (!bucket) return json(503, { error: 'the photo drop is not set up on this server' });

  // the computer opens a box
  if (m[1] === undefined) {
    if (req.method !== 'POST') return json(405, { error: 'POST only' });
    const token = newShareToken(random);
    await bucket.put(`${DROP_PREFIX}${token}/box`, enc({ opened: now }));
    await sweepDrops(bucket, now).catch(() => {});
    return json(200, { token, expiresAt: now + DROP_TTL_MS });
  }

  const token = decodeURIComponent(m[1]).toLowerCase();
  if (!TOKEN.test(token)) return json(400, { error: 'bad link' });
  const at = await opened(bucket, token, now);
  if (at === undefined) return json(404, { error: 'this link has expired; scan a new code on the computer' });
  const expiresAt = at + DROP_TTL_MS;
  const items = async () => (bucket.list ? (await bucket.list({ prefix: `${DROP_PREFIX}${token}/p-` })).objects.map((o) => o.key) : []);

  // the phone sends a batch
  if (req.method === 'POST') {
    if (Number(req.headers.get('content-length') ?? 0) > MAX_BATCH_BYTES) return json(413, { error: 'too much at once: send fewer photos at a time' });
    const body = await req.arrayBuffer();
    if (body.byteLength > MAX_BATCH_BYTES) return json(413, { error: 'too much at once: send fewer photos at a time' });
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder().decode(body)); } catch { return json(400, { error: 'not JSON' }); }
    const list = (parsed as { photos?: unknown })?.photos;
    if (!Array.isArray(list) || !list.length) return json(400, { error: 'no photos' });
    if (list.length > MAX_PHOTOS) return json(413, { error: `at most ${MAX_PHOTOS} photos at a time` });
    if ((await items()).length >= MAX_BATCHES) return json(429, { error: 'this box is full: collect on the computer, or open a new one' });
    const photos = list.map(cleanDropPhoto).filter((x): x is DropPhoto => x !== null);
    if (!photos.length) return json(400, { error: 'no photos' });
    await bucket.put(`${DROP_PREFIX}${token}/p-${now}-${newShareToken(random).slice(0, 6)}`, enc({ photos }));
    return json(200, { ok: true, received: photos.length, expiresAt });
  }

  // the computer collects what has arrived; it is deleted here, so each batch is handed over once
  if (req.method === 'GET') {
    const keys = (await items()).sort();
    const photos: DropPhoto[] = [];
    for (const k of keys) {
      const f = await bucket.get(k);
      if (!f) continue;
      try { photos.push(...((JSON.parse(new TextDecoder().decode(await f.arrayBuffer())) as { photos: DropPhoto[] }).photos ?? [])); } catch { /* skip a damaged batch */ }
    }
    if (keys.length) await bucket.delete(keys);
    return json(200, { photos, expiresAt });
  }
  return json(405, { error: 'GET or POST' });
}
