import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { DB } from './db';
import type { OpenRouterClient } from './openrouter';
import type { Env } from './settings';
import { HttpError } from './http';
import { settingsRoutes } from './routes/settings';
import { memoryRoutes } from './routes/memories';
import { modelRoutes } from './routes/models';
import { chatRoutes } from './routes/chats';
import { searchRoutes } from './routes/search';
import { generationRoutes } from './routes/generate';

export interface Deps {
  db: DB;
  openrouter: OpenRouterClient;
  env: Env;
}

export function createApp(deps: Deps): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as ContentfulStatusCode);
    console.error(err);
    return c.json({ error: 'Internal server error' }, 500);
  });

  app.route('/api/settings', settingsRoutes(deps));
  app.route('/api/memories', memoryRoutes(deps));
  app.route('/api/models', modelRoutes(deps));
  app.route('/api/chats', chatRoutes(deps));
  app.route('/api/chats', generationRoutes(deps));
  app.route('/api/search', searchRoutes(deps));

  return app;
}
