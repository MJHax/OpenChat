import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db';
import { createChat } from '../src/chats';
import { insertMessage } from '../src/messages';
import { createDiscussion, getDiscussionDetail } from '../src/discussion/store';
import { makeApp } from './appHelpers';
import { startFakeLocalServer, type FakeServer } from "../../test/fakeLocalServer";
import { addServer } from "../src/localServers";
import { addModel } from "../src/library";
import { localModelId } from "../../shared/localModels";
import { withCatalogDefaults } from "../../shared/types";
import { logReply } from './usageHelpers';
import { newDiscussion, seedModel, withModerator } from './discussionHelpers';

describe('discussion messages', () => {
  it('insertMessage round-trips participantId and handoffTo', () => {
    const db = openDb(':memory:');
    const chat = createChat(db, 'discussion');
    const plain = insertMessage(db, { chatId: chat.id, parentId: null, role: 'user', content: 'hi' });
    expect(plain).toMatchObject({ participantId: null, handoffTo: null });
    const turn = insertMessage(db, {
      chatId: chat.id, parentId: plain.id, role: 'assistant', content: '', participantId: 'p-mod', handoffTo: 'p-egg',
    });
    expect(turn).toMatchObject({ participantId: 'p-mod', handoffTo: 'p-egg' });
  });
});

describe('discussion store', () => {
  it('creates a discussion with trimmed participants in order', () => {
    const db = openDb(':memory:');
    seedModel(db, 'test/tools', true);
    const d = createDiscussion(db, newDiscussion());
    expect(d.chat.title).toBe('Which came first, the chicken or the egg?');
    expect(d.topic).toBe('Which came first, the chicken or the egg?');
    expect(db.prepare('SELECT kind FROM chats WHERE id = ?').get(d.chat.id)).toEqual({ kind: 'discussion' });
    expect(d.state).toEqual({ status: 'active', endReason: null, endNote: null, turnLimit: 10, turnsTaken: 0, moderatorDecides: false, moderatorNoteAfter: null });
    expect(d.participants.map((p) => [p.position, p.name, p.instructions, p.isModerator, p.turns, p.cost])).toEqual([
      [0, 'Egg-Defender', 'Argue the egg.', false, 0, 0],
      [1, 'Chicken-Defender', 'Argue the chicken.', false, 0, 0],
    ]);
    expect(d.messages).toEqual([]);
    expect(d.summary).toBeNull();
  });

  it('stores a moderator-decides discussion with the 100-turn cap', () => {
    const db = openDb(':memory:');
    seedModel(db, 'test/tools', true);
    const d = createDiscussion(db, withModerator({ moderatorDecides: true, turnLimit: 5 }));
    expect(d.state).toMatchObject({ turnLimit: 100, moderatorDecides: true });
    expect(createDiscussion(db, newDiscussion()).state.moderatorDecides).toBe(false);
  });

  it('reports turns and cost per participant', () => {
    const db = openDb(':memory:');
    seedModel(db, 'test/tools', true);
    const d = createDiscussion(db, withModerator());
    const [egg, , mod] = d.participants;
    const add = (participantId: string, content: string, cost: number) => {
      const m = insertMessage(db, { chatId: d.chat.id, parentId: null, role: 'assistant', content, cost, participantId });
      logReply(db, { chatId: d.chat.id, messageId: m.id, cost });
    };
    add(egg.id, 'one', 0.01);
    add(egg.id, 'two', 0.02);
    add(mod.id, '', 0.001);
    const detail = getDiscussionDetail(db, d.chat.id);
    const byName = Object.fromEntries(detail.participants.map((p) => [p.name, { turns: p.turns, cost: p.cost }]));
    expect(byName['Egg-Defender']).toEqual({ turns: 2, cost: expect.closeTo(0.03, 10) });
    expect(byName.Moderator).toEqual({ turns: 0, cost: expect.closeTo(0.001, 10) });
    expect(detail.state.turnsTaken).toBe(2);
    expect(detail.chat.totalCost).toBeCloseTo(0.031, 10);
  });
});

describe('discussion routes', () => {
  it('creates and reads a discussion', async () => {
    const { db, call } = makeApp();
    seedModel(db, 'test/tools', true);
    const res = await call('POST', '/api/discussions', newDiscussion());
    expect(res.status).toBe(201);
    const created = await res.json();
    const read = await (await call('GET', `/api/discussions/${created.chat.id}`)).json();
    expect(read).toEqual(created);
  });

  it('rejects an invalid discussion with the validation message', async () => {
    const { call } = makeApp();
    const res = await call('POST', '/api/discussions', newDiscussion({ participants: newDiscussion().participants.slice(0, 1) }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'A discussion needs 2 to 6 participants.' });
  });

  it('rejects a moderator whose model cannot use tools', async () => {
    const { db, call } = makeApp();
    seedModel(db, 'test/tools', true);
    seedModel(db, 'test/plain', false);
    const d = withModerator();
    d.participants[2].modelId = 'test/plain';
    const res = await call('POST', '/api/discussions', d);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'The moderator needs a model that can use tools. Pick another model for it.' });
  });

  it('returns 404 for a chat that is not a discussion', async () => {
    const { db, call } = makeApp();
    const chat = createChat(db);
    expect((await call('GET', `/api/discussions/${chat.id}`)).status).toBe(404);
  });

  it('lists discussions under kind=discussion and not under chats', async () => {
    const { db, call } = makeApp();
    seedModel(db, 'test/tools', true);
    const created = await (await call('POST', '/api/discussions', newDiscussion())).json();
    const discussions = await (await call('GET', '/api/chats?kind=discussion')).json();
    expect(discussions.map((c: { id: string }) => c.id)).toEqual([created.chat.id]);
    expect(await (await call('GET', '/api/chats')).json()).toEqual([]);
  });

  it('refuses to create a discussion through POST /api/chats', async () => {
    const { call } = makeApp();
    const res = await call('POST', '/api/chats', { kind: 'discussion' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Create discussions from the Discussion tab.' });
  });

});

describe("local moderators", () => {
  it("needs a local model that can use tools, but any local model can take part", async () => {
    const fake: FakeServer = await startFakeLocalServer({ flavor: "ollama", models: [{ name: "qwen3:1.7b", tools: true }, { name: "gemma3:1b" }] });
    try {
      const { db, call } = makeApp();
      const server = addServer(db, { type: "ollama", name: "Ollama", baseUrl: fake.url, auto: false });
      const qwen = localModelId(server.id, "qwen3:1.7b");
      const gemma = localModelId(server.id, "gemma3:1b");
      addModel(db, withCatalogDefaults({ id: qwen, name: "qwen3:1.7b", contextLength: 40960, supportsTools: true }));
      addModel(db, withCatalogDefaults({ id: gemma, name: "gemma3:1b", contextLength: 32768 }));
      const make = (moderator: string, other: string) => call("POST", "/api/discussions", newDiscussion({
        participants: [
          ...newDiscussion().participants.map((p) => ({ ...p, modelId: other })),
          { name: "Moderator", modelId: moderator, instructions: "", isModerator: true },
        ],
      }));
      const bad = await make(gemma, qwen);
      expect(bad.status).toBe(400);
      expect(await bad.json()).toEqual({ error: "The moderator needs a model that can use tools. Pick another model for it." });
      expect((await make(qwen, qwen)).status).toBe(201);
      expect((await make(qwen, gemma)).status).toBe(201);
    } finally {
      await fake.close();
    }
  });
});
