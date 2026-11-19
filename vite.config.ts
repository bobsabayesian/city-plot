import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { Readable } from 'node:stream';
import { handleApi } from './worker/api.ts';
import { handleProjects } from './worker/projects.ts';
import { handleShare } from './worker/share.ts';
import { handleDrop } from './worker/drop.ts';
import { memoryBucket } from './worker/memoryBucket.ts';

/**
 * Serve /api/* from the same handlers the Cloudflare Worker uses, so `npm run dev` needs no second process. Saved
 * projects, share links and the photo drop use a bucket kept in memory (lost when the dev server stops).
 */
const bucket = memoryBucket();
const devApi = {
  name: 'dev-api',
  configureServer(server: import('vite').ViteDevServer) {
    server.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith('/api/')) return next();
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = chunks.length && req.method !== 'GET' && req.method !== 'HEAD' ? Buffer.concat(chunks) : undefined;
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
      const request = new Request(`http://localhost${req.url}`, { method: req.method, headers, body });
      const out = (await handleDrop(request.clone(), bucket)) ?? (await handleShare(request.clone(), bucket)) ?? (await handleProjects(request.clone(), bucket))
        ?? (await handleApi(new Request(`http://localhost${req.url}`, { method: req.method })));
      if (!out) return next();
      res.statusCode = out.status;
      out.headers.forEach((v, k) => res.setHeader(k, v));
      Readable.fromWeb(out.body as any).pipe(res);
    });
  },
};

export default defineConfig({
  plugins: [react(), devApi],
  test: { include: ['test/**/*.test.{ts,tsx}'] },
});
