import { handleApi } from './api';
import { handleProjects, type Bucket } from './projects';
import { handleShare, type ShareBucket } from './share';

interface Env {
  ASSETS: { fetch: (req: Request) => Promise<Response> };
  /** the shared `project-files` bucket: exports, saved projects (city/) and one-hour SVG links (city/share/) */
  FILES?: Bucket & ShareBucket;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    return (await handleShare(req, env.FILES)) ?? (await handleProjects(req, env.FILES)) ?? (await handleApi(req, env)) ?? env.ASSETS.fetch(req);
  },
};
