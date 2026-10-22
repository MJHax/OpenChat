import { afterEach, describe, expect, it } from 'vitest';
import { startFakeLocalServer, type FakeServer } from '../../test/fakeLocalServer';
import { makeApp, readEvents } from './appHelpers';
import { addServer } from '../src/localServers';
import { addModel } from '../src/library';
import { getChatMessages } from '../src/messages';
import { localModelId } from '../../shared/localModels';
import { withCatalogDefaults, type ChatSummary } from '../../shared/types';

const fakes: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((f) => f.close()));
});

const MODELS = [{ name: 'qwen3:1.7b', contextLength: 40960 }, { name: 'gemma3:1b', contextLength: 32768 }];

async function startFake(models = MODELS) {
  const f = await startFakeLocalServer({ flavor: 'ollama', models });
  fakes.push(f);
  return f;
}

function register(app: ReturnType<typeof makeApp>, fake: FakeServer, name: string, models: string[]) {
  const server = addServer(app.db, { type: 'ollama', name, baseUrl: fake.url, auto: false });
  return models.map((m) => {
    const id = localModelId(server.id, m);
    addModel(app.db, withCatalogDefaults({ id, name: m, contextLength: 32768 }));
    return id;
  });
}

async function newChat(app: ReturnType<typeof makeApp>) {
  return ((await (await app.call('POST', '/api/chats')).json()) as ChatSummary).id;
}

const chatPosts = (f: FakeServer) => f.requests.filter((r) => r.path === '/api/chat');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Compare with local models', () => {
  it('replies one at a time when the models share a server', async () => {
    const fake = await startFake();
    const app = makeApp();
    const [qwen, gemma] = register(app, fake, 'Ollama', ['qwen3:1.7b', 'gemma3:1b']);
    fake.reply({ text: ['A', 'B', 'C'], delayMs: 30 }, { model: 'qwen3:1.7b' });
    fake.reply({ text: ['X', 'Y'], delayMs: 30 }, { model: 'gemma3:1b' });
    const chatId = await newChat(app);
    const events = await readEvents(await app.call('POST', `/api/chats/${chatId}/messages`, { content: 'Hi', modelIds: [qwen, gemma] }));

    const slot0Done = events.findIndex((e) => e.event === 'slot-done' && e.data.slot === 0);
    const slot1Deltas = events.flatMap((e, i) => (e.event === 'delta' && e.data.slot === 1 ? [i] : []));
    expect(slot0Done).toBeGreaterThan(-1);
    expect(slot1Deltas.length).toBeGreaterThan(0);
    expect(slot1Deltas.every((i) => i > slot0Done)).toBe(true);
    const waiting = events.findIndex((e) => e.event === 'status' && e.data.slot === 1 && e.data.message === 'Waiting for qwen3:1.7b to finish…');
    expect(waiting).toBeGreaterThan(-1);
    expect(waiting).toBeLessThan(slot0Done);
    expect(events.filter((e) => e.event === 'slot-done')).toHaveLength(2);
    expect(getChatMessages(app.db, chatId).filter((m) => m.role === 'assistant').map((m) => m.content).sort()).toEqual(['ABC', 'XY']);
  });

  it('keeps models on different servers concurrent', async () => {
    const [f1, f2] = [await startFake([MODELS[0]]), await startFake([MODELS[1]])];
    const app = makeApp();
    const [qwen] = register(app, f1, 'One', ['qwen3:1.7b']);
    const [gemma] = register(app, f2, 'Two', ['gemma3:1b']);
    f1.reply({ text: ['A', 'B', 'C'], delayMs: 80 });
    f2.reply({ text: ['X', 'Y', 'Z'], delayMs: 80 });
    const chatId = await newChat(app);
    const events = await readEvents(await app.call('POST', `/api/chats/${chatId}/messages`, { content: 'Hi', modelIds: [qwen, gemma] }));
    const firstDone = events.findIndex((e) => e.event === 'slot-done');
    const early = events.slice(0, firstDone).filter((e) => e.event === 'delta');
    expect(new Set(early.map((e) => e.data.slot))).toEqual(new Set([0, 1]));
    expect(events.some((e) => e.event === 'status' && /^Waiting for/.test(e.data.message))).toBe(false);
    expect(chatPosts(f1).length).toBeGreaterThan(0);
    expect(chatPosts(f2).length).toBeGreaterThan(0);
  });

  it('still runs the next model after the first one fails', async () => {
    const fake = await startFake();
    const app = makeApp();
    const [qwen, gemma] = register(app, fake, 'Ollama', ['qwen3:1.7b', 'gemma3:1b']);
    fake.failNext(500, 'boom');
    fake.reply({ text: ['Gemma here'] }, { model: 'gemma3:1b' });
    const chatId = await newChat(app);
    const events = await readEvents(await app.call('POST', `/api/chats/${chatId}/messages`, { content: 'Hi', modelIds: [qwen, gemma] }));
    expect(events.find((e) => e.event === 'slot-error')!.data.slot).toBe(0);
    expect(events.find((e) => e.event === 'slot-done')!.data.message.content).toBe('Gemma here');
  });

  it('skips queued models once the request is aborted', async () => {
    const fake = await startFake();
    const app = makeApp();
    const [qwen, gemma] = register(app, fake, 'Ollama', ['qwen3:1.7b', 'gemma3:1b']);
    fake.reply({ text: ['Part', 'ial', ' more', ' text'], delayMs: 200 }, { model: 'qwen3:1.7b' });
    fake.reply({ text: ['Never'] }, { model: 'gemma3:1b' });
    const chatId = await newChat(app);
    const controller = new AbortController();
    const res = await app.app.request(new Request(`http://localhost/api/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Hi', modelIds: [qwen, gemma] }),
      signal: controller.signal,
    }));
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let seen = '';
    while (!seen.includes('event: delta')) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`stream ended before any delta: ${seen}`);
      seen += dec.decode(value);
    }
    controller.abort();
    await reader.cancel().catch(() => {});
    await sleep(600);

    expect(chatPosts(fake)).toHaveLength(1);
    const usage = app.db.prepare("SELECT model_id, status FROM usage_events WHERE purpose = 'reply'").all();
    expect(usage).toEqual([{ model_id: qwen, status: 'stopped' }]);
    const replies = getChatMessages(app.db, chatId).filter((m) => m.role === 'assistant');
    expect(replies).toEqual([expect.objectContaining({ modelId: qwen, status: 'stopped', content: expect.stringContaining('Part') })]);
  });

  it('streams an OpenRouter slot while same-server local models take turns', async () => {
    const fake = await startFake();
    const app = makeApp({
      streamChat: async function* () {
        yield { type: 'delta' as const, text: 'hello' };
      },
    });
    const [qwen, gemma] = register(app, fake, 'Ollama', ['qwen3:1.7b', 'gemma3:1b']);
    addModel(app.db, withCatalogDefaults({ id: 'or/m', name: 'or/m', contextLength: 8000 }));
    fake.reply({ text: ['A', 'B'], delayMs: 100 }, { model: 'qwen3:1.7b' });
    fake.reply({ text: ['X'] }, { model: 'gemma3:1b' });
    const chatId = await newChat(app);
    const events = await readEvents(await app.call('POST', `/api/chats/${chatId}/messages`, { content: 'Hi', modelIds: [qwen, gemma, 'or/m'] }));
    const slot0Done = events.findIndex((e) => e.event === 'slot-done' && e.data.slot === 0);
    const orDelta = events.findIndex((e) => e.event === 'delta' && e.data.slot === 2);
    expect(orDelta).toBeGreaterThan(-1);
    expect(orDelta).toBeLessThan(slot0Done);
    expect(events.filter((e) => e.event === 'slot-done')).toHaveLength(3);
    expect(events.some((e) => e.event === 'status' && e.data.slot === 2)).toBe(false);
  });
  it('titles a mixed Compare with slot 0 even when a local slot finishes first', async () => {
    const fake = await startFake();
    const app = makeApp({
      streamChat: async function* () {
        yield { type: 'delta' as const, text: 'hello' };
      },
    });
    const [qwen, gemma] = register(app, fake, 'Ollama', ['qwen3:1.7b', 'gemma3:1b']);
    addModel(app.db, withCatalogDefaults({ id: 'or/m', name: 'or/m', contextLength: 8000 }));
    fake.reply({ text: ['A'] }, { model: 'qwen3:1.7b' });
    fake.reply({ text: ['X'] }, { model: 'gemma3:1b' });
    const chatId = await newChat(app);
    const events = await readEvents(await app.call('POST', `/api/chats/${chatId}/messages`, { content: 'Hi', modelIds: ['or/m', qwen, gemma] }));
    expect(events.some((e) => e.event === 'title')).toBe(true);
    expect(app.db.prepare("SELECT model_id FROM usage_events WHERE purpose = 'title'").all()).toEqual([{ model_id: 'or/m' }]);
  });
});
