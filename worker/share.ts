import { PREFIX } from './projects';

/**
 * A link to an exported SVG that works for one hour. The SVG is posted here, kept under `city/share/`, and handed out at
 * `/api/share/<token>.svg` until an hour after it was posted. R2 expires objects in whole days (and only by a bucket rule),
 * so the hour is kept here: an old file is refused and deleted when asked for, and each new post clears the expired ones.
 * The token (16 characters from 31, about 80 bits) is the only key.
 */
export const SHARE_PREFIX = PREFIX + 'share/';
export const SHARE_TTL_MS = 60 * 60 * 1000;
export const MAX_SVG_BYTES = 12 * 1024 * 1024;
const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
const TOKEN = /^[2-9a-hjkmnp-z]{16}$/;

export interface ShareBucket {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; uploaded: Date } | null>;
  put(key: string, value: ArrayBuffer, opts?: { httpMetadata?: { contentType: string } }): Promise<unknown>;
  delete(keys: string | string[]): Promise<unknown>;
  list?(opts: { prefix: string; limit?: number }): Promise<{ objects: { key: string; uploaded: Date }[] }>;
}

export function newShareToken(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  let out = '';
  while (out.length < 16) for (const b of random(32)) if (b < 248 && out.length < 16) out += ALPHABET[b % ALPHABET.length];
  return out;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

/** Delete the share files that are past their hour (a few at a time, so a post never waits long). */
export async function sweepShares(bucket: ShareBucket, now: number): Promise<number> {
  if (!bucket.list) return 0;
  const { objects } = await bucket.list({ prefix: SHARE_PREFIX, limit: 100 });
  const old = objects.filter((o) => now - o.uploaded.getTime() >= SHARE_TTL_MS).map((o) => o.key);
  if (old.length) await bucket.delete(old);
  return old.length;
}

/**
 *   POST /api/share              body: an SVG (content-type image/svg+xml)  -> { token, path, expiresAt }
 *   GET  /api/share/<token>.svg                                              -> the SVG, for an hour
 * The file is served so that nothing in it can run in this site's origin: it is only ever data to whoever fetches it.
 */
export async function handleShare(req: Request, bucket: ShareBucket | undefined, now = Date.now(), random?: (n: number) => Uint8Array): Promise<Response | null> {
  const m = /^\/api\/share(?:\/([^/]+?)(?:\.svg)?)?\/?$/.exec(new URL(req.url).pathname);
  if (!m) return null;
  if (!bucket) return json(503, { error: 'sharing is not set up on this server' });

  if (m[1] === undefined) {
    if (req.method !== 'POST') return json(405, { error: 'POST only' });
    const type = (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (type !== 'image/svg+xml') return json(415, { error: 'send an SVG' });
    if (Number(req.headers.get('content-length') ?? 0) > MAX_SVG_BYTES) return json(413, { error: 'too large' });
    const body = await req.arrayBuffer();
    if (body.byteLength === 0) return json(400, { error: 'empty' });
    if (body.byteLength > MAX_SVG_BYTES) return json(413, { error: 'too large' });
    if (!new TextDecoder().decode(body.slice(0, 2000)).includes('<svg')) return json(400, { error: 'not an SVG' });
    const token = newShareToken(random);
    await bucket.put(`${SHARE_PREFIX}${token}.svg`, body, { httpMetadata: { contentType: 'image/svg+xml' } });
    await sweepShares(bucket, now).catch(() => {});
    return json(200, { token, path: `/api/share/${token}.svg`, expiresAt: now + SHARE_TTL_MS });
  }

  if (req.method !== 'GET') return json(405, { error: 'GET only' });
  const token = decodeURIComponent(m[1]).toLowerCase();
  if (!TOKEN.test(token)) return json(400, { error: 'bad link' });
  const key = `${SHARE_PREFIX}${token}.svg`;
  const f = await bucket.get(key);
  if (!f) return json(404, { error: 'no such link' });
  if (now - f.uploaded.getTime() >= SHARE_TTL_MS) { await bucket.delete(key); return json(404, { error: 'this link has expired' }); }
  return new Response(await f.arrayBuffer(), {
    status: 200,
    headers: {
      'content-type': 'image/svg+xml',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
      'content-disposition': `inline; filename="plot-${token.slice(0, 6)}.svg"`,
    },
  });
}
