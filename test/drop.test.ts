import { describe, expect, it } from 'vitest';
import { cleanDropPhoto, DROP_PREFIX, DROP_TTL_MS, handleDrop, MAX_BATCHES, MAX_PHOTOS, sweepDrops } from '../worker/drop';
import { memoryBucket } from '../worker/memoryBucket';
import { dropLink, dropTokenHere, qrSvg } from '../src/drop';

const req = (method: string, path: string, body?: unknown) =>
  new Request(`https://city.example${path}`, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) });
const THUMB = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
const photo = (extra: Record<string, unknown> = {}) => ({ file: 'IMG_1.jpg', info: { lat: 47.62, lon: -122.35, takenAt: '2014-06-21T15:42:07' }, thumb: THUMB, ...extra });

async function open(bucket = memoryBucket(), now = 1_000_000) {
  const res = await handleDrop(req('POST', '/api/drop'), bucket, now);
  const { token, expiresAt } = (await res!.json()) as { token: string; expiresAt: number };
  return { bucket, token, expiresAt };
}

describe('the photo drop box (Worker)', () => {
  it('the computer opens a box: a 16-character token, good for an hour', async () => {
    const { token, expiresAt } = await open();
    expect(token).toMatch(/^[2-9a-hjkmnp-z]{16}$/);
    expect(expiresAt).toBe(1_000_000 + DROP_TTL_MS);
  });

  it('the phone sends batches; the computer collects them all once, in order, and they are then gone', async () => {
    const { bucket, token } = await open();
    expect((await handleDrop(req('POST', `/api/drop/${token}`, { photos: [photo({ file: 'a.jpg' })] }), bucket, 1_000_100))!.status).toBe(200);
    expect((await handleDrop(req('POST', `/api/drop/${token}`, { photos: [photo({ file: 'b.jpg' }), photo({ file: 'c.jpg' })] }), bucket, 1_000_200))!.status).toBe(200);
    const got = (await (await handleDrop(req('GET', `/api/drop/${token}`), bucket, 1_000_300))!.json()) as { photos: { file: string }[] };
    expect(got.photos.map((p) => p.file)).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
    const again = (await (await handleDrop(req('GET', `/api/drop/${token}`), bucket, 1_000_400))!.json()) as { photos: unknown[] };
    expect(again.photos).toEqual([]);
    // nothing of the photos is left on the server; only the box marker until it expires
    expect((await bucket.list!({ prefix: `${DROP_PREFIX}${token}/` })).objects.map((o) => o.key)).toEqual([`${DROP_PREFIX}${token}/box`]);
  });

  it('an hour on, the box is gone, and so is anything left in it', async () => {
    const { bucket, token } = await open();
    await handleDrop(req('POST', `/api/drop/${token}`, { photos: [photo()] }), bucket, 1_000_100);
    const late = 1_000_000 + DROP_TTL_MS;
    const res = await handleDrop(req('POST', `/api/drop/${token}`, { photos: [photo()] }), bucket, late);
    expect(res!.status).toBe(404);
    expect(((await res!.json()) as { error: string }).error).toMatch(/expired/);
    expect((await bucket.list!({ prefix: DROP_PREFIX })).objects).toHaveLength(0);
  });

  it('no box, no upload: a made-up or malformed token is refused', async () => {
    const bucket = memoryBucket();
    expect((await handleDrop(req('POST', '/api/drop/abcdefghjkmnpqrs', { photos: [photo()] }), bucket))!.status).toBe(404);
    expect((await handleDrop(req('GET', '/api/drop/..%2Fsecret'), bucket))!.status).toBe(400);
  });

  it('limits: photos per batch, batches per box, and no box without a bucket', async () => {
    const { bucket, token } = await open();
    const many = Array.from({ length: MAX_PHOTOS + 1 }, () => photo());
    expect((await handleDrop(req('POST', `/api/drop/${token}`, { photos: many }), bucket, 1_000_100))!.status).toBe(413);
    for (let i = 0; i < MAX_BATCHES; i++) await handleDrop(req('POST', `/api/drop/${token}`, { photos: [photo()] }), bucket, 1_000_100 + i);
    expect((await handleDrop(req('POST', `/api/drop/${token}`, { photos: [photo()] }), bucket, 1_000_200))!.status).toBe(429);
    expect((await handleDrop(req('POST', '/api/drop'), undefined))!.status).toBe(503);
    expect(await handleDrop(req('GET', '/api/other'), bucket)).toBeNull();
  });

  it('a batch that is not JSON, or has no photos, is refused', async () => {
    const { bucket, token } = await open();
    const bad = new Request(`https://city.example/api/drop/${token}`, { method: 'POST', body: 'not json' });
    expect((await handleDrop(bad, bucket, 1_000_100))!.status).toBe(400);
    expect((await handleDrop(req('POST', `/api/drop/${token}`, { photos: [] }), bucket, 1_000_100))!.status).toBe(400);
  });

  it('old boxes are swept away when a new one opens', async () => {
    const bucket = memoryBucket();
    await bucket.put(`${DROP_PREFIX}oldoldoldoldoldo/box`, '{}');
    const removed = await sweepDrops(bucket, Date.now() + DROP_TTL_MS + 1);
    expect(removed).toBe(1);
  });
});

describe('what a phone may send', () => {
  it('keeps a well-formed photo as it is', () => {
    expect(cleanDropPhoto(photo())).toEqual(photo());
  });
  it('drops a position out of range, a date in another form, and anything that is not a small JPEG data URL', () => {
    const p = cleanDropPhoto({ file: 'x.jpg', info: { lat: 123, lon: 0, takenAt: 'yesterday' }, thumb: 'data:image/svg+xml;base64,PHN2Zz4=' })!;
    expect(p).toEqual({ file: 'x.jpg', info: {} });
    expect(cleanDropPhoto({ ...photo(), thumb: `data:image/jpeg;base64,${'A'.repeat(100_000)}` })!.thumb).toBeUndefined();
    expect(cleanDropPhoto({ ...photo(), thumb: 'javascript:alert(1)' })!.thumb).toBeUndefined();
  });
  it('trims the file name and strips control characters; junk is not a photo', () => {
    expect(cleanDropPhoto({ file: `a\u0000b${'c'.repeat(300)}`, info: {} })!.file).toHaveLength(120);
    expect(cleanDropPhoto(null)).toBeNull();
    expect(cleanDropPhoto('photo')).toBeNull();
    expect(cleanDropPhoto({ info: {} })!.file).toBe('photo');
  });
});

describe('the link and its QR code', () => {
  it('the phone link carries the token, and the page knows it is the phone side', () => {
    const link = dropLink('abcdefghjkmnpqrs', 'https://city.bobsabayesian.io');
    expect(link).toBe('https://city.bobsabayesian.io/?drop=abcdefghjkmnpqrs');
    expect(dropTokenHere(new URL(link).search)).toBe('abcdefghjkmnpqrs');
    expect(dropTokenHere('?drop=../../etc')).toBeUndefined();
    expect(dropTokenHere('?p=abc12345')).toBeUndefined();
  });
  it('the QR code is an SVG with a white quiet zone, black modules, and the three finder squares', async () => {
    const svg = await qrSvg('https://city.bobsabayesian.io/?drop=abcdefghjkmnpqrs');
    expect(svg).toMatch(/^<svg [^>]*viewBox="0 0 (\d+) \1"/);
    const size = +svg.match(/viewBox="0 0 (\d+)/)![1]!;
    // a version 3 or 4 code (29 or 33 modules) for a link this long, plus 4 modules of quiet zone each side
    expect([29 + 8, 33 + 8]).toContain(size);
    expect(svg).toContain('fill="#fff"');
    // the top-left finder pattern's corner module is dark, just inside the quiet zone
    expect(svg).toContain('M4 4h1v1h-1z');
  });
});
