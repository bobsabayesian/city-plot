import type { PhotoIn } from './features/photoStops';

/**
 * The phone-to-computer photo drop, client side (the server side is worker/drop.ts). The computer opens a box and
 * shows a QR code of its link; the phone, on that link, reads its photos' locations and dates on the device and
 * sends those with a small thumbnail each; the computer collects them every few seconds.
 */
export interface DropItem extends PhotoIn { thumb?: string }

/** The link the phone opens: this site, with the box's token. */
export const dropLink = (token: string, origin = location.origin) => `${origin}/?drop=${encodeURIComponent(token)}`;

/** The box token in this page's address, if this page is the phone's side of a drop. */
export const dropTokenHere = (search = location.search) => {
  const t = new URLSearchParams(search).get('drop');
  return t && /^[2-9a-hjkmnp-z]{16}$/.test(t) ? t : undefined;
};

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `The server said ${res.status}`);
  return body;
}

export const openDrop = () => call<{ token: string; expiresAt: number }>('/api/drop', { method: 'POST' });
export const collectDrop = (token: string) => call<{ photos: DropItem[]; expiresAt: number }>(`/api/drop/${token}`);
export const sendDrop = (token: string, photos: DropItem[]) =>
  call<{ received: number }>(`/api/drop/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ photos }) });

/** Photos per request: thumbnails are ~10 kB, so this stays far below the server's limit even on a slow phone network. */
export const BATCH = 20;

/** A small JPEG of a photo (longest side `size` px) as a data URL, or undefined if this browser cannot decode it. */
export async function makeThumb(file: Blob, size = 160): Promise<string | undefined> {
  try {
    const bmp = await createImageBitmap(file);
    const k = size / Math.max(bmp.width, bmp.height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bmp.width * Math.min(1, k)));
    canvas.height = Math.max(1, Math.round(bmp.height * Math.min(1, k)));
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    const url = canvas.toDataURL('image/jpeg', 0.72);
    return url.startsWith('data:image/jpeg;base64,') ? url : undefined;
  } catch { return undefined; }
}

/** A QR code of `text` as SVG markup: dark modules on white, with the quiet zone round it, whatever the page's theme. */
export async function qrSvg(text: string, px = 220): Promise<string> {
  const { default: qrcode } = await import('qrcode-generator');
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const q = 4; // the quiet zone, in modules, that scanners need
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + q} ${r + q}h1v1h-1z`;
  const size = n + 2 * q;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${px}" height="${px}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
