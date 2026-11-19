/**
 * Where and when a photo was taken, read from its EXIF data on the device: the photo itself is never uploaded.
 * Handles JPEG (most phones, and what an iPhone sends a website by default) and HEIC/HEIF (iPhone originals).
 *
 * Phones often strip the location when a photo is picked in a browser (iPhone Safari unless "Location" is turned on
 * in the picker's options; Android Chrome's photo picker), so a photo without one is normal, not an error.
 */
export interface PhotoInfo {
  lat?: number;
  lon?: number;
  /** when it was taken, as the camera's local time "YYYY-MM-DDTHH:MM:SS" (EXIF keeps no time zone) */
  takenAt?: string;
}

/** Read the EXIF of a JPEG or HEIC file. Anything unreadable gives an empty result, never an exception. */
export function readPhotoInfo(buf: ArrayBuffer): PhotoInfo {
  try {
    const v = new DataView(buf);
    if (v.byteLength > 4 && v.getUint16(0) === 0xffd8) return tiff(v, jpegExif(v));
    if (v.byteLength > 12 && fourcc(v, 4) === 'ftyp') return tiff(v, heifExif(v));
  } catch { /* a damaged or unusual file: no information */ }
  return {};
}

const fourcc = (v: DataView, at: number) => String.fromCharCode(v.getUint8(at), v.getUint8(at + 1), v.getUint8(at + 2), v.getUint8(at + 3));

/** Offset of the TIFF header inside a JPEG's APP1 "Exif" segment, or -1. */
function jpegExif(v: DataView): number {
  let at = 2;
  while (at + 4 <= v.byteLength) {
    if (v.getUint8(at) !== 0xff) return -1;
    const marker = v.getUint8(at + 1);
    if (marker === 0xda || marker === 0xd9) return -1; // image data starts: no EXIF before it
    const len = v.getUint16(at + 2);
    if (marker === 0xe1 && fourcc(v, at + 4) === 'Exif' && v.getUint16(at + 8) === 0) return at + 10;
    at += 2 + len;
  }
  return -1;
}

/** Offset of the TIFF header inside a HEIF file's Exif item, or -1. ISO BMFF: meta > iinf (which item is Exif) and iloc (where it is). */
function heifExif(v: DataView): number {
  const boxes = (start: number, end: number): { type: string; at: number; body: number; end: number }[] => {
    const out = [];
    let at = start;
    while (at + 8 <= end) {
      let size = v.getUint32(at);
      let body = at + 8;
      if (size === 1) { size = Number(v.getBigUint64(at + 8)); body = at + 16; } else if (size === 0) size = end - at;
      if (size < 8 || at + size > end) break;
      out.push({ type: fourcc(v, at + 4), at, body, end: at + size });
      at += size;
    }
    return out;
  };
  const meta = boxes(0, v.byteLength).find((b) => b.type === 'meta');
  if (!meta) return -1;
  const inner = boxes(meta.body + 4, meta.end); // meta is a full box: version and flags first
  const iinf = inner.find((b) => b.type === 'iinf');
  const iloc = inner.find((b) => b.type === 'iloc');
  if (!iinf || !iloc) return -1;

  // which item is the Exif block
  const iv = v.getUint8(iinf.body);
  const infeStart = iinf.body + 4 + (iv === 0 ? 2 : 4);
  let exifId = -1;
  for (const e of boxes(infeStart, iinf.end)) {
    if (e.type !== 'infe') continue;
    const ev = v.getUint8(e.body);
    if (ev < 2) continue;
    const id = ev === 2 ? v.getUint16(e.body + 4) : v.getUint32(e.body + 4);
    const typeAt = e.body + 4 + (ev === 2 ? 2 : 4) + 2;
    if (fourcc(v, typeAt) === 'Exif') { exifId = id; break; }
  }
  if (exifId < 0) return -1;

  // where it is
  const lv = v.getUint8(iloc.body);
  let at = iloc.body + 4;
  const sizes = v.getUint16(at);
  at += 2;
  const offSize = sizes >> 12, lenSize = (sizes >> 8) & 15, baseSize = (sizes >> 4) & 15, idxSize = lv >= 1 ? sizes & 15 : 0;
  const read = (n: number) => { const x = n === 0 ? 0 : n === 4 ? v.getUint32(at) : n === 8 ? Number(v.getBigUint64(at)) : n === 2 ? v.getUint16(at) : -1; at += n; return x; };
  const count = lv < 2 ? read(2) : read(4);
  for (let i = 0; i < count; i++) {
    const id = lv < 2 ? read(2) : read(4);
    if (lv >= 1) read(2); // construction method
    read(2); // data reference index
    const base = read(baseSize);
    const extents = read(2);
    let first = -1;
    for (let k = 0; k < extents; k++) {
      if (idxSize) read(idxSize);
      const off = read(offSize);
      read(lenSize);
      if (k === 0) first = base + off;
    }
    if (id === exifId && first >= 0) {
      // the item starts with the offset of the TIFF header within it (after an "Exif\0\0" prefix, usually 6)
      return first + 4 + v.getUint32(first);
    }
  }
  return -1;
}

/** GPS position and capture time from the TIFF structure at `t`. */
function tiff(v: DataView, t: number): PhotoInfo {
  if (t < 0 || t + 8 > v.byteLength) return {};
  const little = v.getUint16(t) === 0x4949;
  if (!little && v.getUint16(t) !== 0x4d4d) return {};
  const u16 = (at: number) => v.getUint16(at, little);
  const u32 = (at: number) => v.getUint32(at, little);
  const SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
  /** the entries of an IFD: tag -> where its value is, and how many */
  const ifd = (off: number) => {
    const out = new Map<number, { type: number; count: number; at: number }>();
    const base = t + off;
    if (off <= 0 || base + 2 > v.byteLength) return out;
    const n = u16(base);
    for (let i = 0; i < n; i++) {
      const e = base + 2 + i * 12;
      if (e + 12 > v.byteLength) break;
      const type = u16(e + 2), count = u32(e + 4);
      const size = (SIZE[type] ?? 1) * count;
      out.set(u16(e), { type, count, at: size <= 4 ? e + 8 : t + u32(e + 8) });
    }
    return out;
  };
  const ascii = (x?: { count: number; at: number }) => {
    if (!x) return undefined;
    let s = '';
    for (let i = 0; i < x.count && x.at + i < v.byteLength; i++) { const c = v.getUint8(x.at + i); if (!c) break; s += String.fromCharCode(c); }
    return s;
  };
  const rational = (at: number) => { const d = u32(at + 4); return d ? u32(at) / d : NaN; };
  const dms = (x?: { count: number; at: number }) => (x && x.count >= 3 ? rational(x.at) + rational(x.at + 8) / 60 + rational(x.at + 16) / 3600 : NaN);

  const ifd0 = ifd(u32(t + 4));
  const out: PhotoInfo = {};
  const exifPtr = ifd0.get(0x8769);
  if (exifPtr) {
    const ex = ifd(u32(exifPtr.at));
    const when = ascii(ex.get(0x9003)) ?? ascii(ex.get(0x9004)) ?? ascii(ifd0.get(0x0132));
    const m = when?.match(/^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/);
    if (m && m[1] !== '0000') out.takenAt = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  }
  const gpsPtr = ifd0.get(0x8825);
  if (gpsPtr) {
    const g = ifd(u32(gpsPtr.at));
    const lat = dms(g.get(2)), lon = dms(g.get(4));
    const ns = ascii(g.get(1)), ew = ascii(g.get(3));
    // 0, 0 is what some cameras write when they had no fix
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && (lat !== 0 || lon !== 0)) {
      out.lat = ns === 'S' ? -lat : lat;
      out.lon = ew === 'W' ? -lon : lon;
    }
  }
  return out;
}

/** "12 Jun 2014" for a stop's name. */
export function photoDate(takenAt: string): string {
  const [y, m, d] = takenAt.slice(0, 10).split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d} ${months[(m ?? 1) - 1]} ${y}`;
}
