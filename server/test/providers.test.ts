import { afterEach, describe, expect, it, vi } from 'vitest';
import { startFakeLocalServer, type FakeServer } from '../../test/fakeLocalServer';
import { makeApp, readEvents } from './appHelpers';
import { addServer, updateServer } from '../src/localServers';
import { addModel } from '../src/library';
import { chatProvider } from '../src/providers';
import { maybeGenerateTitle } from '../src/title';
import { insertMessage } from '../src/messages';
import { setSetting } from '../src/settings';
import { localModelId } from '../../shared/localModels';
import { withCatalogDefaults, type ChatSummary, type DiscussionDetail } from '../../shared/types';

let fake: FakeServer | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const MODELS = [
  { name: 'qwen3:1.7b', tools: true, thinking: true, contextLength: 40960 },
  { name: 'gemma3:1b', contextLength: 32768 },
];

/** An app with no OpenRouter key and an Ollama fake whose two models are in My models. */
async function setup(openrouter: Parameters<typeof makeApp>[0] = {}, env: Parameters<typeof makeApp>[1] = {}) {
  fake = await startFakeLocalServer({ flavor: 'ollama', models: MODELS });
  const app = makeApp(openrouter, env);
  const server = addServer(app.db, { type: 'ollama', name: 'Ollama', baseUrl: fake.url, auto: false });
  const ids = { qwen: localModelId(server.id, 'qwen3:1.7b'), gemma: localModelId(server.id, 'gemma3:1b') };
  addModel(app.db, withCatalogDefaults({ id: ids.qwen, name: 'qwen3:1.7b', contextLength: 40960, supportsReasoning: true, supportsTools: true }));
  addModel(app.db, withCatalogDefaults({ id: ids.gemma, name: 'gemma3:1b', contextLength: 32768 }));
  const chatId = ((await (await app.call('POST', '/api/chats')).json()) as ChatSummary).id;
  return { ...app, server, ids, chatId, fake: fake! };
}
const chatBodies = (f: FakeServer) => f.requests.filter((r) => r.path === '/api/chat').map((r) => r.body);
const send = (s: Awaited<ReturnType<typeof setup>>, body: object, chatId = s.chatId) => s.call('POST', `/api/chats/${chatId}/messages`, { content: 'Hi', ...body });

describe('local model routing', () => {
  it('sends to a local model with no OpenRouter key, saves it free, and titles the chat', async () => {
    const s = await setup();
    s.fake.reply({ text: ['Hello ', 'there'] });
    s.fake.reply({ text: ['Local chat'] });
    const events = await readEvents(await send(s, { modelId: s.ids.gemma }));
    expect(events.map((e) => e.event)).toEqual(['start', 'delta', 'delta', 'done', 'title']);
    const msg = events.find((e) => e.event === 'done')!.data.message;
    expect(msg.content).toBe('Hello there');
    expect(msg.cost).toBe(0);
    expect(events.find((e) => e.event === 'title')!.data.title).toBe('Local chat');
    const first = chatBodies(s.fake)[0];
    expect(first.model).toBe('gemma3:1b');
    expect(first.options.num_ctx).toBe(16384);
  });

  it('compares two local models', async () => {
    const s = await setup();
    const events = await readEvents(await send(s, { modelIds: [s.ids.gemma, s.ids.qwen] }));
    expect(events.filter((e) => e.event === 'slot-done')).toHaveLength(2);
    expect(events.filter((e) => e.event === 'slot-error')).toHaveLength(0);
  });

  it('never counts a local reply as web-searched, even for a web-searched message', async () => {
    const s = await setup();
    const sent = await readEvents(await send(s, { modelId: s.ids.gemma, webSearch: true }));
    expect(sent.find((e) => e.event === 'done')!.data.message.webSearch).toBe(false);
    const userId = sent.find((e) => e.event === 'start')!.data.userMessageId;
    const regen = await readEvents(await s.call('POST', `/api/chats/${s.chatId}/regenerate`, { parentId: userId, modelId: s.ids.qwen }));
    expect(regen.find((e) => e.event === 'done')!.data.message.webSearch).toBe(false);
    const bodies = chatBodies(s.fake);
    for (const b of bodies) {
      expect(b).not.toHaveProperty('tools');
      expect(JSON.stringify(b)).not.toMatch(/search/i);
    }
    expect(s.db.prepare('SELECT COUNT(*) AS n FROM usage_events WHERE web_search = 1').get()).toEqual({ n: 0 });
  });

  it('refuses a PDF for a local model instead of dropping it silently', async () => {
    const s = await setup();
    const pdf = (await (await s.upload('%PDF-1.4\n', 'report.pdf')).json()) as { id: string };
    const res = await send(s, { modelId: s.ids.gemma, attachmentIds: [pdf.id] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe("gemma3:1b can't read PDFs yet. Use an OpenRouter model for PDFs.");
    expect(chatBodies(s.fake)).toHaveLength(0);
  });

  it('does not label a local reasoning reply with an effort', async () => {
    const s = await setup();
    const events = await readEvents(await send(s, { modelId: s.ids.qwen, effort: 'high' }));
    expect(events.find((e) => e.event === 'done')!.data.message.effort).toBeNull();
  });

  it('regenerates and edits with a local model', async () => {
    const s = await setup();
    const sent = await readEvents(await send(s, { modelId: s.ids.gemma }));
    const userId = sent.find((e) => e.event === 'start')!.data.userMessageId;
    const regen = await readEvents(await s.call('POST', `/api/chats/${s.chatId}/regenerate`, { parentId: userId, modelId: s.ids.qwen }));
    expect(regen.map((e) => e.event)).toContain('done');
    const edit = await readEvents(await s.call('POST', `/api/chats/${s.chatId}/edit`, { messageId: userId, content: 'Hello', modelId: s.ids.gemma }));
    expect(edit.map((e) => e.event)).toContain('done');
  });

  it('refuses an OpenRouter model without a key while a local one still works', async () => {
    const s = await setup();
    addModel(s.db, withCatalogDefaults({ id: 'openai/gpt-4o', name: 'GPT-4o' }));
    const bad = await readEvents(await send(s, { modelId: 'openai/gpt-4o' }));
    expect(bad.find((e) => e.event === 'error')!.data.message).toBe('No OpenRouter API key set. Add one in Settings.');
    const chat2 = ((await (await s.call('POST', '/api/chats')).json()) as ChatSummary).id;
    const good = await readEvents(await send(s, { modelId: s.ids.gemma }, chat2));
    expect(good.map((e) => e.event)).toContain('done');
  });

  it('says so when the server is turned off', async () => {
    const s = await setup();
    updateServer(s.db, s.server.id, { enabled: false });
    const events = await readEvents(await send(s, { modelId: s.ids.gemma }));
    expect(events.find((e) => e.event === 'error')!.data.message).toBe('Ollama is turned off in Settings.');
  });

  it('says so when the server was removed', async () => {
    const s = await setup();
    s.db.prepare('UPDATE local_servers SET removed_at = 1 WHERE id = ?').run(s.server.id);
    expect(() => chatProvider(s.deps, s.ids.gemma)).toThrow('The server for this model was removed.');
  });

  it('reports an unreachable server without raw fetch errors', async () => {
    const s = await setup();
    await s.fake.close();
    const events = await readEvents(await send(s, { modelId: s.ids.gemma }));
    const message = events.find((e) => e.event === 'error')!.data.message as string;
    expect(message).toMatch(/Can.t reach/);
    expect(message).not.toMatch(/fetch failed/);
  });

  it('runs a discussion turn and summary between local models', async () => {
    const s = await setup();
    const created = (await (await s.call('POST', '/api/discussions', {
      topic: 'Eggs',
      turnLimit: 4,
      participants: [
        { name: 'A', modelId: s.ids.gemma, instructions: 'Argue yes.', isModerator: false },
        { name: 'B', modelId: s.ids.qwen, instructions: 'Argue no.', isModerator: false },
      ],
    })).json()) as DiscussionDetail;
    const id = created.chat.id;
    const turn = await readEvents(await s.call('POST', `/api/discussions/${id}/turn`));
    expect(turn.map((e) => e.event)).toContain('done');
    const res = await s.call('POST', `/api/discussions/${id}/summary`, { modelId: s.ids.gemma });
    expect(res.status).toBe(200);
  });

  it('passes thinking: false to a thinking model', async () => {
    const s = await setup();
    await readEvents(await send(s, { modelId: s.ids.qwen, thinking: false }));
    expect(chatBodies(s.fake)[0].think).toBe(false);
  });

  it('leaves think unset for a model without reasoning, and rejects a bad value', async () => {
    const s = await setup();
    await readEvents(await send(s, { modelId: s.ids.gemma, thinking: false }));
    expect(chatBodies(s.fake)[0]).not.toHaveProperty('think');
    const bad = await send(s, { modelId: s.ids.gemma, thinking: 'no' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('thinking must be true or false.');
  });

  it('turns thinking off for helper calls to a thinking model', async () => {
    const s = await setup();
    const p = chatProvider(s.deps, s.ids.qwen);
    await p.complete({ model: s.ids.qwen, messages: [{ role: 'user', content: 'x' }], maxTokens: 50 });
    const body = chatBodies(s.fake)[0];
    expect(body.think).toBe(false);
    expect(body.model).toBe('qwen3:1.7b');
    expect(body.stream).toBe(false);
  });
});

describe('titling local chats', () => {
  async function titleFor(pick: (ids: { gemma: string; qwen: string }) => string[]) {
    const complete = vi.fn(async () => 'Remote title');
    const s = await setup({ complete }, { OPENROUTER_API_KEY: 'sk-or-test-1234567890' });
    addModel(s.db, withCatalogDefaults({ id: 'openai/gpt-4o', name: 'GPT-4o' }));
    setSetting(s.db, 'title_model_id', 'openai/gpt-4o');
    s.fake.reply({ text: ['Local title'] });
    const modelIds = pick(s.ids);
    let parent: string | null = null;
    for (const modelId of modelIds) {
      const user = insertMessage(s.db, { chatId: s.chatId, parentId: parent, role: 'user', content: 'Hi' });
      parent = insertMessage(s.db, { chatId: s.chatId, parentId: user.id, role: 'assistant', content: 'Hello', modelId }).id;
    }
    s.db.prepare('UPDATE chats SET active_leaf_id = ? WHERE id = ?').run(parent, s.chatId);
    const title = await maybeGenerateTitle(s.deps, s.chatId, modelIds[0]);
    return { s, complete, title };
  }

  it('titles a local-only chat with its own model, never OpenRouter', async () => {
    const { s, complete, title } = await titleFor((ids) => [ids.gemma, ids.qwen]);
    expect(title).toBe('Local title');
    expect(complete).not.toHaveBeenCalled();
    expect(chatBodies(s.fake)).toHaveLength(1);
  });

  it('uses the chosen title model when any reply came from OpenRouter', async () => {
    const { complete, title } = await titleFor((ids) => [ids.gemma, 'openai/gpt-4o']);
    expect(title).toBe('Remote title');
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
