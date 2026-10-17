import { describe, it, expect } from 'vitest';
import { makeApp, readEvents } from './appHelpers';
import { OpenRouterError, type OpenRouterClient, type StreamEvent } from '../src/openrouter';
import type { ChatMessage } from '../src/prompt';
import { getChatMessages } from '../src/messages';
import { getChatRow } from '../src/chats';
import { withCatalogDefaults, type Attachment, type ChatDetail, type ChatSummary, type Message } from '../../shared/types';
import { addModel } from '../src/library';
import { loadUsageRows } from '../src/usage';

type Script = { chunks: string[]; failWith?: Error; hang?: boolean };

/** Fake streamChat whose behaviour depends on the model. Records the models called and their prompts. */
function byModel(script: Record<string, Script>) {
  const calls: { model: string; messages: ChatMessage[] }[] = [];
  const streamChat: OpenRouterClient['streamChat'] = async function* ({ model, messages, signal }): AsyncGenerator<StreamEvent> {
    calls.push({ model, messages });
    const s = script[model] ?? { chunks: [`reply from ${model}`] };
    for (const text of s.chunks) yield { type: 'delta', text };
    if (s.hang) {
      const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
      await new Promise((_, reject) => {
        if (signal?.aborted) reject(abortError());
        signal?.addEventListener('abort', () => reject(abortError()));
      });
    }
    if (s.failWith) throw s.failWith;
    yield { type: 'usage', usage: { promptTokens: 1, completionTokens: 2, cost: 0.001, webSearches: null, cachedTokens: null, cacheWriteTokens: null, reasoningTokens: null } };
  };
  return { streamChat, calls };
}

async function newChat(call: ReturnType<typeof makeApp>['call']) {
  return ((await (await call('POST', '/api/chats')).json()) as ChatSummary).id;
}

const IDS = ['m/a', 'm/b', 'm/c'];

describe('comparisons', () => {
  it('runs every model and saves each reply as a version', async () => {
    const { streamChat, calls } = byModel({});
    const { call, db } = makeApp({ streamChat });
    const chatId = await newChat(call);
    const events = await readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: 'Q', modelIds: IDS }));

    expect(calls.map((c) => c.model).sort()).toEqual(IDS);
    const start = events[0];
    expect(start.event).toBe('start');
    expect(start.data.slots.map((s: { modelId: string }) => s.modelId)).toEqual(IDS);
    expect(events.filter((e) => e.event === 'delta').every((e) => typeof e.data.slot === 'number')).toBe(true);
    const slotDone = events.filter((e) => e.event === 'slot-done');
    expect(slotDone.map((e) => e.data.slot).sort()).toEqual([0, 1, 2]);
    const done = events.find((e) => e.event === 'done')!;
    expect(done.data).toEqual({ compareParentId: start.data.userMessageId });

    const replies = getChatMessages(db, chatId).filter((m) => m.role === 'assistant');
    expect(replies.map((m) => m.modelId).sort()).toEqual(IDS);
    expect(replies.every((m) => m.parentId === start.data.userMessageId && m.status === 'complete')).toBe(true);
    expect(getChatRow(db, chatId)).toMatchObject({ compare_parent_id: start.data.userMessageId, active_leaf_id: start.data.userMessageId });

    const detail = (await (await call('GET', `/api/chats/${chatId}`)).json()) as ChatDetail;
    expect(detail.messages.map((m) => m.role)).toEqual(['user']);
    expect(detail.compare?.replies).toHaveLength(3);
  });

  it('one model failing mid-stream keeps its partial and lets the others finish', async () => {
    const { streamChat } = byModel({ 'm/b': { chunks: ['Hal'], failWith: new OpenRouterError('The model provider returned an error.', 502) } });
    const { call } = makeApp({ streamChat });
    const chatId = await newChat(call);
    const events = await readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: 'Q', modelIds: IDS }));
    const failed = events.find((e) => e.event === 'slot-error')!;
    expect(failed.data).toMatchObject({ slot: 1, message: 'The model provider returned an error.', partial: { content: 'Hal', status: 'stopped' } });
    expect(events.filter((e) => e.event === 'slot-done').map((e) => e.data.slot).sort()).toEqual([0, 2]);
    expect(events.find((e) => e.event === 'done')!.data.compareParentId).toBeTruthy();
  });

  it('clears the pending choice when no model replies', async () => {
    const fail = { chunks: [], failWith: new OpenRouterError('Rate limited.', 429) };
    const { streamChat } = byModel({ 'm/a': fail, 'm/b': fail });
    const { call, db } = makeApp({ streamChat });
    const chatId = await newChat(call);
    const events = await readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: 'Q', modelIds: ['m/a', 'm/b'] }));
    expect(events.filter((e) => e.event === 'slot-error')).toHaveLength(2);
    expect(events.find((e) => e.event === 'done')!.data).toEqual({ compareParentId: null });
    expect(getChatRow(db, chatId)?.compare_parent_id).toBeNull();
    expect(getChatMessages(db, chatId).map((m) => m.role)).toEqual(['user']);
  });

  it('client abort saves every slot that has text', async () => {
    const { streamChat } = byModel({ 'm/a': { chunks: ['Part'], hang: true }, 'm/b': { chunks: [], hang: true } });
    const { app, call, db } = makeApp({ streamChat });
    const chatId = await newChat(call);
    const controller = new AbortController();
    const res = await app.request(new Request(`http://localhost/api/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Q', modelIds: ['m/a', 'm/b'] }),
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

    let replies: Message[] = [];
    for (let i = 0; i < 50 && replies.length < 1; i++) {
      await new Promise((r) => setTimeout(r, 20));
      replies = getChatMessages(db, chatId).filter((m) => m.role === 'assistant');
    }
    await new Promise((r) => setTimeout(r, 50));
    replies = getChatMessages(db, chatId).filter((m) => m.role === 'assistant');
    expect(replies).toEqual([expect.objectContaining({ modelId: 'm/a', content: 'Part', status: 'stopped' })]);
  });

  it('blocks new generations until a reply is chosen, then continues from it', async () => {
    const { streamChat, calls } = byModel({});
    const { call, db } = makeApp({ streamChat });
    const chatId = await newChat(call);
    const events = await readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: 'Q', modelIds: ['m/a', 'm/b'] }));
    const userId = events[0].data.userMessageId;

    const blocked = await call('POST', `/api/chats/${chatId}/messages`, { content: 'Next', modelId: 'm/a' });
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { error: string }).error).toBe('Pick a reply to continue.');
    expect((await call('POST', `/api/chats/${chatId}/regenerate`, { parentId: userId, modelId: 'm/a' })).status).toBe(409);
    expect((await call('POST', `/api/chats/${chatId}/edit`, { messageId: userId, content: 'x', modelId: 'm/a' })).status).toBe(409);

    const chosen = getChatMessages(db, chatId).find((m) => m.modelId === 'm/b')!;
    const detail = (await (await call('PATCH', `/api/chats/${chatId}`, { selectMessageId: chosen.id })).json()) as ChatDetail;
    expect(detail.compare).toBeNull();

    await readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: 'Next', modelId: 'm/a' }));
    expect(calls.at(-1)!.messages.map((m) => m.content)).toEqual(['Q', 'reply from m/b', 'Next']);
  });

  it('the lock covers the whole comparison', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const streamChat: OpenRouterClient['streamChat'] = async function* ({ model }) {
      yield { type: 'delta', text: model };
      if (model === 'm/b') await gate;
    };
    const { call } = makeApp({ streamChat });
    const chatId = await newChat(call);
    const running = await call('POST', `/api/chats/${chatId}/messages`, { content: 'Q', modelIds: ['m/a', 'm/b'] });
    const busy = await call('POST', `/api/chats/${chatId}/messages`, { content: 'Again', modelId: 'm/a' });
    expect(busy.status).toBe(409);
    expect(((await busy.json()) as { error: string }).error).toMatch(/still being generated/);
    release();
    await readEvents(running);
  });

  it('regenerate with modelIds hides the previous reply until a choice is made', async () => {
    const { streamChat } = byModel({});
    const { call } = makeApp({ streamChat });
    const chatId = await newChat(call);
    const first = await readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: 'Q', modelId: 'm/a' }));
    const userId = first[0].data.userMessageId;
    await readEvents(await call('POST', `/api/chats/${chatId}/regenerate`, { parentId: userId, modelIds: ['m/b', 'm/c'] }));
    const detail = (await (await call('GET', `/api/chats/${chatId}`)).json()) as ChatDetail;
    expect(detail.messages.map((m) => m.id)).toEqual([userId]);
    expect(detail.compare?.replies.map((m) => m.modelId)).toEqual(['m/a', 'm/b', 'm/c']);
  });

  it('a compare regenerate where no model replies keeps the previous reply visible', async () => {
    const fail = { chunks: [], failWith: new OpenRouterError('Rate limited.', 429) };
    const { streamChat } = byModel({ 'm/b': fail, 'm/c': fail });
    const { call } = makeApp({ streamChat });
    const chatId = await newChat(call);
    const first = await readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: 'Q', modelId: 'm/a' }));
    const { userMessageId, assistantMessageId } = first[0].data;
    await readEvents(await call('POST', `/api/chats/${chatId}/regenerate`, { parentId: userMessageId, modelIds: ['m/b', 'm/c'] }));
    const detail = (await (await call('GET', `/api/chats/${chatId}`)).json()) as ChatDetail;
    expect(detail.messages.map((m) => m.id)).toEqual([userMessageId, assistantMessageId]);
    expect(detail.compare).toBeNull();
  });

  it('validates modelIds', async () => {
    const { call } = makeApp();
    const chatId = await newChat(call);
    const send = (body: object) => call('POST', `/api/chats/${chatId}/messages`, { content: 'Q', ...body });
    expect((await send({ modelIds: ['m/a'] })).status).toBe(400);
    expect((await send({ modelIds: ['a/1', 'a/2', 'a/3', 'a/4', 'a/5'] })).status).toBe(400);
    expect((await send({ modelIds: ['m/a', 'm/a'] })).status).toBe(400);
    expect((await send({ modelIds: ['m/a', ' '] })).status).toBe(400);
    expect((await send({ modelIds: ['m/a', 'm/b'], modelId: 'm/a' })).status).toBe(400);
    expect((await send({ modelIds: 'm/a' })).status).toBe(400);
  });

  it('titles a new chat after its first comparison using the first complete reply', async () => {
    const { streamChat } = byModel({ 'm/a': { chunks: [], failWith: new OpenRouterError('Rate limited.', 429) } });
    let transcript = '';
    const complete: OpenRouterClient['complete'] = async ({ messages }) => {
      transcript = String(messages.at(-1)!.content);
      return 'Compared chat';
    };
    const { call, db } = makeApp({ streamChat, complete });
    const chatId = await newChat(call);
    const events = await readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: 'Question', modelIds: ['m/a', 'm/b'] }));
    expect(events.at(-1)).toEqual({ event: 'title', data: { title: 'Compared chat' } });
    expect(transcript).toBe('user: Question\n\nassistant: reply from m/b');
    expect(getChatRow(db, chatId)?.title).toBe('Compared chat');
  });
});

describe('comparisons with attachments', () => {
  it('builds each model its own prompt for the same image', async () => {
    const { streamChat, calls } = byModel({});
    const { call, db, upload } = makeApp({ streamChat });
    addModel(db, withCatalogDefaults({ id: 'v/vision', name: 'Vision', inputModalities: ['text', 'image'] }));
    addModel(db, withCatalogDefaults({ id: 't/text', name: 'Text' }));
    const chatId = await newChat(call);
    const image = (await (await upload(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]), 'photo.png')).json()) as Attachment;
    const first = await readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: 'What?', modelId: 'v/vision', attachmentIds: [image.id] }));
    await readEvents(await call('POST', `/api/chats/${chatId}/regenerate`, { parentId: first[0].data.userMessageId, modelIds: ['v/vision', 't/text'] }));
    const parts = (model: string) => calls.filter((c) => c.model === model).at(-1)!.messages.at(-1)!.content as { type: string }[];
    expect(parts('v/vision').map((p) => p.type)).toEqual(['text', 'image_url']);
    expect(parts('t/text').map((p) => p.type)).toEqual(['text', 'text']);
  });
});

describe('comparison usage log', () => {
  it('logs every slot under one run, including one that failed before any text', async () => {
    const { streamChat } = byModel({ 'm/b': { chunks: [], failWith: new OpenRouterError('Rate limited', 429) } });
    const { call, db } = makeApp({ streamChat });
    const chatId = await newChat(call);
    await readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: 'Q', modelIds: IDS }));
    const replies = loadUsageRows(db, null).filter((r) => r.purpose === 'reply');
    expect(replies).toHaveLength(3);
    expect(new Set(replies.map((r) => r.runId)).size).toBe(1);
    expect(replies.every((r) => r.compare && r.kind === 'send' && r.chatId === chatId)).toBe(true);
    expect(replies.find((r) => r.modelId === 'm/b')).toMatchObject({ status: 'error', messageId: null });
    expect(replies.filter((r) => r.status === 'complete').every((r) => r.messageId !== null)).toBe(true);
  });

  it('still logs every slot when the chat is deleted mid-comparison', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const streamChat: OpenRouterClient['streamChat'] = async function* () {
      yield { type: 'delta', text: 'Hel' };
      await gate;
    };
    const { call, db } = makeApp({ streamChat });
    const chatId = await newChat(call);
    const pending = (async () => readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: 'Q', modelIds: ['m/a', 'm/b'] })))();
    await new Promise((r) => setTimeout(r, 20));
    await call('DELETE', `/api/chats/${chatId}`);
    release();
    await pending;
    expect(loadUsageRows(db, null).filter((r) => r.purpose === 'reply').map((r) => [r.modelId, r.messageId]).sort()).toEqual([['m/a', null], ['m/b', null]]);
  });

  it('logs aborted slots as stopped, with or without text', async () => {
    const { streamChat } = byModel({ 'm/a': { chunks: ['Part'], hang: true }, 'm/b': { chunks: [], hang: true } });
    const { app, call, db } = makeApp({ streamChat });
    const chatId = await newChat(call);
    const controller = new AbortController();
    const res = await app.request(new Request(`http://localhost/api/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Q', modelIds: ['m/a', 'm/b'] }),
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

    let rows = loadUsageRows(db, null);
    for (let i = 0; i < 50 && rows.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 20));
      rows = loadUsageRows(db, null);
    }
    expect(rows.map((r) => [r.modelId, r.status, r.messageId !== null]).sort()).toEqual([['m/a', 'stopped', true], ['m/b', 'stopped', false]]);
  });
});
