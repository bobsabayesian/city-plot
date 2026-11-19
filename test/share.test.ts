import { describe, expect, it } from 'vitest';
import { handleShare, newShareToken, sweepShares, MAX_SVG_BYTES, SHARE_PREFIX, SHARE_TTL_MS, type ShareBucket } from '../worker/share';

const T0 = Date.parse('2026-11-13T12:00:00Z');
const svg = '<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>';

const fakeBucket = () => {
  const m = new Map<string, { body: ArrayBuffer; uploaded: Date }>();
  const b: ShareBucket = {
    get: async (k) => { const o = m.get(k); return o ? { arrayBuffer: async () => o.body, uploaded: o.uploaded } : null; },
    put: async (k, v) => { m.set(k, { body: v, uploaded: new Date(now) }); },
    delete: async (k) => { for (const key of Array.isArray(k) ? k : [k]) m.delete(key); },
    list: async ({ prefix, limit }) => ({ objects: [...m].filter(([k]) => k.startsWith(prefix)).slice(0, limit).map(([key, o]) => ({ key, uploaded: o.uploaded })) }),
  };
  return { b, m };
};
let now = T0;
const post = (body: BodyInit, type = 'image/svg+xml') => new Request('https://x.test/api/share', { method: 'POST', body, headers: { 'content-type': type } });
const get = (path: string) => new Request('https://x.test' + path);

describe('the 1-hour link', () => {
  it('stores the SVG under city/share/ and serves it, safely, until an hour is up', async () => {
    now = T0;
    const { b, m } = fakeBucket();
    const res = (await handleShare(post(svg), b, now))!;
    expect(res.status).toBe(200);
    const { token, path, expiresAt } = (await res.json()) as { token: string; path: string; expiresAt: number };
    expect(token).toMatch(/^[2-9a-hjkmnp-z]{16}$/);
    expect(path).toBe(`/api/share/${token}.svg`);
    expect(expiresAt).toBe(T0 + SHARE_TTL_MS);
    expect([...m.keys()]).toEqual([`${SHARE_PREFIX}${token}.svg`]);
    const got = (await handleShare(get(path), b, T0 + 59 * 60_000))!;
    expect(got.status).toBe(200);
    expect(await got.text()).toBe(svg);
    expect(got.headers.get('content-type')).toBe('image/svg+xml');
    expect(got.headers.get('content-security-policy')).toContain('sandbox');
    expect(got.headers.get('x-content-type-options')).toBe('nosniff');
    expect(got.headers.get('cache-control')).toBe('no-store');
  });
  it('is refused, and deleted, after the hour', async () => {
    now = T0;
    const { b, m } = fakeBucket();
    const { path } = (await (await handleShare(post(svg), b, now))!.json()) as { path: string };
    const late = (await handleShare(get(path), b, T0 + SHARE_TTL_MS + 1))!;
    expect(late.status).toBe(404);
    expect(((await late.json()) as { error: string }).error).toMatch(/expired/);
    expect(m.size).toBe(0);
  });
  it('each new post clears the expired ones, and leaves the fresh ones', async () => {
    const { b, m } = fakeBucket();
    now = T0; await handleShare(post(svg), b, now);
    now = T0 + 30 * 60_000; await handleShare(post(svg), b, now);
    expect(m.size).toBe(2);
    now = T0 + SHARE_TTL_MS + 5 * 60_000; // the first is old, the second is 35 minutes old
    await handleShare(post(svg), b, now);
    expect(m.size).toBe(2);
    expect(await sweepShares(b, T0 + 10 * SHARE_TTL_MS)).toBe(2);
    expect(m.size).toBe(0);
  });
  it('refuses what is not an SVG, an empty body, anything too big, and wrong methods', async () => {
    const { b, m } = fakeBucket();
    expect((await handleShare(post(svg, 'text/html'), b, T0))!.status).toBe(415);
    expect((await handleShare(post('hello'), b, T0))!.status).toBe(400);
    expect((await handleShare(post(''), b, T0))!.status).toBe(400);
    expect((await handleShare(post(svg + ' '.repeat(MAX_SVG_BYTES)), b, T0))!.status).toBe(413);
    expect((await handleShare(new Request('https://x.test/api/share', { method: 'GET' }), b, T0))!.status).toBe(405);
    expect((await handleShare(new Request('https://x.test/api/share/abcdefghjkmnpqrs.svg', { method: 'POST' }), b, T0))!.status).toBe(405);
    expect(m.size).toBe(0);
  });
  it('rejects a malformed or unknown token, says so without a bucket, and ignores other routes', async () => {
    const { b } = fakeBucket();
    expect((await handleShare(get('/api/share/short.svg'), b, T0))!.status).toBe(400);
    expect((await handleShare(get('/api/share/abcdefghjkmnpqrs.svg'), b, T0))!.status).toBe(404);
    expect((await handleShare(post(svg), undefined, T0))!.status).toBe(503);
    expect(await handleShare(get('/api/project/abcd2345'), b, T0)).toBeNull();
  });
  it('tokens are long and differ', () => {
    const t = new Set(Array.from({ length: 100 }, () => newShareToken()));
    expect(t.size).toBe(100);
    for (const x of t) expect(x).toMatch(/^[2-9a-hjkmnp-z]{16}$/);
  });
});
