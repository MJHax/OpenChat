import { openDb } from '../src/db';
import { createApp } from '../src/app';
import type { OpenRouterClient } from '../src/openrouter';
import type { Env } from '../src/settings';
import { parseSSE } from '../../shared/sse';

export function makeApp(openrouter: Partial<OpenRouterClient> = {}, env: Env = { OPENROUTER_API_KEY: 'sk-or-test-1234567890' }) {
  const db = openDb(':memory:');
  const client: OpenRouterClient = {
    listModels: async () => [],
    listCategory: async () => [],
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
  /** POSTs one file to /api/attachments as multipart form data. */
  const upload = (data: Uint8Array | string, filename: string) => {
    const form = new FormData();
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    form.append('file', new File([new Uint8Array(bytes)], filename));
    return app.request('/api/attachments', { method: 'POST', body: form });
  };
  return { db, app, call, upload };
}

export async function readEvents(res: Response): Promise<{ event: string; data: any }[]> {
  const out: { event: string; data: any }[] = [];
  for await (const e of parseSSE(res.body!)) out.push({ event: e.event, data: JSON.parse(e.data) });
  return out;
}
