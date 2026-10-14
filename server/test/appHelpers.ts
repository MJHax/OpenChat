import { openDb } from '../src/db';
import { createApp } from '../src/app';
import type { OpenRouterClient } from '../src/openrouter';
import type { Env } from '../src/settings';
import { parseSSE } from '../../shared/sse';

export function makeApp(openrouter: Partial<OpenRouterClient> = {}, env: Env = { OPENROUTER_API_KEY: 'sk-or-test-1234567890' }) {
  const db = openDb(':memory:');
  const client: OpenRouterClient = {
    listModels: async () => [],
    checkKey: async () => {},
    complete: async () => 'A title',
    streamChat: async function* () {},
    ...openrouter,
  };
  const app = createApp({ db, openrouter: client, env });
  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { db, app, call };
}

export async function readEvents(res: Response): Promise<{ event: string; data: any }[]> {
  const out: { event: string; data: any }[] = [];
  for await (const e of parseSSE(res.body!)) out.push({ event: e.event, data: JSON.parse(e.data) });
  return out;
}
