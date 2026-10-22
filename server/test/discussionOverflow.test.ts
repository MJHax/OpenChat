import { afterEach, describe, expect, it } from 'vitest';
import { startFakeLocalServer, type FakeServer } from '../../test/fakeLocalServer';
import { makeApp, readEvents } from './appHelpers';
import { addServer } from '../src/localServers';
import { addModel } from '../src/library';
import { insertMessage, getChatMessages } from '../src/messages';
import { setActiveLeaf, getChatRow } from '../src/chats';
import { saveLimits } from '../src/limits';
import { logReply } from './usageHelpers';
import { localModelId } from '../../shared/localModels';
import { withCatalogDefaults, type DiscussionDetail } from '../../shared/types';

let fake: FakeServer | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const USAGE = { promptTokens: 1, completionTokens: 2, cost: 0.002, webSearches: null, cachedTokens: null, cacheWriteTokens: null, reasoningTokens: null, loadMs: null, generationMs: null };

async function setup(o: { cloudSpeaker?: boolean } = {}) {
  fake = await startFakeLocalServer({ flavor: 'ollama', models: [{ name: 'qwen3:1.7b', contextLength: 8192 }] });
  const app = makeApp({
    streamChat: async function* () {
      yield { type: 'delta' as const, text: 'cloud reply' };
      yield { type: 'usage' as const, usage: USAGE };
    },
  });
  const server = addServer(app.db, { type: 'ollama', name: 'Ollama', baseUrl: fake.url, auto: false });
  const local = localModelId(server.id, 'qwen3:1.7b');
  addModel(app.db, withCatalogDefaults({ id: local, name: 'qwen3:1.7b', contextLength: 2048 }));
  addModel(app.db, withCatalogDefaults({ id: 'openai/gpt-4o', name: 'GPT-4o', contextLength: 128000 }));
  const model = o.cloudSpeaker ? 'openai/gpt-4o' : local;
  const d = (await (await app.call('POST', '/api/discussions', {
    topic: 'Which came first?', turnLimit: 10,
    participants: [
      { name: 'Egg', modelId: model, instructions: 'Argue the egg.', isModerator: false },
      { name: 'Chicken', modelId: model, instructions: 'Argue the chicken.', isModerator: false },
    ],
  })).json()) as DiscussionDetail;
  const id = d.chat.id;
  /** Fills the transcript with `chars` characters, as Chicken's lines so Egg speaks next. */
  const fill = (chars: number) => {
    const m = insertMessage(app.db, { chatId: id, parentId: getChatRow(app.db, id)?.active_leaf_id ?? null, role: 'assistant', content: 'x'.repeat(chars), participantId: d.participants[1].id });
    setActiveLeaf(app.db, id, m.id);
  };
  const turn = (body?: unknown) => app.call('POST', `/api/discussions/${id}/turn`, body);
  const chatRequests = () => fake!.requests.filter((r) => r.path === '/api/chat');
  const saved = () => getChatMessages(app.db, id);
  return { ...app, d, id, fill, turn, chatRequests, saved, fake: fake! };
}

describe('the check before a Discussion turn', () => {
  it('refuses a turn that does not fit, saving nothing and sending nothing', async () => {
    const s = await setup();
    s.fill(6_000);
    const res = await s.turn();
    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body.error).toBe('This discussion is longer than qwen3:1.7b can remember.');
    expect(body.overflow).toHaveLength(1);
    expect(body.overflow[0].modelId).toBe(s.d.participants[0].modelId);
    expect(body.speaker).toBe('Egg');
    expect(s.chatRequests()).toHaveLength(0);
    expect(s.saved()).toHaveLength(1);
    expect(s.db.prepare('SELECT status FROM discussions WHERE chat_id = ?').get(s.id)).toEqual({ status: 'active' });
  });

  it('releases the turn after a refusal, so allowing it afterwards works', async () => {
    const s = await setup();
    s.fill(6_000);
    expect((await s.turn()).status).toBe(409);
    const res = await s.turn({ allowOverflow: true });
    expect(res.status).toBe(200);
    const events = await readEvents(res);
    expect(events.find((e) => e.event === 'done')!.data.message.contextDropped).toBe(true);
    expect(s.chatRequests()).toHaveLength(1);
  });

  it('marks nothing on a turn that fits', async () => {
    const s = await setup();
    s.fill(400);
    const events = await readEvents(await s.turn({ allowOverflow: false }));
    expect(events.find((e) => e.event === 'done')!.data.message.contextDropped).toBe(false);
  });

  it('still works with no body at all', async () => {
    const s = await setup();
    const res = await s.turn();
    expect(res.status).toBe(200);
    await readEvents(res);
  });

  it('rejects a flag that is not true or false', async () => {
    const s = await setup();
    const res = await s.turn({ allowOverflow: 'yes' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe('allowOverflow must be true or false.');
    expect(s.chatRequests()).toHaveLength(0);
  });

  it('answers an ended discussion with the ended copy, not an overflow', async () => {
    const s = await setup();
    s.fill(6_000);
    expect((await s.call('POST', `/api/discussions/${s.id}/stop`)).status).toBe(200);
    const res = await s.turn();
    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body.error).toBe('This discussion has ended. Add turns to continue.');
    expect(body.overflow).toBeUndefined();
  });

  it('never checks an OpenRouter speaker, and its spending limit still answers 402', async () => {
    const s = await setup({ cloudSpeaker: true });
    s.fill(40_000);
    saveLimits(s.db, { daily: { enabled: true, amount: 1 }, weekly: { enabled: false, amount: null }, monthly: { enabled: false, amount: null }, timeZone: 'UTC' });
    logReply(s.db, { chatId: 'elsewhere', messageId: 'x', cost: 5 });
    expect((await s.turn()).status).toBe(402);
  });

  it('lets an OpenRouter speaker through however long the transcript', async () => {
    const s = await setup({ cloudSpeaker: true });
    s.fill(40_000);
    const res = await s.turn();
    expect(res.status).toBe(200);
    expect((await readEvents(res)).find((e) => e.event === 'done')!.data.message.contextDropped).toBe(false);
  });
});
