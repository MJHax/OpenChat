import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync } from 'node:fs';
import { openDb } from './db';
import { createApp } from './app';
import { createOpenRouterClient } from './openrouter';
import { cleanupPending } from './attachments';
import { failInterruptedGenerations } from './imageGen';
import { createVideoPoller } from './videoJobs';
import { dirname, join } from 'node:path';

try {
  process.loadEnvFile('.env');
} catch {
  // no .env file — the key can be set in Settings instead
}

const dbFile = process.env.OPENCHAT_DB ?? 'data/openchat.db';
const db = openDb(dbFile);
cleanupPending(db);
failInterruptedGenerations(db);
const deps = { db, openrouter: createOpenRouterClient(), env: process.env, mediaDir: join(dirname(dbFile), 'videos') };
const app = createApp(deps);
// Video jobs keep running on OpenRouter while OpenChat is off; this checks them at once, then every 15 s.
createVideoPoller(deps).start();

// In `npm start`, serve the built frontend. In `npm run dev`, Vite serves it instead.
if (existsSync('dist')) app.use('/*', serveStatic({ root: './dist' }));

const port = Number(process.env.OPENCHAT_PORT ?? 3000);
serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
  console.log(`OpenChat server running at http://127.0.0.1:${info.port}`);
});
