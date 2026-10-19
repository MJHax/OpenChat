import { describe, it, expect } from 'vitest';
import { makeApp, readEvents } from './appHelpers';
import { OpenRouterError, type OpenRouterClient, type StreamEvent, type Usage, type WebSearchMode } from '../src/openrouter';
import { mergeSources } from '../src/generate';
import { FILE_INSTRUCTIONS_HEADER, type ChatMessage } from '../src/prompt';
import { getChatMessages, insertMessage } from '../src/messages';
import { getChatRow } from '../src/chats';
import { cleanTitle } from '../src/title';
import { updateSettings } from '../src/settings';
import { withCatalogDefaults, type Attachment, type ChatDetail, type ChatSummary, type Message, type Source } from '../../shared/types';
import { addModel } from '../src/library';
import { loadUsageRows } from '../src/usage';

const USAGE: Usage = { promptTokens: 10, completionTokens: 5, cost: 0.0004, webSearches: null, cachedTokens: null, cacheWriteTokens: null, reasoningTokens: null };

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

  it('sends cache breakpoints to Claude and plain strings to others', async () => {
    const { streamChat, calls } = scripted([{ chunks: ['ok'] }]);
    const { call } = makeApp({ streamChat });
    for (const modelId of ['anthropic/claude-haiku-4.5', 'openai/gpt-4o']) {
      await readEvents(await call('POST', `/api/chats/${await newChat(call)}/messages`, { content: 'Hi', modelId }));
    }
    const mark = { type: 'ephemeral' };
    expect(calls[0][0].content).toEqual([expect.objectContaining({ type: 'text', cache_control: mark })]);
    expect(calls[0].at(-1)!.content).toEqual([{ type: 'text', text: 'Hi', cache_control: mark }]);
    expect(typeof calls[1][0].content).toBe('string');
    expect(calls[1].at(-1)!.content).toBe('Hi');
  });

  it("sends the chat's instructions after the global ones", async () => {
    const { streamChat, calls } = scripted([{ chunks: ['ok'] }]);
    const { call, db } = makeApp({ streamChat });
    updateSettings(db, { customInstructions: 'Be brief.' });
    const chatId = ((await (await call('POST', '/api/chats', { instructions: 'Use French.' })).json()) as ChatSummary).id;
    await readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: 'Hi', modelId: 'm/x' }));
    expect(calls[0][0].content).toContain('Instructions:\nBe brief.\n\nInstructions for this chat:\nUse French.');
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
    expect(calls[1].filter((m) => m.role !== 'system').map((m) => m.content)).toEqual(['Q1', 'A1', 'Q2']);
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
    expect(calls[1].filter((m) => m.role !== 'system').map((m) => m.content)).toEqual(['Q']);

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
    expect(calls[1].filter((m) => m.role !== 'system').map((m) => m.content)).toEqual(['Dogs?']);

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

describe('web search', () => {
  type Reply = { sources?: Source[][]; webSearches?: number | null; failWith?: Error };
  /** Records each call's model and search mode; plays sources events, text, then usage (or a failure). */
  function searching(reply: Reply = {}) {
    const calls: { model: string; webSearch: WebSearchMode | undefined }[] = [];
    const streamChat: OpenRouterClient['streamChat'] = async function* ({ model, webSearch }): AsyncGenerator<StreamEvent> {
      calls.push({ model, webSearch });
      yield { type: 'delta', text: 'Answer' };
      for (const sources of reply.sources ?? []) yield { type: 'sources', sources };
      if (reply.failWith) throw reply.failWith;
      yield { type: 'usage', usage: { ...USAGE, webSearches: reply.webSearches ?? null } };
    };
    const ctx = makeApp({ streamChat });
    addModel(ctx.db, withCatalogDefaults({ id: 't/tools', name: 'Tools', supportsTools: true }));
    addModel(ctx.db, withCatalogDefaults({ id: 'n/none', name: 'No tools' }));
    addModel(ctx.db, withCatalogDefaults({ id: 'u/unknown', name: 'Unknown' }));
    ctx.db.prepare("UPDATE models SET supports_tools = NULL WHERE id = 'u/unknown'").run();
    return { ...ctx, calls };
  }
  const A = { url: 'https://a.example', title: 'A' };
  const B = { url: 'https://b.example', title: 'B' };

  it('stores the flag and picks the tool or the plugin from the model', async () => {
    const { call, calls, db } = searching();
    const chatId = await newChat(call);
    for (const modelId of ['t/tools', 'n/none', 'u/unknown', 'gone/model']) {
      await readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: `Q ${modelId}`, modelId, webSearch: true }));
    }
    expect(calls.map((c) => c.webSearch)).toEqual(['tool', 'plugin', 'plugin', 'plugin']);
    expect(getChatMessages(db, chatId).filter((m) => m.role === 'user').every((m) => m.webSearch)).toBe(true);
  });

  it('does not search unless asked, and rejects a non-boolean flag', async () => {
    const { call, calls } = searching();
    const chatId = await newChat(call);
    await readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: 'Hi', modelId: 't/tools' }));
    expect(calls[0].webSearch).toBeUndefined();
    for (const path of ['messages', 'edit']) {
      const res = await call('POST', `/api/chats/${chatId}/${path}`, { content: 'x', modelId: 't/tools', messageId: 'whatever', webSearch: 'yes' });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('webSearch must be true or false.');
    }
  });

  it('saves deduplicated sources and the search count', async () => {
    const { call, db } = searching({ sources: [[A, B], [{ ...A, title: 'A again' }]], webSearches: 2 });
    const chatId = await newChat(call);
    const events = await readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: 'Q', modelId: 't/tools', webSearch: true }));
    const done = events.find((e) => e.event === 'done')!.data.message as Message;
    expect(done.sources).toEqual([A, B]);
    expect(done.webSearches).toBe(2);
    expect(getChatMessages(db, chatId)[1].sources).toEqual([A, B]);
  });

  it('counts one search for the plugin when sources arrived, none otherwise', async () => {
    const withSources = searching({ sources: [[A]] });
    let chatId = await newChat(withSources.call);
    let events = await readEvents(await withSources.call('POST', `/api/chats/${chatId}/messages`, { content: 'Q', modelId: 'n/none', webSearch: true }));
    expect((events.find((e) => e.event === 'done')!.data.message as Message).webSearches).toBe(1);
    const without = searching();
    chatId = await newChat(without.call);
    events = await readEvents(await without.call('POST', `/api/chats/${chatId}/messages`, { content: 'Q', modelId: 'n/none', webSearch: true }));
    expect((events.find((e) => e.event === 'done')!.data.message as Message).webSearches).toBeNull();
  });

  it('keeps the sources of a reply that fails part-way', async () => {
    const { call } = searching({ sources: [[A]], failWith: new OpenRouterError('The model provider returned an error.', 502) });
    const chatId = await newChat(call);
    const events = await readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: 'Q', modelId: 't/tools', webSearch: true }));
    const error = events.find((e) => e.event === 'error')!.data;
    expect(error.partial).toMatchObject({ status: 'stopped', sources: [A] });
  });

  it('regenerate reuses the flag saved on the user message', async () => {
    const { call, calls, db } = searching();
    const chatId = await newChat(call);
    const first = await readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: 'Q', modelId: 't/tools', webSearch: true }));
    await readEvents(await call('POST', `/api/chats/${chatId}/regenerate`, { parentId: first[0].data.userMessageId, modelId: 't/tools' }));
    expect(calls[1].webSearch).toBe('tool');

    const old = insertMessage(db, { chatId, parentId: null, role: 'user', content: 'from before web search' });
    await readEvents(await call('POST', `/api/chats/${chatId}/regenerate`, { parentId: old.id, modelId: 't/tools' }));
    expect(calls[2].webSearch).toBeUndefined();
  });

  it('edit stores the flag on the new version', async () => {
    const { call, calls, db } = searching();
    const chatId = await newChat(call);
    const first = await readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: 'v1', modelId: 't/tools' }));
    await readEvents(await call('POST', `/api/chats/${chatId}/edit`, { messageId: first[0].data.userMessageId, content: 'v2', modelId: 't/tools', webSearch: true }));
    expect(getChatMessages(db, chatId).find((m) => m.content === 'v2')?.webSearch).toBe(true);
    expect(calls[1].webSearch).toBe('tool');
  });

  it('compares a tool model and a plugin model, each with its own sources', async () => {
    const { call, calls, db } = searching({ sources: [[A]] });
    const chatId = await newChat(call);
    await readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: 'Q', modelIds: ['t/tools', 'n/none'], webSearch: true }));
    expect(Object.fromEntries(calls.map((c) => [c.model, c.webSearch]))).toEqual({ 't/tools': 'tool', 'n/none': 'plugin' });
    const replies = getChatMessages(db, chatId).filter((m) => m.role === 'assistant');
    expect(replies.map((m) => m.sources)).toEqual([[A], [A]]);
  });
});

describe('mergeSources', () => {
  it('appends new URLs in order and keeps the first title', () => {
    const A = { url: 'https://a.example', title: 'A' };
    expect(mergeSources([A], [{ url: 'https://a.example', title: 'Other' }, { url: 'https://b.example', title: 'B' }]))
      .toEqual([A, { url: 'https://b.example', title: 'B' }]);
  });
});

describe('usage log', () => {
  const rows = (db: ReturnType<typeof makeApp>['db']) => loadUsageRows(db, null);

  it('logs a reply with its kind, message, usage and timing, plus the title call', async () => {
    const { streamChat } = scripted([{ chunks: ['Hi'] }]);
    const complete: OpenRouterClient['complete'] = async ({ onUsage }) => {
      onUsage?.({ ...USAGE, cost: 0.0001 });
      return 'Greeting';
    };
    const { call, db } = makeApp({ streamChat, complete });
    const chatId = await newChat(call);
    const events = await readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: 'Hi', modelId: 'm/x' }));
    const reply = events.find((e) => e.event === 'done')!.data.message as Message;

    const [replyRow, titleRow] = rows(db);
    expect(replyRow).toMatchObject({
      purpose: 'reply', kind: 'send', chatId, messageId: reply.id, modelId: 'm/x', compare: false, promptTokens: 10, completionTokens: 5,
      cost: 0.0004, status: 'complete', webSearch: false, attachments: 0, backfilled: false,
    });
    expect(replyRow.runId).toBeTruthy();
    expect(replyRow.durationMs).not.toBeNull();
    expect(replyRow.firstTokenMs).not.toBeNull();
    expect(titleRow).toMatchObject({ purpose: 'title', chatId, cost: 0.0001, status: 'complete', kind: null });
  });

  it('logs regenerate and edit kinds', async () => {
    const { streamChat } = scripted([{ chunks: ['A'] }]);
    const { call, db } = makeApp({ streamChat });
    const chatId = await newChat(call);
    const first = await readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: 'Q', modelId: 'm/x' }));
    const userId = first[0].data.userMessageId as string;
    await readEvents(await call('POST', `/api/chats/${chatId}/regenerate`, { parentId: userId, modelId: 'm/x' }));
    await readEvents(await call('POST', `/api/chats/${chatId}/edit`, { messageId: userId, content: 'Q2', modelId: 'm/x' }));
    expect(rows(db).filter((r) => r.purpose === 'reply').map((r) => r.kind)).toEqual(['send', 'regenerate', 'edit']);
  });

  it('counts the files on a sent message', async () => {
    const { streamChat } = scripted([{ chunks: ['A'] }]);
    const { call, db, upload } = makeApp({ streamChat });
    const chatId = await newChat(call);
    const a = (await (await upload('one', 'a.txt')).json()) as Attachment;
    const b = (await (await upload('two', 'b.txt')).json()) as Attachment;
    await readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: 'Read these', modelId: 'm/x', attachmentIds: [a.id, b.id] }));
    expect(rows(db).find((r) => r.purpose === 'reply')!.attachments).toBe(2);
  });

  it('logs a failure before any text as an error with no message', async () => {
    const { streamChat } = scripted([{ chunks: [], failWith: new OpenRouterError('Rate limited', 429) }]);
    const { call, db } = makeApp({ streamChat });
    const chatId = await newChat(call);
    await readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: 'Q', modelId: 'm/x' }));
    expect(rows(db)).toEqual([expect.objectContaining({ purpose: 'reply', status: 'error', messageId: null, cost: null })]);
  });

  it('logs a failure after text as an error linked to the partial reply', async () => {
    const { streamChat } = scripted([{ chunks: ['Par'], failWith: new OpenRouterError('Provider died', 502) }]);
    const { call, db } = makeApp({ streamChat });
    const chatId = await newChat(call);
    const events = await readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: 'Q', modelId: 'm/x' }));
    const partial = events.find((e) => e.event === 'error')!.data.partial as Message;
    expect(rows(db)[0]).toMatchObject({ status: 'error', messageId: partial.id });
  });

  it('still logs a reply whose chat was deleted while it streamed', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const streamChat: OpenRouterClient['streamChat'] = async function* () {
      yield { type: 'delta', text: 'Hel' };
      await gate;
      yield { type: 'usage', usage: USAGE };
    };
    const { call, db } = makeApp({ streamChat });
    const chatId = await newChat(call);
    const pending = (async () => readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: 'Q', modelId: 'm/x' })))();
    await new Promise((r) => setTimeout(r, 20));
    await call('DELETE', `/api/chats/${chatId}`);
    release();
    await pending;
    expect(rows(db).filter((r) => r.purpose === 'reply')).toEqual([expect.objectContaining({ chatId, messageId: null, cost: 0.0004 })]);
  });

  it('logs nothing without an API key', async () => {
    const { streamChat } = scripted([{ chunks: ['A'] }]);
    const { call, db } = makeApp({ streamChat }, {});
    const chatId = await newChat(call);
    await readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: 'Q', modelId: 'm/x' }));
    expect(rows(db)).toEqual([]);
  });

  it('logs a failed title call as an error', async () => {
    const { streamChat } = scripted([{ chunks: ['A'] }]);
    const failing: OpenRouterClient['complete'] = async () => {
      throw new OpenRouterError('nope', 502);
    };
    const { call, db } = makeApp({ streamChat, complete: failing });
    const chatId = await newChat(call);
    await readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: 'Q', modelId: 'm/x' }));
    expect(rows(db).find((r) => r.purpose === 'title')).toMatchObject({ status: 'error', chatId, cost: null });
  });
});

describe('file generation', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);

  it('teaches the reply model the file format and names the chat images', async () => {
    const { streamChat, calls } = scripted([{ chunks: ['ok'] }]);
    const { call, upload, db } = makeApp({ streamChat });
    addModel(db, withCatalogDefaults({ id: 'v/vision', name: 'Vision', inputModalities: ['text', 'image'] }));
    const chatId = await newChat(call);
    const image = (await (await upload(PNG, 'beach.png')).json()) as Attachment;
    await readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: 'Brochure please', modelId: 'v/vision', attachmentIds: [image.id] }));
    const system = calls[0][0];
    expect(system.role).toBe('system');
    expect(system.content).toContain(FILE_INSTRUCTIONS_HEADER);
    expect(system.content).toContain('beach.png');
  });

  it('titles from the reply text, not the file body', async () => {
    const { streamChat } = scripted([{ chunks: ['Here it is:\n<file name="a.html">\n<p>SECRET BODY</p>\n</file>'] }]);
    const prompts: string[] = [];
    const complete: OpenRouterClient['complete'] = async ({ messages }) => {
      prompts.push(messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n'));
      return 'Page';
    };
    const { call } = makeApp({ streamChat, complete });
    const chatId = await newChat(call);
    await readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: 'Make a page', modelId: 'm/x' }));
    expect(prompts[0]).toContain('[file: a.html]');
    expect(prompts[0]).not.toContain('SECRET BODY');
  });
});

describe('reasoning effort', () => {
  function recording() {
    const efforts: (string | undefined)[] = [];
    const streamChat: OpenRouterClient['streamChat'] = async function* ({ effort }): AsyncGenerator<StreamEvent> {
      efforts.push(effort);
      yield { type: 'delta', text: 'ok' };
      yield { type: 'usage', usage: USAGE };
    };
    return { streamChat, efforts };
  }

  it('sends the effort to models that support reasoning, saves it on the reply, and uses the new one on regenerate', async () => {
    const { streamChat, efforts } = recording();
    const { call, db } = makeApp({ streamChat });
    addModel(db, withCatalogDefaults({ id: 'r/thinker', name: 'Thinker', supportsReasoning: true }));
    const chatId = await newChat(call);

    const sent = await readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: 'Hi', modelId: 'r/thinker', effort: 'low' }));
    expect(sent.find((e) => e.event === 'done')!.data.message.effort).toBe('low');
    const parentId = sent[0].data.userMessageId as string;
    await readEvents(await call('POST', `/api/chats/${chatId}/regenerate`, { parentId, modelId: 'r/thinker', effort: 'high' }));
    await readEvents(await call('POST', `/api/chats/${chatId}/regenerate`, { parentId, modelId: 'r/thinker' }));
    expect(efforts).toEqual(['low', 'high', undefined]);
    expect(getChatMessages(db, chatId).filter((m) => m.role === 'assistant').map((m) => m.effort)).toEqual(['low', 'high', null]);
  });

  it('leaves the effort out for models without reasoning, and refuses unknown values', async () => {
    const { streamChat, efforts } = recording();
    const { call, db } = makeApp({ streamChat });
    addModel(db, withCatalogDefaults({ id: 'p/plain', name: 'Plain', supportsReasoning: false }));
    const chatId = await newChat(call);

    const sent = await readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: 'Hi', modelId: 'p/plain', effort: 'high' }));
    expect(efforts).toEqual([undefined]);
    expect(sent.find((e) => e.event === 'done')!.data.message.effort).toBeNull();
    expect((await call('POST', `/api/chats/${chatId}/messages`, { content: 'Hi', modelId: 'p/plain', effort: 'max' })).status).toBe(400);
  });
});
