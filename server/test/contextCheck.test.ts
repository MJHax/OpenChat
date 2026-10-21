import { afterEach, describe, expect, it } from 'vitest';
import { startFakeLocalServer, type FakeServer } from '../../test/fakeLocalServer';
import { makeApp, readEvents } from './appHelpers';
import { addServer } from '../src/localServers';
import { addLocalModel, addModel, setContextWindow } from '../src/library';
import { insertMessage } from '../src/messages';
import { setActiveLeaf } from '../src/chats';
import { pdfWithPages } from '../../test/helpers';
import { startFakeSearchServer, type FakeSearch } from '../../test/fakeSearchServer';
import { setSetting } from '../src/settings';
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
  it('counts a PDF at its extracted text for a local model, not its page estimate', async () => {
    const s = await setup();
    setContextWindow(s.db, s.ids.small, 4096);
    const line = 'word '.repeat(80); // 400 characters
    const pages = [0, 1].map(() => Array.from({ length: 30 }, () => line)); // ~6,000 tokens over 2 pages
    const pdf = (await (await s.upload(pdfWithPages(pages, 2), 'big.pdf')).json()) as { id: string };
    const res = await send(s, { modelId: s.ids.small, attachmentIds: [pdf.id] });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).overflow[0].estimate).toBeGreaterThan(4096);
  });
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

  it('keeps asking after a Send-anyway reply whose prompt count was truncated by the server', async () => {
    const s = await setup();
    const { a } = longChat(s);
    // Ollama counts only what it kept, so the saved reply reports a small prompt for a chat far over the window.
    const r = insertMessage(s.db, { chatId: s.chatId, parentId: a.id, role: 'assistant', content: 'ok', modelId: s.ids.small, promptTokens: 100, completionTokens: 5 });
    setActiveLeaf(s.db, s.chatId, r.id);
    const res = await send(s, { modelId: s.ids.small });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).overflow[0].estimate).toBeGreaterThan(2048);
    const ctx = (await (await s.call('GET', `/api/context?model=${encodeURIComponent(s.ids.small)}&chat=${s.chatId}`)).json()) as any;
    expect(ctx.used).toBeGreaterThan(2048);
  });

  it('rejects a non-boolean allowOverflow', async () => {
    const s = await setup();
    const res = await send(s, { modelId: s.ids.small, allowOverflow: 'yes' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe('allowOverflow must be true or false.');
  });
});

describe('the window LM Studio loaded', () => {
  const BIG = 'x'.repeat(24_000); // ~6,000 estimated tokens

  async function lmSetup(loadedWindow: number | undefined) {
    fake = await startFakeLocalServer({ flavor: 'lmstudio', models: [{ name: 'qwen3-8b', contextLength: 32768, loadedWindow }] });
    const app = makeApp();
    const server = addServer(app.db, { type: 'lmstudio', name: 'LM Studio', baseUrl: fake.url, auto: false });
    const id = localModelId(server.id, 'qwen3-8b');
    addLocalModel(app.db, { id, serverId: server.id, sizeBytes: null, capsKnown: true, name: 'qwen3-8b', contextLength: 32768, inputModalities: ['text'], supportsTools: false, supportsReasoning: false });
    setContextWindow(app.db, id, 16384);
    const chat = (await (await app.call('POST', '/api/chats')).json()) as ChatSummary;
    const u = insertMessage(app.db, { chatId: chat.id, parentId: null, role: 'user', content: BIG });
    const a = insertMessage(app.db, { chatId: chat.id, parentId: u.id, role: 'assistant', content: 'ok', modelId: id });
    setActiveLeaf(app.db, chat.id, a.id);
    return { ...app, id, chatId: chat.id };
  }

  it('refuses against the loaded window, not My models', async () => {
    const s = await lmSetup(4096);
    const res = await s.call('POST', `/api/chats/${s.chatId}/messages`, { content: 'More', modelId: s.id });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).overflow[0]).toMatchObject({ modelId: s.id, window: 4096 });
  });

  it('uses the chosen window when the model is not loaded', async () => {
    const s = await lmSetup(undefined);
    const res = await s.call('POST', `/api/chats/${s.chatId}/messages`, { content: 'More', modelId: s.id });
    expect(res.status).toBe(200);
    await res.text();
  });

  it('shows the loaded window in the context ring', async () => {
    const s = await lmSetup(4096);
    const ctx = (await (await s.call('GET', `/api/context?model=${encodeURIComponent(s.id)}&chat=${s.chatId}`)).json()) as any;
    expect(ctx.contextLength).toBe(4096);
  });

  it('checks continue against the loaded window', async () => {
    const s = await lmSetup(4096);
    const res = await s.call('POST', `/api/chats/${s.chatId}/continue`, { modelId: s.id });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).overflow[0].window).toBe(4096);
  });

  it('leaves Ollama to its own request window', async () => {
    const s = await setup();
    const res = await s.call('GET', `/api/context?model=${encodeURIComponent(s.ids.small)}&chat=${s.chatId}`);
    expect(((await res.json()) as any).contextLength).toBe(2048);
  });
});


describe('GET /api/context', () => {
  it('counts an earlier PDF at its extracted text for a local model on the first call', async () => {
    const s = await setup();
    const line = 'word '.repeat(80);
    const pages = [0, 1].map(() => Array.from({ length: 30 }, () => line)); // ~6,000 tokens over 2 pages
    const pdf = (await (await s.upload(pdfWithPages(pages, 2), 'big.pdf')).json()) as { id: string };
    // Sent with an OpenRouter model, so nothing has extracted its text yet.
    await readEvents(await send(s, { modelId: s.ids.cloud, attachmentIds: [pdf.id] }));
    const res = await s.call('GET', `/api/context?model=${encodeURIComponent(s.ids.small)}&chat=${s.chatId}`);
    expect(((await res.json()) as any).parts.attachments).toBeGreaterThan(3000);
  });
});

describe('the reserve for web search results', () => {
  let search: FakeSearch | undefined;
  afterEach(async () => {
    await search?.close();
    search = undefined;
  });
  /** A 4,096-token window holding ~2,100 tokens: it fits with the margin, not with the reserve. */
  async function nearlyFull(service: 'searxng' | 'none') {
    search = await startFakeSearchServer();
    const s = await setup();
    setContextWindow(s.db, s.ids.small, 4096);
    longChat(s, 'x'.repeat(8_400));
    setSetting(s.db, 'web_search_service', service);
    setSetting(s.db, 'searxng_url', search.url);
    return s;
  }
  it('asks when a search will run and its results would not fit', async () => {
    const s = await nearlyFull('searxng');
    const res = await send(s, { modelId: s.ids.small, webSearch: true });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).overflow[0].modelId).toBe(s.ids.small);
  });
  it('does not ask without a search turned on', async () => {
    const s = await nearlyFull('searxng');
    expect((await send(s, { modelId: s.ids.small })).status).toBe(200);
  });
  it('does not ask when no search service is set up', async () => {
    const s = await nearlyFull('none');
    expect((await send(s, { modelId: s.ids.small, webSearch: true })).status).toBe(200);
  });
});
