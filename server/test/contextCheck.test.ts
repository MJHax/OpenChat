import { afterEach, describe, expect, it } from 'vitest';
import { startFakeLocalServer, type FakeServer } from '../../test/fakeLocalServer';
import { makeApp, readEvents } from './appHelpers';
import { addServer } from '../src/localServers';
import { addLocalModel, addModel, setContextWindow } from '../src/library';
import { insertMessage } from '../src/messages';
import { setActiveLeaf } from '../src/chats';
import { localModelId } from '../../shared/localModels';
import { withCatalogDefaults, type ChatDetail, type ChatSummary, type Message } from '../../shared/types';

let fake: FakeServer | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const LONG = 'x'.repeat(12_000); // ~3,000 estimated tokens

async function setup() {
  fake = await startFakeLocalServer({ flavor: 'ollama', models: [{ name: 'small', contextLength: 8192 }, { name: 'other', contextLength: 8192 }] });
  const app = makeApp({
    streamChat: async function* () { yield { type: 'delta' as const, text: 'cloud reply' }; },
  });
  const server = addServer(app.db, { type: 'ollama', name: 'Ollama', baseUrl: fake.url, auto: false });
  const ids = { small: localModelId(server.id, 'small'), other: localModelId(server.id, 'other'), cloud: 'openai/gpt-4o' };
  const local = (id: string, name: string) =>
    addLocalModel(app.db, { id, serverId: server.id, sizeBytes: null, capsKnown: true, name, contextLength: 8192, inputModalities: ['text'], supportsTools: false, supportsReasoning: false });
  local(ids.small, 'small');
  local(ids.other, 'other');
  setContextWindow(app.db, ids.small, 2048);
  addModel(app.db, withCatalogDefaults({ id: ids.cloud, name: 'GPT-4o', contextLength: 128000 }));
  const chat = (await (await app.call('POST', '/api/chats')).json()) as ChatSummary;
  return { ...app, ids, chatId: chat.id };
}
type S = Awaited<ReturnType<typeof setup>>;

/** user(long) -> assistant, with the assistant as the active leaf. */
function longChat(s: S, length = LONG) {
  const u = insertMessage(s.db, { chatId: s.chatId, parentId: null, role: 'user', content: length });
  const a = insertMessage(s.db, { chatId: s.chatId, parentId: u.id, role: 'assistant', content: 'ok', modelId: s.ids.cloud });
  setActiveLeaf(s.db, s.chatId, a.id);
  return { u, a };
}
const detail = async (s: S) => (await (await s.call('GET', `/api/chats/${s.chatId}`)).json()) as ChatDetail;
const send = (s: S, body: object) => s.call('POST', `/api/chats/${s.chatId}/messages`, { content: 'More', ...body });

describe('the check before sending', () => {
  it('refuses a send that does not fit, saving nothing', async () => {
    const s = await setup();
    longChat(s);
    const before = (await detail(s)).messages.length;
    const res = await send(s, { modelId: s.ids.small });
    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body.error).toBe('This chat is longer than small can remember.');
    expect(body.overflow).toHaveLength(1);
    expect(body.overflow[0]).toMatchObject({ modelId: s.ids.small, displayName: 'small', window: 2048 });
    expect(body.overflow[0].estimate).toBeGreaterThan(2048);
    expect((await detail(s)).messages).toHaveLength(before);
    // the chat is released: a leaked lock would answer 409 "still being generated" here
    const again = await send(s, { modelId: s.ids.small, allowOverflow: true });
    expect(again.status).toBe(200);
    expect((await readEvents(again)).some((e) => e.event === 'done')).toBe(true);
  });

  it('sends anyway when allowed, marking the reply as having lost context', async () => {
    const s = await setup();
    longChat(s);
    const res = await send(s, { modelId: s.ids.small, allowOverflow: true });
    expect(res.status).toBe(200);
    const events = await readEvents(res);
    const done = events.find((e) => e.event === 'done')!.data.message as Message;
    expect(done.contextDropped).toBe(true);
    const saved = (await detail(s)).messages.find((m) => m.id === done.id)!;
    expect(saved.contextDropped).toBe(true);
  });

  it('does not object to a short chat or an unchecked OpenRouter model', async () => {
    const s = await setup();
    expect((await send(s, { modelId: s.ids.small })).status).toBe(200);
    const t = await setup();
    longChat(t);
    const res = await send(t, { modelId: t.ids.cloud });
    expect(res.status).toBe(200);
    const done = (await readEvents(res)).find((e) => e.event === 'done')!.data.message as Message;
    expect(done.contextDropped).toBe(false);
  });

  it('lists only the overflowing model in a comparison', async () => {
    const s = await setup();
    longChat(s);
    const res = await send(s, { modelIds: [s.ids.small, s.ids.other] });
    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body.overflow.map((o: any) => o.modelId)).toEqual([s.ids.small]);
    const ok = await send(s, { modelIds: [s.ids.small, s.ids.other], allowOverflow: true });
    expect(ok.status).toBe(200);
    const events = await readEvents(ok);
    const dropped = events.filter((e) => e.event === 'slot-done').map((e) => [e.data.message.modelId, e.data.message.contextDropped]);
    expect(Object.fromEntries(dropped)).toEqual({ [s.ids.small]: true, [s.ids.other]: false });
  });

  it('checks regenerate and edit', async () => {
    const s = await setup();
    const { u } = longChat(s);
    const regen = await s.call('POST', `/api/chats/${s.chatId}/regenerate`, { parentId: u.id, modelId: s.ids.small });
    expect(regen.status).toBe(409);
    const edit = await s.call('POST', `/api/chats/${s.chatId}/edit`, { messageId: u.id, content: LONG, modelId: s.ids.small });
    expect(edit.status).toBe(409);
    expect((await detail(s)).messages).toHaveLength(2);
    const ok = await s.call('POST', `/api/chats/${s.chatId}/regenerate`, { parentId: u.id, modelId: s.ids.small, allowOverflow: true });
    expect(ok.status).toBe(200);
  });

  it('checks continue', async () => {
    const s = await setup();
    longChat(s);
    const res = await s.call('POST', `/api/chats/${s.chatId}/continue`, { modelId: s.ids.small });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).overflow[0].modelId).toBe(s.ids.small);
    const ok = await s.call('POST', `/api/chats/${s.chatId}/continue`, { modelId: s.ids.small, allowOverflow: true });
    expect(ok.status).toBe(201);
  });

  it('checks an edit against the path before the edited message, not the old text', async () => {
    const s = await setup();
    const { u } = longChat(s); // the long part is the message being edited; its parent is null
    const short = await s.call('POST', `/api/chats/${s.chatId}/edit`, { messageId: u.id, content: 'Short now', modelId: s.ids.small });
    expect(short.status).toBe(200);
    await readEvents(short);
    const t = await setup();
    const { u: u2 } = longChat(t);
    const long = await t.call('POST', `/api/chats/${t.chatId}/edit`, { messageId: u2.id, content: LONG, modelId: t.ids.small, allowOverflow: true });
    expect(long.status).toBe(200);
    const done = (await readEvents(long)).find((e) => e.event === 'done')!.data.message as Message;
    expect(done.contextDropped).toBe(true);
  });

  it('rejects a non-boolean allowOverflow', async () => {
    const s = await setup();
    const res = await send(s, { modelId: s.ids.small, allowOverflow: 'yes' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe('allowOverflow must be true or false.');
  });
});
