import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { DB } from './db';
import type { OpenRouterClient } from './openrouter';
import type { Env } from './settings';
import { HttpError } from './http';
import { settingsRoutes } from './routes/settings';
import { memoryRoutes } from './routes/memories';
import { modelRoutes } from './routes/models';
import { mediaModelRoutes } from './routes/mediaModels';
import { imageRoutes } from './routes/images';
import { videoFileRoutes, videoGenerationRoutes } from './routes/videos';
import { chatRoutes } from './routes/chats';
import { searchRoutes } from './routes/search';
import { generationRoutes } from './routes/generate';
import { attachmentRoutes } from './routes/attachments';
import { statsRoutes } from './routes/stats';
import { contextRoutes } from './routes/context';

export interface Deps {
  db: DB;
  openrouter: OpenRouterClient;
  env: Env;
  /** Where finished video clips are stored (`<id>.mp4`). */
  mediaDir: string;
}

export function createApp(deps: Deps): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as ContentfulStatusCode);
    console.error(err);
    return c.json({ error: 'Internal server error' }, 500);
  });

  // Generated pages run in a null-origin sandbox and may navigate to any site; neither may change data here.
  app.use('/api/*', async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && (c.req.header('origin') === 'null' || c.req.header('sec-fetch-site') === 'cross-site')) {
      throw new HttpError(403, 'Cross-site requests may not change data.');
    }
    await next();
  });

  app.route('/api/settings', settingsRoutes(deps));
  app.route('/api/memories', memoryRoutes(deps));
  app.route('/api/models', modelRoutes(deps));
  app.route('/api/media-models', mediaModelRoutes(deps));
  app.route('/api/chats', chatRoutes(deps));
  app.route('/api/chats', generationRoutes(deps));
  app.route('/api/chats', imageRoutes(deps));
  app.route('/api/chats', videoGenerationRoutes(deps));
  app.route('/api/videos', videoFileRoutes(deps));
  app.route('/api/search', searchRoutes(deps));
  app.route('/api/attachments', attachmentRoutes(deps));
  app.route('/api/stats', statsRoutes(deps));
  app.route('/api/context', contextRoutes(deps));

  return app;
}
