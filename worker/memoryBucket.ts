import type { Bucket } from './projects';
import type { ShareBucket } from './share';

/**
 * An R2 bucket kept in memory, for `npm run dev` (and tests): saved projects, share links and the photo drop then
 * work locally without Cloudflare. Everything is lost when the dev server stops.
 */
export function memoryBucket(): Bucket & ShareBucket {
  const store = new Map<string, { data: ArrayBuffer; uploaded: Date; customMetadata?: Record<string, string> }>();
  const toBuf = (v: string | ArrayBuffer) => (typeof v === 'string' ? (new TextEncoder().encode(v).buffer as ArrayBuffer) : v.slice(0));
  const obj = (k: string) => {
    const o = store.get(k)!;
    return { key: k, size: o.data.byteLength, uploaded: o.uploaded, customMetadata: o.customMetadata,
      text: async () => new TextDecoder().decode(o.data), arrayBuffer: async () => o.data.slice(0) };
  };
  return {
    async get(k) { return store.has(k) ? obj(k) : null; },
    async head(k) { return store.has(k) ? obj(k) : null; },
    async put(k, v, opts) { store.set(k, { data: toBuf(v), uploaded: new Date(), customMetadata: (opts as { customMetadata?: Record<string, string> })?.customMetadata }); return {}; },
    async delete(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k); },
    async list(opts) {
      const objects = [...store.keys()].filter((k) => k.startsWith(opts.prefix)).sort().slice(0, (opts as { limit?: number }).limit ?? 1000).map(obj);
      return { objects, truncated: false };
    },
  } as Bucket & ShareBucket;
}
