import { handleApi, type FilesBucket } from './api';

interface Env { ASSETS: { fetch: (req: Request) => Promise<Response> }; FILES: FilesBucket }

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    return (await handleApi(req, env)) ?? env.ASSETS.fetch(req);
  },
};
