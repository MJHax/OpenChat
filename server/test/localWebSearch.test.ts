import { afterEach, describe, expect, it } from 'vitest';
import { startFakeLocalServer, type FakeServer } from '../../test/fakeLocalServer';
import { startFakeSearchServer, type FakeSearch } from '../../test/fakeSearchServer';
import { makeApp, readEvents } from './appHelpers';
import { addServer } from '../src/localServers';
import { addModel } from '../src/library';
import { setSetting } from '../src/settings';
import { localModelId } from '../../shared/localModels';
import { withCatalogDefaults, type ChatSummary } from '../../shared/types';

let fake: FakeServer | undefined;
let search: FakeSearch | undefined;
afterEach(async () => {
  await fake?.close();
  await search?.close();
  fake = undefined;
  search = undefined;
});

const MODELS = [
  { name: 'qwen3:1.7b', tools: true, thinking: true, contextLength: 40960 },
  { name: 'gemma3:1b', contextLength: 32768 },
];

async function setup(o: { service?: 'searxng' | 'none' | null; openrouter?: Parameters<typeof makeApp>[0] } = {}) {
  fake = await startFakeLocalServer({ flavor: 'ollama', models: MODELS });
  search = await startFakeSearchServer();
  const app = makeApp(o.openrouter ?? {});
  if (o.service !== null) {
    setSetting(app.db, 'web_search_service', o.service ?? 'searxng');
    setSetting(app.db, 'searxng_url', search.url);
  }
  const server = addServer(app.db, { type: 'ollama', name: 'Ollama', baseUrl: fake.url, auto: false });
  const ids = { qwen: localModelId(server.id, 'qwen3:1.7b'), gemma: localModelId(server.id, 'gemma3:1b') };
  addModel(app.db, withCatalogDefaults({ id: ids.qwen, name: 'qwen3:1.7b', contextLength: 40960, supportsReasoning: true, supportsTools: true }));
  addModel(app.db, withCatalogDefaults({ id: ids.gemma, name: 'gemma3:1b', contextLength: 32768 }));
  const chatId = ((await (await app.call('POST', '/api/chats')).json()) as ChatSummary).id;
  return { ...app, ids, chatId, fake: fake!, search: search! };
}
type S = Awaited<ReturnType<typeof setup>>;
const chatBodies = (f: FakeServer) => f.requests.filter((r) => r.path === '/api/chat').map((r) => r.body);
const send = (s: S, body: object, chatId = s.chatId) => s.call('POST', `/api/chats/${chatId}/messages`, { content: 'Tell me about cats', ...body });
const URLS = ['https://en.wikipedia.org/wiki/Cat', 'https://example.com/cat-care', 'https://example.org/facts'];

describe('local models search the web', () => {
  it('searches with the tool for a model that supports tools', async () => {
    const s = await setup();
    s.fake.reply({ toolCalls: [{ name: 'web_search', arguments: { query: 'cats' } }] });
    s.fake.reply({ text: ['Cats ', 'are great.'] });
    const events = await readEvents(await send(s, { modelId: s.ids.qwen, webSearch: true }));
    const msg = events.find((e) => e.event === 'done')!.data.message;
    expect(msg.content).toBe('Cats are great.');
    expect(msg.sources.map((x: any) => x.url)).toEqual(URLS);
    expect(msg.webSearches).toBe(1);
    const bodies = chatBodies(s.fake).filter((b) => b.model === 'qwen3:1.7b');
    expect(bodies[0].tools).toBeDefined();
    expect(bodies[1].messages.some((m: any) => m.role === 'tool')).toBe(true);
    expect(s.db.prepare("SELECT web_search, web_searches FROM usage_events WHERE purpose = 'reply'").get()).toEqual({ web_search: 1, web_searches: 1 });
  });

  it('searches the message first for a model without tools', async () => {
    const s = await setup();
    s.fake.reply({ text: ['Cats purr.'] });
    const events = await readEvents(await send(s, { modelId: s.ids.gemma, webSearch: true }));
    const msg = events.find((e) => e.event === 'done')!.data.message;
    expect(s.search.requests.at(0)!.query.q).toBe('Tell me about cats');
    const body = chatBodies(s.fake).find((b) => b.model === 'gemma3:1b')!;
    expect(body).not.toHaveProperty('tools');
    expect(JSON.stringify(body.messages)).toContain('<search_results query=\\"Tell me about cats\\">');
    expect(msg.sources).toHaveLength(3);
    expect(msg.webSearches).toBe(1);
  });

  it('searches for both slots of a comparison', async () => {
    const s = await setup();
    s.fake.reply({ toolCalls: [{ name: 'web_search', arguments: { query: 'cats' } }] }, { model: 'qwen3:1.7b' });
    s.fake.reply({ text: ['Answer'] }, { model: 'qwen3:1.7b' });
    s.fake.reply({ text: ['Gemma answer'] }, { model: 'gemma3:1b' });
    const events = await readEvents(await send(s, { modelIds: [s.ids.qwen, s.ids.gemma], webSearch: true }));
    const done = events.filter((e) => e.event === 'slot-done');
    expect(done).toHaveLength(2);
    const byModel = (id: string) => done.find((e) => e.data.message.modelId === id)!.data.message;
    expect(byModel(s.ids.qwen).webSearches).toBe(1);
    expect(byModel(s.ids.qwen).sources.length).toBeGreaterThan(0);
    expect(byModel(s.ids.gemma).sources.length).toBeGreaterThan(0);
    expect(byModel(s.ids.gemma).webSearches).toBe(1);
  });

  it('ends the reply with the error when the search before it fails, and logs it as an error', async () => {
    const s = await setup();
    const port = new URL(s.search.url).port;
    await s.search.close();
    const events = await readEvents(await send(s, { modelId: s.ids.gemma, webSearch: true }));
    const err = events.find((e) => e.event === 'error')!;
    expect(err.data.error ?? err.data.message).toBe(`Web search failed: Can't reach SearXNG at 127.0.0.1:${port}. Is it running?`);
    expect(JSON.stringify(events)).not.toMatch(/fetch failed|ECONNREFUSED/);
    expect(chatBodies(s.fake).filter((b) => b.model === 'gemma3:1b')).toHaveLength(0);
    expect(s.db.prepare("SELECT status FROM usage_events WHERE purpose = 'reply'").get()).toEqual({ status: 'error' });
  });

  it('regenerates without searching once the service is turned off', async () => {
    const s = await setup();
    s.fake.reply({ toolCalls: [{ name: 'web_search', arguments: { query: 'cats' } }] });
    s.fake.reply({ text: ['First'] });
    const sent = await readEvents(await send(s, { modelId: s.ids.qwen, webSearch: true }));
    const userId = sent.find((e) => e.event === 'start')!.data.userMessageId;
    setSetting(s.db, 'web_search_service', 'none');
    s.fake.requests.length = 0;
    const regen = await readEvents(await s.call('POST', `/api/chats/${s.chatId}/regenerate`, { parentId: userId, modelId: s.ids.qwen }));
    expect(regen.some((e) => e.event === 'error')).toBe(false);
    const msg = regen.find((e) => e.event === 'done')!.data.message;
    expect(msg.sources).toEqual([]);
    expect(s.search.requests).toHaveLength(1); // only the first send searched
    for (const b of chatBodies(s.fake)) expect(b).not.toHaveProperty('tools');
  });

  it('replies normally when search is asked for but no service is set up', async () => {
    const s = await setup({ service: null });
    s.fake.reply({ text: ['Plain'] });
    const events = await readEvents(await send(s, { modelId: s.ids.qwen, webSearch: true }));
    expect(events.some((e) => e.event === 'error')).toBe(false);
    expect(events.find((e) => e.event === 'done')!.data.message.content).toBe('Plain');
    expect(chatBodies(s.fake)[0]).not.toHaveProperty('tools');
    expect(s.search.requests).toHaveLength(0);
  });

  it('leaves OpenRouter models on OpenRouter search', async () => {
    const seen: any[] = [];
    const s = await setup({
      openrouter: { streamChat: async function* (o: any) { seen.push(o); yield { type: 'delta' as const, text: 'ok' }; } },
    });
    for (const [id, supportsTools, mode] of [['openai/gpt-4o', true, 'tool'], ['x/plain', false, 'plugin']] as const) {
      addModel(s.db, withCatalogDefaults({ id, name: id, contextLength: 8000, supportsTools }));
      const chat = ((await (await s.call('POST', '/api/chats')).json()) as ChatSummary).id;
      await readEvents(await send(s, { modelId: id, webSearch: true }, chat));
      expect(seen.at(-1).webSearch).toBe(mode);
      expect(seen.at(-1).tools).toBeUndefined();
    }
    expect(s.search.requests).toHaveLength(0);
  });
});
