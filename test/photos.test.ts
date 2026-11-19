import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { photoDate, readPhotoInfo } from '../src/photos';

// small real files written by libvips (sharp): JPEG with EXIF, and AVIF, which is the same HEIF container as an iPhone's HEIC
const file = (name: string) => { const b = readFileSync(`test/fixtures/photos/${name}`); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const NEEDLE = { lat: 47 + 37 / 60 + 13.8 / 3600, lon: -(122 + 20 / 60 + 57.48 / 3600) };

/** A big-endian ("MM") JPEG with just a GPS position, built by hand: some cameras write EXIF that way round. */
function bigEndianJpeg(lat: [number, number, number], ns: string, lon: [number, number, number], ew: string): ArrayBuffer {
  const t: number[] = [];
  const u16 = (n: number) => t.push((n >> 8) & 255, n & 255);
  const u32 = (n: number) => t.push((n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255);
  // TIFF header, IFD0 at 8 with one entry (GPS pointer -> 26)
  t.push(0x4d, 0x4d); u16(42); u32(8);
  u16(1); u16(0x8825); u16(4); u32(1); u32(26); u32(0);
  // GPS IFD at 26: four entries, then the six rationals at 26 + 2 + 4*12 + 4 = 80
  u16(4);
  u16(1); u16(2); u32(2); t.push(ns.charCodeAt(0), 0, 0, 0);
  u16(2); u16(5); u32(3); u32(80);
  u16(3); u16(2); u32(2); t.push(ew.charCodeAt(0), 0, 0, 0);
  u16(4); u16(5); u32(3); u32(104);
  u32(0);
  for (const x of [...lat, ...lon]) { u32(Math.round(x * 100)); u32(100); }
  const seg = [0x45, 0x78, 0x69, 0x66, 0, 0, ...t];
  const len = seg.length + 2;
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, len >> 8, len & 255, ...seg, 0xff, 0xd9]).buffer;
}

describe('reading where and when a photo was taken', () => {
  it('a JPEG: its GPS position and the time it was taken', () => {
    const p = readPhotoInfo(file('needle.jpg'));
    expect(p.lat).toBeCloseTo(NEEDLE.lat, 6);
    expect(p.lon).toBeCloseTo(NEEDLE.lon, 6);
    expect(p.takenAt).toBe('2014-06-21T15:42:07');
  });

  it('a HEIF file (the container iPhones use): the same, from its Exif item', () => {
    const p = readPhotoInfo(file('needle.avif'));
    expect(p.lat).toBeCloseTo(NEEDLE.lat, 6);
    expect(p.lon).toBeCloseTo(NEEDLE.lon, 6);
    expect(p.takenAt).toBe('2014-06-21T15:42:07');
  });

  it('south and east come out negative and positive', () => {
    const p = readPhotoInfo(file('sydney.jpg'));
    expect(p.lat).toBeCloseTo(-(33 + 51 / 60 + 24.48 / 3600), 6);
    expect(p.lon).toBeCloseTo(151 + 12 / 60 + 55.08 / 3600, 6);
  });

  it('big-endian EXIF', () => {
    const p = readPhotoInfo(bigEndianJpeg([51, 30, 26.4], 'N', [0, 7, 39.6], 'W'));
    expect(p.lat).toBeCloseTo(51 + 30 / 60 + 26.4 / 3600, 6);
    expect(p.lon).toBeCloseTo(-(7 / 60 + 39.6 / 3600), 6);
  });

  it('a photo whose location was stripped still gives its date; one with no EXIF gives nothing', () => {
    expect(readPhotoInfo(file('no-gps.jpg'))).toEqual({ takenAt: '2019-12-31T23:59:58' });
    expect(readPhotoInfo(file('no-exif.jpg'))).toEqual({});
  });

  it('a 0, 0 position (a camera with no fix) is no position', () => {
    expect(readPhotoInfo(bigEndianJpeg([0, 0, 0], 'N', [0, 0, 0], 'E')).lat).toBeUndefined();
  });

  it('never throws on junk, a truncated file, or a PNG', () => {
    expect(readPhotoInfo(new ArrayBuffer(0))).toEqual({});
    expect(readPhotoInfo(Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 0x45]).buffer)).toEqual({});
    expect(readPhotoInfo(file('needle.jpg').slice(0, 60))).toEqual({});
    expect(readPhotoInfo(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 0]).buffer)).toEqual({});
    const noise = new Uint8Array(4000);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 7919) & 255;
    expect(() => readPhotoInfo(noise.buffer)).not.toThrow();
  });

  it('dates for stop names', () => {
    expect(photoDate('2014-06-21T15:42:07')).toBe('21 Jun 2014');
  });
});
