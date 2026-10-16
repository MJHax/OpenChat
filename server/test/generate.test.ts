import { describe, it, expect } from 'vitest';
import { makeApp, readEvents } from './appHelpers';
import { OpenRouterError, type OpenRouterClient, type StreamEvent, type Usage } from '../src/openrouter';
import type { ChatMessage } from '../src/prompt';
import { getChatMessages } from '../src/messages';
import { getChatRow } from '../src/chats';
import { cleanTitle } from '../src/title';
import { updateSettings } from '../src/settings';
import { withCatalogDefaults, type Attachment, type ChatDetail, type ChatSummary, type Message } from '../../shared/types';
import { addModel } from '../src/library';

const USAGE: Usage = { promptTokens: 10, completionTokens: 5, cost: 0.0004 };

/** Fake streamChat that plays `chunks`, then either fails or reports usage. Records every prompt it receives. */
function scripted(replies: { chunks: string[]; failWith?: Error }[]) {
  const calls: ChatMessage[][] = [];
  const streamChat: OpenRouterClient['streamChat'] = async function* ({ messages }): AsyncGenerator<StreamEvent> {
    calls.push(messages);
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    for (const text of reply.chunks) yield { type: 'delta', text };
    if (reply.failWith) throw reply.failWith;
    yield { type: 'usage', usage: USAGE };
  };
  return { streamChat, calls };
}

async function newChat(call: ReturnType<typeof makeApp>['call']) {
  return ((await (await call('POST', '/api/chats')).json()) as ChatSummary).id;
}

describe('send', () => {
  it('streams a reply, saves both messages, and auto-titles the chat', async () => {
    const { streamChat } = scripted([{ chunks: ['Hel', 'lo!'] }]);
    const { call, db } = makeApp({ streamChat, complete: async () => '"Greeting chat."' });
    const chatId = await newChat(call);

    const events = await readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: 'Hi', modelId: 'openai/gpt-4o' }));
    expect(events.map((e) => e.event)).toEqual(['start', 'delta', 'delta', 'done', 'title']);
    const done = events[3].data.message as Message;
    expect(done).toMatchObject({ role: 'assistant', content: 'Hello!', modelId: 'openai/gpt-4o', promptTokens: 10, completionTokens: 5, cost: 0.0004, status: 'complete' });
    expect(events[4].data).toEqual({ title: 'Greeting chat' });

    const saved = getChatMessages(db, chatId);
    expect(saved.map((m) => [m.role, m.content])).toEqual([['user', 'Hi'], ['assistant', 'Hello!']]);
    expect(saved[1].parentId).toBe(saved[0].id);
    expect(getChatRow(db, chatId)).toMatchObject({ active_leaf_id: done.id, title: 'Greeting chat' });
  });

  it('includes the persona and only enabled memories in the prompt', async () => {
    const { streamChat, calls } = scripted([{ chunks: ['ok'] }]);
    const { call, db } = makeApp({ streamChat });
    updateSettings(db, { aboutMe: 'I am Sam.' });
    await call('POST', '/api/memories', { content: 'Likes tea' });
    const paused = (await (await call('POST', '/api/memories', { content: 'Secret fact' })).json()) as { id: number };
    await call('PATCH', `/api/memories/${paused.id}`, { enabled: false });
    const chatId = await newChat(call);

    await readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: 'Hi', modelId: 'm/x' }));
    expect(calls[0][0].role).toBe('system');
    expect(calls[0][0].content).toContain('I am Sam.');
    expect(calls[0][0].content).toContain('Likes tea');
    expect(calls[0][0].content).not.toContain('Secret fact');
    expect(calls[0].at(-1)).toEqual({ role: 'user', content: 'Hi' });
  });

  it('continues from the active leaf on the second message', async () => {
    const { streamChat, calls } = scripted([{ chunks: ['A1'] }, { chunks: ['A2'] }]);
    const { call } = makeApp({ streamChat });
    const chatId = await newChat(call);
    await readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: 'Q1', modelId: 'm/x' }));
    await readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: 'Q2', modelId: 'm/y' }));
    expect(calls[1].map((m) => m.content)).toEqual(['Q1', 'A1', 'Q2']);
    const detail = (await (await call('GET', `/api/chats/${chatId}`)).json()) as ChatDetail;
    expect(detail.messages.map((m) => [m.content, m.modelId])).toEqual([['Q1', null], ['A1', 'm/x'], ['Q2', null], ['A2', 'm/y']]);
  });

  it('rejects empty content and a missing model with 400, unknown chat with 404', async () => {
    const { call } = makeApp();
    const chatId = await newChat(call);
    expect((await call('POST', `/api/chats/${chatId}/messages`, { content: '  ', modelId: 'm/x' })).status).toBe(400);
    expect((await call('POST', `/api/chats/${chatId}/messages`, { content: 'Hi', modelId: '' })).status).toBe(400);
    expect((await call('POST', '/api/chats/nope/messages', { content: 'Hi', modelId: 'm/x' })).status).toBe(404);
  });

  it('sends an error event when no API key is configured', async () => {
    const { call, db } = makeApp({}, {});
    const chatId = await newChat(call);
    const events = await readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: 'Hi', modelId: 'm/x' }));
    expect(events.map((e) => e.event)).toEqual(['start', 'error']);
    expect(events[1].data.message).toMatch(/Settings/);
    expect(getChatMessages(db, chatId).map((m) => m.role)).toEqual(['user']);
  });
});

describe('regenerate and edit', () => {
  it('regenerate adds a sibling reply and hides the old one from the prompt', async () => {
    const { streamChat, calls } = scripted([{ chunks: ['First'] }, { chunks: ['Second'] }]);
    const { call } = makeApp({ streamChat });
    const chatId = await newChat(call);
    const first = await readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: 'Q', modelId: 'm/a' }));
    const userId = first[0].data.userMessageId as string;

    await readEvents(await call('POST', `/api/chats/${chatId}/regenerate`, { parentId: userId, modelId: 'm/b' }));
    expect(calls[1].map((m) => m.content)).toEqual(['Q']);

    const detail = (await (await call('GET', `/api/chats/${chatId}`)).json()) as ChatDetail;
    expect(detail.messages[1]).toMatchObject({ content: 'Second', modelId: 'm/b', siblingIndex: 1 });
    expect(detail.messages[1].siblingIds).toHaveLength(2);
  });

  it('edit creates a sibling user message and a new reply, keeping the old branch', async () => {
    const { streamChat, calls } = scripted([{ chunks: ['About cats'] }, { chunks: ['About dogs'] }]);
    const { call, db } = makeApp({ streamChat });
    const chatId = await newChat(call);
    const first = await readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: 'Cats?', modelId: 'm/a' }));
    const userId = first[0].data.userMessageId as string;

    const events = await readEvents(await call('POST', `/api/chats/${chatId}/edit`, { messageId: userId, content: 'Dogs?', modelId: 'm/a' }));
    expect(events[0].data.userMessageId).not.toBe(userId);
    expect(calls[1].map((m) => m.content)).toEqual(['Dogs?']);

    const detail = (await (await call('GET', `/api/chats/${chatId}`)).json()) as ChatDetail;
    expect(detail.messages.map((m) => m.content)).toEqual(['Dogs?', 'About dogs']);
    expect(detail.messages[0]).toMatchObject({ siblingIndex: 1, siblingIds: [userId, events[0].data.userMessageId] });
    expect(getChatMessages(db, chatId)).toHaveLength(4);
  });

  it('rejects regenerate/edit targets that are not user messages in this chat', async () => {
    const { streamChat } = scripted([{ chunks: ['A'] }]);
    const { call } = makeApp({ streamChat });
    const chatId = await newChat(call);
    const first = await readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: 'Q', modelId: 'm/a' }));
    const assistantId = first[0].data.assistantMessageId as string;
    expect((await call('POST', `/api/chats/${chatId}/regenerate`, { parentId: assistantId, modelId: 'm/a' })).status).toBe(400);
    expect((await call('POST', `/api/chats/${chatId}/edit`, { messageId: assistantId, content: 'x', modelId: 'm/a' })).status).toBe(400);
    expect((await call('POST', `/api/chats/${chatId}/regenerate`, { parentId: 'nope', modelId: 'm/a' })).status).toBe(400);
  });
});

describe('failures', () => {
  it('error before any output keeps the user message and saves no reply', async () => {
    const { streamChat } = scripted([{ chunks: [], failWith: new OpenRouterError('Your OpenRouter account is out of credits.', 402) }]);
    const { call, db } = makeApp({ streamChat });
    const chatId = await newChat(call);
    const events = await readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: 'Hi', modelId: 'm/a' }));
    expect(events.map((e) => e.event)).toEqual(['start', 'error']);
    expect(events[1].data).toEqual({ message: 'Your OpenRouter account is out of credits.', partial: null });
    const saved = getChatMessages(db, chatId);
    expect(saved.map((m) => m.role)).toEqual(['user']);
    expect(getChatRow(db, chatId)?.active_leaf_id).toBe(saved[0].id);
  });

  it('mid-stream error saves partial output as stopped', async () => {
    const { streamChat } = scripted([{ chunks: ['Half an ans'], failWith: new OpenRouterError('The model provider returned an error.', 502) }]);
    const { call, db } = makeApp({ streamChat });
    const chatId = await newChat(call);
    const events = await readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: 'Hi', modelId: 'm/a' }));
    const error = events.at(-1)!;
    expect(error.event).toBe('error');
    expect(error.data.partial).toMatchObject({ content: 'Half an ans', status: 'stopped' });
    expect(getChatRow(db, chatId)?.active_leaf_id).toBe(error.data.partial.id);
  });

  it('a failed regenerate leaves the previous reply active', async () => {
    const { streamChat } = scripted([{ chunks: ['Good'] }, { chunks: [], failWith: new OpenRouterError('Rate limited.', 429) }]);
    const { call, db } = makeApp({ streamChat });
    const chatId = await newChat(call);
    const first = await readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: 'Q', modelId: 'm/a' }));
    const { userMessageId, assistantMessageId } = first[0].data;
    await readEvents(await call('POST', `/api/chats/${chatId}/regenerate`, { parentId: userMessageId, modelId: 'm/b' }));
    expect(getChatRow(db, chatId)?.active_leaf_id).toBe(assistantMessageId);
  });

  it('client abort mid-stream saves partial as stopped', async () => {
    const streamChat: OpenRouterClient['streamChat'] = async function* ({ signal }) {
      yield { type: 'delta', text: 'Partial' };
      // Like fetch, reject immediately if the signal is already aborted.
      const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
      await new Promise((_, reject) => {
        if (signal?.aborted) reject(abortError());
        signal?.addEventListener('abort', () => reject(abortError()));
      });
    };
    const { app, db, call } = makeApp({ streamChat });
    const chatId = await newChat(call);
    const controller = new AbortController();
    const res = await app.request(new Request(`http://localhost/api/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Hi', modelId: 'm/a' }),
      signal: controller.signal,
    }));
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let seen = '';
    while (!seen.includes('event: delta')) seen += dec.decode((await reader.read()).value);
    controller.abort();
    await reader.cancel().catch(() => {});

    let saved: Message[] = [];
    for (let i = 0; i < 50 && saved.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 20));
      saved = getChatMessages(db, chatId);
    }
    expect(saved[1]).toMatchObject({ role: 'assistant', content: 'Partial', status: 'stopped' });
  });

  it('title failure does not affect the reply', async () => {
    const { streamChat } = scripted([{ chunks: ['Fine'] }]);
    const { call, db } = makeApp({ streamChat, complete: async () => { throw new OpenRouterError('boom', 502); } });
    const chatId = await newChat(call);
    const events = await readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: 'Hi', modelId: 'm/a' }));
    expect(events.map((e) => e.event)).toEqual(['start', 'delta', 'done']);
    expect(getChatRow(db, chatId)?.title).toBe('New chat');
  });
});

describe('review fixes', () => {
  it('rejects a second generation in the same chat while one is in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let n = 0;
    const streamChat: OpenRouterClient['streamChat'] = async function* () {
      n++;
      yield { type: 'delta', text: 'Working' };
      if (n === 1) await gate;
      yield { type: 'usage', usage: USAGE };
    };
    const { call, db } = makeApp({ streamChat });
    const chatId = await newChat(call);
    const first = call('POST', `/api/chats/${chatId}/messages`, { content: 'Long task', modelId: 'm/a' });
    const firstRes = await first;
    const busy = await call('POST', `/api/chats/${chatId}/messages`, { content: 'Second', modelId: 'm/a' });
    expect(busy.status).toBe(409);
    expect(getChatMessages(db, chatId).filter((m) => m.role === 'user')).toHaveLength(1);
    release();
    await readEvents(firstRes);
    const after = await call('POST', `/api/chats/${chatId}/messages`, { content: 'Second', modelId: 'm/a' });
    expect(after.status).toBe(200);
    await readEvents(after);
  });

  it('titles the chat when the first complete reply follows a stopped one', async () => {
    const { streamChat } = scripted([{ chunks: ['Par'], failWith: new OpenRouterError('The model provider returned an error.', 502) }, { chunks: ['Full'] }]);
    const { call, db } = makeApp({ streamChat, complete: async () => 'Recovered chat' });
    const chatId = await newChat(call);
    const first = await readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: 'Hi', modelId: 'm/a' }));
    const events = await readEvents(await call('POST', `/api/chats/${chatId}/regenerate`, { parentId: first[0].data.userMessageId, modelId: 'm/a' }));
    expect(events.map((e) => e.event)).toContain('title');
    expect(getChatRow(db, chatId)?.title).toBe('Recovered chat');
  });
});

describe('reasoning models', () => {
  it('forwards reasoning as its own event and keeps it out of the saved reply', async () => {
    const streamChat: OpenRouterClient['streamChat'] = async function* () {
      yield { type: 'reasoning', text: 'Thinking hard' };
      yield { type: 'delta', text: 'Answer' };
    };
    const { call, db } = makeApp({ streamChat });
    const chatId = await newChat(call);
    const events = await readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: 'Q', modelId: 'm/a' }));
    expect(events.slice(0, 3).map((e) => [e.event, e.data.text])).toEqual([['start', undefined], ['reasoning', 'Thinking hard'], ['delta', 'Answer']]);
    expect(getChatMessages(db, chatId)[1].content).toBe('Answer');
  });

  it('allows a new generation while the title is still being generated', async () => {
    let releaseTitle!: () => void;
    const titleGate = new Promise<void>((r) => { releaseTitle = r; });
    const { streamChat } = scripted([{ chunks: ['One'] }, { chunks: ['Two'] }]);
    const { call } = makeApp({ streamChat, complete: async () => { await titleGate; return 'Slow title'; } });
    const chatId = await newChat(call);
    const first = await call('POST', `/api/chats/${chatId}/messages`, { content: 'Q', modelId: 'm/a' });
    const reader = first.body!.getReader();
    const dec = new TextDecoder();
    let seen = '';
    while (!seen.includes('event: done')) seen += dec.decode((await reader.read()).value);
    const userId = JSON.parse(seen.split('\n').find((l) => l.startsWith('data: '))!.slice(6)).userMessageId;
    const regen = await call('POST', `/api/chats/${chatId}/regenerate`, { parentId: userId, modelId: 'm/b' });
    expect(regen.status).toBe(200);
    await readEvents(regen);
    releaseTitle();
    await reader.cancel().catch(() => {});
  });

  it('gives the title call enough tokens for models that reason first', async () => {
    const { streamChat } = scripted([{ chunks: ['Hi there'] }]);
    // Reasoning models spend small budgets entirely on reasoning and return no content.
    const complete: OpenRouterClient['complete'] = async ({ maxTokens }) => ((maxTokens ?? 0) >= 500 ? 'Greeting' : '');
    const { call, db } = makeApp({ streamChat, complete });
    const chatId = await newChat(call);
    await readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: 'Hi', modelId: 'm/a' }));
    expect(getChatRow(db, chatId)?.title).toBe('Greeting');
  });
});

describe('cleanTitle', () => {
  it('strips quotes, markdown and trailing punctuation and keeps one line', () => {
    expect(cleanTitle('"Trip planning ideas."')).toBe('Trip planning ideas');
    expect(cleanTitle('## **Rust lifetimes**\nextra')).toBe('Rust lifetimes');
    expect(cleanTitle('   ')).toBe('');
  });
});

describe('attachments in prompts', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
  const hasImagePart = (messages: ChatMessage[]) =>
    messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));
  const hasNote = (messages: ChatMessage[]) =>
    messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'text' && p.text.includes("can't view images")));

  async function imageChat() {
    const { streamChat, calls } = scripted([{ chunks: ['ok'] }]);
    const ctx = makeApp({ streamChat });
    addModel(ctx.db, withCatalogDefaults({ id: 'v/vision', name: 'Vision', inputModalities: ['text', 'image'] }));
    addModel(ctx.db, withCatalogDefaults({ id: 't/text', name: 'Text' }));
    const chatId = await newChat(ctx.call);
    const image = (await (await ctx.upload(PNG, 'photo.png')).json()) as Attachment;
    const events = await readEvents(await ctx.call('POST', `/api/chats/${chatId}/messages`, { content: 'What is this?', modelId: 'v/vision', attachmentIds: [image.id] }));
    return { ...ctx, calls, chatId, userId: events[0].data.userMessageId as string };
  }

  it('sends the image to a model that can view it', async () => {
    const { calls } = await imageChat();
    expect(hasImagePart(calls[0])).toBe(true);
  });

  it('regenerates with a text-only model using a note instead of the image', async () => {
    const { call, calls, chatId, userId } = await imageChat();
    const res = await call('POST', `/api/chats/${chatId}/regenerate`, { parentId: userId, modelId: 't/text' });
    expect(res.status).toBe(200);
    await readEvents(res);
    expect(hasImagePart(calls[1])).toBe(false);
    expect(hasNote(calls[1])).toBe(true);
  });

  it('treats a model that is not in the library as text-only', async () => {
    const { call, calls, chatId, userId } = await imageChat();
    await readEvents(await call('POST', `/api/chats/${chatId}/regenerate`, { parentId: userId, modelId: 'gone/model' }));
    expect(hasNote(calls[1])).toBe(true);
  });

  it('names attachments in the title transcript', async () => {
    const { streamChat } = scripted([{ chunks: ['ok'] }]);
    const titlePrompts: ChatMessage[][] = [];
    const { call, upload } = makeApp({ streamChat, complete: async ({ messages }) => { titlePrompts.push(messages); return 'Report'; } });
    const chatId = await newChat(call);
    const pdf = (await (await upload('%PDF-1.4\n', 'report.pdf')).json()) as Attachment;
    await readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: '', modelId: 'm/x', attachmentIds: [pdf.id] }));
    expect(titlePrompts[0][1].content).toContain('user:  [attached: report.pdf]');
  });
});
