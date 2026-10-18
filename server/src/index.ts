import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync } from 'node:fs';
import { openDb } from './db';
import { createApp } from './app';
import { createOpenRouterClient } from './openrouter';
import { cleanupPending } from './attachments';
import { failInterruptedGenerations } from './imageGen';

try {
  process.loadEnvFile('.env');
} catch {
  // no .env file — the key can be set in Settings instead
}

const db = openDb(process.env.OPENCHAT_DB ?? 'data/openchat.db');
cleanupPending(db);
failInterruptedGenerations(db);
const app = createApp({ db, openrouter: createOpenRouterClient(), env: process.env });

// In `npm start`, serve the built frontend. In `npm run dev`, Vite serves it instead.
if (existsSync('dist')) app.use('/*', serveStatic({ root: './dist' }));

const port = Number(process.env.OPENCHAT_PORT ?? 3000);
serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
  console.log(`OpenChat server running at http://127.0.0.1:${info.port}`);
});
