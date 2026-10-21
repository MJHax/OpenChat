import { describe, it, expect, afterEach } from 'vitest';
import { makeApp } from './appHelpers';
import { startFakeLocalServer, type FakeServer } from '../../test/fakeLocalServer';
import { now } from '../src/db';

const fakes: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((f) => f.close()));
});
async function fake(flavor: 'ollama' | 'lmstudio' | 'openai', models = [{ name: 'qwen3:1.7b', tools: true, thinking: true, contextLength: 40960 }, { name: 'gemma3:1b' }]) {
  const f = await startFakeLocalServer({ flavor, models });
  fakes.push(f);
  return f;
}
/** Detection candidates point at fakes, never at the real ports 11434 and 1234. */
function appWith(candidates: { type: 'ollama' | 'lmstudio'; baseUrl: string }[]) {
  const t = makeApp();
  t.deps.localCandidates = candidates;
  return t;
}
const portOf = (url: string) => new URL(url).port;

describe('local server routes', () => {
  it('adds a detected server once', async () => {
    const f = await fake('ollama');
    const { call } = appWith([{ type: 'ollama', baseUrl: f.url }]);
    const first = await (await call('GET', '/api/local-servers')).json();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ name: 'Ollama', auto: true, enabled: true, online: true, modelCount: 2, error: null });
    const second = await (await call('GET', '/api/local-servers')).json();
    expect(second).toHaveLength(1);
    expect(second[0].id).toBe(first[0].id);
  });

  it('keeps a removed server removed until Detect is pressed', async () => {
    const f = await fake('ollama');
    const { call } = appWith([{ type: 'ollama', baseUrl: f.url }]);
    const [s] = await (await call('GET', '/api/local-servers')).json();
    expect((await call('DELETE', `/api/local-servers/${s.id}`)).status).toBe(200);
    expect(await (await call('GET', '/api/local-servers')).json()).toEqual([]);
    const detected = await (await call('POST', '/api/local-servers/detect')).json();
    expect(detected.map((d: any) => d.id)).toEqual([s.id]);
  });

  it('reads a hanging server as offline without waiting long', async () => {
    const f = await fake('ollama');
    const { call } = appWith([{ type: 'ollama', baseUrl: f.url }]);
    await call('GET', '/api/local-servers');
    f.hang(true);
    const started = Date.now();
    const res = await call('GET', '/api/local-servers');
    expect(Date.now() - started).toBeLessThan(3000);
    const [s] = await res.json();
    expect(s).toMatchObject({ online: false, modelCount: null });
    expect(s.error).toMatch(/^Can't reach/);
  });

  it('does not wait twice for a hanging candidate that is not listed yet', async () => {
    const f = await fake('ollama');
    f.hang(true);
    const { call } = appWith([{ type: 'ollama', baseUrl: f.url }]);
    const started = Date.now();
    expect(await (await call('GET', '/api/local-servers')).json()).toEqual([]);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('adds a server at a normalized address and refuses a duplicate or an unreachable one', async () => {
    const f = await fake('lmstudio');
    const { call } = appWith([]);
    const port = portOf(f.url);
    const created = await call('POST', '/api/local-servers', { type: 'lmstudio', name: 'My LM', baseUrl: `localhost:${port}/v1/` });
    expect(created.status).toBe(201);
    const [s] = await created.json();
    expect(s).toMatchObject({ name: 'My LM', baseUrl: `http://localhost:${port}`, auto: false, online: true });
    const dup = await call('POST', '/api/local-servers', { type: 'lmstudio', name: 'Again', baseUrl: `http://localhost:${port}` });
    expect(dup.status).toBe(409);

    const closed = await fake('ollama');
    const closedUrl = closed.url;
    await closed.close();
    const bad = await call('POST', '/api/local-servers', { type: 'ollama', name: 'Nope', baseUrl: closedUrl });
    expect(bad.status).toBe(400);
    const closedHost = new URL(closedUrl).host;
    expect((await bad.json()).error).toBe(`Couldn't connect: Can't reach Nope at ${closedHost}. Is it running?`);
  });

  it('says an address is not that kind of server when it answers with an error', async () => {
    const other = await fake('openai');
    const { call } = appWith([]);
    const bad = await call('POST', '/api/local-servers', { type: 'ollama', name: 'Mine', baseUrl: other.url });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe(`Couldn't connect: ${other.url} doesn't look like an Ollama server.`);
    const lm = await call('POST', '/api/local-servers', { type: 'lmstudio', name: 'Mine', baseUrl: other.url });
    expect((await lm.json()).error).toBe(`Couldn't connect: ${other.url} doesn't look like an LM Studio server.`);
  });

  it('validates the body', async () => {
    const { call } = appWith([]);
    const err = async (body: object) => (await (await call('POST', '/api/local-servers', body)).json()).error;
    expect(await err({ type: 'x', name: 'A', baseUrl: 'localhost:1' })).toBe('type must be ollama, lmstudio or openai.');
    expect(await err({ type: 'ollama', name: ' ', baseUrl: 'localhost:1' })).toBe('Name is required.');
    expect(await err({ type: 'ollama', name: 'A', baseUrl: 'ftp://x' })).toBe('Enter an address like http://localhost:11434.');
  });

  it('answers 404 for an unknown or removed server', async () => {
    const f = await fake('ollama');
    const { call } = appWith([{ type: 'ollama', baseUrl: f.url }]);
    const [s] = await (await call('GET', '/api/local-servers')).json();
    await call('DELETE', `/api/local-servers/${s.id}`);
    for (const [method, id, body] of [['DELETE', 'nope', undefined], ['PATCH', 'nope', { name: 'x' }], ['DELETE', s.id, undefined], ['PATCH', s.id, { name: 'x' }]] as const) {
      const res = await call(method, `/api/local-servers/${id}`, body);
      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe("That server isn't in your list.");
    }
  });

  it('renames, turns off, and connection-checks a new address on PATCH', async () => {
    const a = await fake('ollama');
    const b = await fake('ollama');
    const { call } = appWith([{ type: 'ollama', baseUrl: a.url }]);
    const [s] = await (await call('GET', '/api/local-servers')).json();
    const off = await (await call('PATCH', `/api/local-servers/${s.id}`, { name: 'Mine', enabled: false })).json();
    expect(off[0]).toMatchObject({ name: 'Mine', enabled: false, online: false, modelCount: null, error: null });
    const moved = await call('PATCH', `/api/local-servers/${s.id}`, { baseUrl: b.url, enabled: true });
    expect((await moved.json())[0]).toMatchObject({ id: s.id, baseUrl: b.url, online: true });
    const closed = await fake('ollama');
    const closedUrl = closed.url;
    await closed.close();
    const bad = await call('PATCH', `/api/local-servers/${s.id}`, { baseUrl: closedUrl });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe(`Couldn't connect: Can't reach Mine at ${new URL(closedUrl).host}. Is it running?`);
  });

  it('lists models and refreshes the capabilities of stored ones', async () => {
    const f = await fake('ollama');
    const { call, db } = appWith([{ type: 'ollama', baseUrl: f.url }]);
    const [s] = await (await call('GET', '/api/local-servers')).json();
    const stored = `local:${s.id}:qwen3:1.7b`;
    db.prepare('INSERT INTO models (id, display_name, context_length, supports_tools, supports_reasoning, input_modalities, added_at) VALUES (?, ?, ?, 0, 0, ?, ?)').run(stored, 'qwen3:1.7b', 1000, '["text"]', now());
    const catalog = await (await call('GET', '/api/local-servers/models')).json();
    expect(catalog.servers).toHaveLength(1);
    expect(catalog.models.map((m: any) => m.id)).toContain(stored);
    expect(catalog.models.find((m: any) => m.id === stored)).toMatchObject({ serverId: s.id, name: 'qwen3:1.7b', contextLength: 40960, supportsTools: true, supportsReasoning: true });
    const row = db.prepare('SELECT context_length, supports_tools, supports_reasoning FROM models WHERE id = ?').get(stored);
    expect(row).toEqual({ context_length: 40960, supports_tools: 1, supports_reasoning: 1 });
  });

  it('leaves stored capabilities alone when a listing could not read them', async () => {
    const f = await fake('ollama');
    const { call, db } = appWith([{ type: 'ollama', baseUrl: f.url }]);
    const [s] = await (await call('GET', '/api/local-servers')).json();
    const stored = `local:${s.id}:qwen3:1.7b`;
    db.prepare('INSERT INTO models (id, display_name, context_length, supports_tools, supports_reasoning, input_modalities, added_at) VALUES (?, ?, ?, 1, 1, ?, ?)').run(stored, 'qwen3:1.7b', 40960, '["text"]', now());
    // The model is listed by /api/tags but /api/show no longer knows it.
    f.setModels([{ name: 'qwen3:1.7b' }]);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      if (String(input?.url ?? input).endsWith('/api/show')) return new Response('{"error":"gone"}', { status: 500 });
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      const catalog = await (await call('GET', '/api/local-servers/models')).json();
      expect(catalog.models[0].capsKnown).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
    const row = db.prepare('SELECT context_length, supports_tools, supports_reasoning FROM models WHERE id = ?').get(stored);
    expect(row).toEqual({ context_length: 40960, supports_tools: 1, supports_reasoning: 1 });
  });
});
