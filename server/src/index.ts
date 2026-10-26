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
import { networkInterfaces } from 'node:os';
import { detectCandidates, detectLocalServers } from './localDetect';

try {
  process.loadEnvFile('.env');
} catch {
  // no .env file — the key can be set in Settings instead
}

const dbFile = process.env.OPENCHAT_DB ?? 'data/openchat.db';
const db = openDb(dbFile);
cleanupPending(db);
failInterruptedGenerations(db);
const localCandidates = detectCandidates(process.env.OPENCHAT_DETECT_HOST);
const deps = { db, openrouter: createOpenRouterClient(), env: process.env, mediaDir: join(dirname(dbFile), 'videos'), localCandidates };
const app = createApp(deps);
// Video jobs keep running on OpenRouter while OpenChat is off; this checks them at once, then every 15 s.
createVideoPoller(deps).start();
// Find Ollama / LM Studio already running; not awaited, so a slow or silent port never delays startup.
void detectLocalServers(db, { candidates: localCandidates }).catch(() => {});

// In `npm start`, serve the built frontend. In `npm run dev`, Vite serves it instead.
if (existsSync('dist')) app.use('/*', serveStatic({ root: './dist' }));

const port = Number(process.env.OPENCHAT_PORT ?? 3000);
// 127.0.0.1 keeps OpenChat on this machine; OPENCHAT_HOST=0.0.0.0 lets other machines on the network connect.
const hostname = process.env.OPENCHAT_HOST?.trim() || '127.0.0.1';
serve({ fetch: app.fetch, port, hostname }, (info) => {
  const everywhere = hostname === '0.0.0.0' || hostname === '::';
  console.log(`OpenChat server running at http://${everywhere ? '127.0.0.1' : hostname}:${info.port}`);
  if (!everywhere) return;
  const lan = Object.values(networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal);
  for (const a of lan) console.log(`  on your network:  http://${a!.address}:${info.port}`);
});
