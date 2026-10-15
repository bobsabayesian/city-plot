import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { Readable } from 'node:stream';
import { handleApi } from './worker/api.ts';

/** Serve /api/* from the same handlers the Cloudflare Worker uses, so `npm run dev` needs no second process. */
const devApi = {
  name: 'dev-api',
  configureServer(server: import('vite').ViteDevServer) {
    server.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith('/api/')) return next();
      const out = await handleApi(new Request(`http://localhost${req.url}`, { method: req.method }));
      if (!out) return next();
      res.statusCode = out.status;
      out.headers.forEach((v, k) => res.setHeader(k, v));
      Readable.fromWeb(out.body as any).pipe(res);
    });
  },
};

export default defineConfig({
  plugins: [react(), devApi],
  test: { include: ['test/**/*.test.ts'] },
});
