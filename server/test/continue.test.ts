import { describe, it, expect } from 'vitest';
import { makeApp, readEvents } from './appHelpers';
import { insertMessage } from '../src/messages';
import { getChatRow, setActiveLeaf } from '../src/chats';
import { SUMMARY_PROMPT, seedContent } from '../src/continue';
import { loadChatUsageRows } from '../src/usage';
import { OpenRouterError, type OpenRouterClient, type StreamEvent } from '../src/openrouter';
import type { ChatMessage } from '../src/prompt';
import type { ChatDetail, ChatSummary } from '../../shared/types';

const f = (name: string, body: string) => `<file name="${name}">\n${body}\n</file>`;
const USAGE = { promptTokens: 900, completionTokens: 80, cost: 0.002, webSearches: null, cachedTokens: 800, cacheWriteTokens: 0, reasoningTokens: null };

/** A chat with two versions of a.html, one b.csv, and an unfinished c.txt. */
async function seededChat(ctx: ReturnType<typeof makeApp>, files = true) {
  const chat = (await (await ctx.call('POST', '/api/chats', { instructions: 'Use French.' })).json()) as ChatSummary;
  const u1 = insertMessage(ctx.db, { chatId: chat.id, parentId: null, role: 'user', content: 'Make a page' });
  const a1 = insertMessage(ctx.db, { chatId: chat.id, parentId: u1.id, role: 'assistant', content: files ? `Here.\n${f('a.html', 'v1')}\n${f('b.csv', 'x,y')}` : 'Sure.', modelId: 'm/x' });
  const u2 = insertMessage(ctx.db, { chatId: chat.id, parentId: a1.id, role: 'user', content: 'Make it blue' });
  const a2 = insertMessage(ctx.db, { chatId: chat.id, parentId: u2.id, role: 'assistant', content: files ? `Done.\n${f('a.html', 'v2')}\n<file name="c.txt">\nhalf` : 'Blue.', modelId: 'm/x' });
  setActiveLeaf(ctx.db, chat.id, a2.id);
  return chat;
}

function summarizer(reply: string | Error = 'We built a page and made it blue.') {
  const calls: { model: string; messages: ChatMessage[] }[] = [];
  const complete: OpenRouterClient['complete'] = async ({ model, messages, onUsage }) => {
    calls.push({ model, messages });
    if (reply instanceof Error) throw reply;
    onUsage?.(USAGE);
    return reply;
  };
  return { complete, calls };
}

const detailOf = async (call: ReturnType<typeof makeApp>['call'], id: string) => (await (await call('GET', `/api/chats/${id}`)).json()) as ChatDetail;

describe('seedContent', () => {
  it('keeps the latest complete version of each file, in first-appearance order', () => {
    const path = [
      { role: 'assistant' as const, content: `${f('a.html', 'v1')}\n${f('b.csv', 'x')}` },
      { role: 'user' as const, content: f('fake.txt', 'user files are not generated') },
      { role: 'assistant' as const, content: `${f('a.html', 'v2')}\n<file name="c.txt">\nhalf` },
    ];
    expect(seedContent(path)).toBe(`Files from the previous chat:\n\n${f('a.html', 'v2')}\n\n${f('b.csv', 'x')}`);
    expect(seedContent([{ role: 'assistant', content: 'no files' }])).toBeNull();
  });
});

describe('POST /api/chats/:id/continue', () => {
  it('summarizes, then opens a new chat with the note, seed files and instructions', async () => {
    const { complete, calls } = summarizer('  We built a page and made it blue.  ');
    const ctx = makeApp({ complete });
    const old = await seededChat(ctx);

    const res = await ctx.call('POST', `/api/chats/${old.id}/continue`, { modelId: 'anthropic/claude-haiku-4.5' });
    expect(res.status).toBe(201);
    const created = (await res.json()) as ChatSummary;

    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe('anthropic/claude-haiku-4.5');
    const sent = calls[0].messages;
    expect(sent[0].role).toBe('system');
    expect(JSON.stringify(sent[0].content)).toContain('Instructions for this chat:\\nUse French.');
    expect(sent.at(-1)).toEqual({ role: 'user', content: [{ type: 'text', text: SUMMARY_PROMPT, cache_control: { type: 'ephemeral' } }] });

    const detail = await detailOf(ctx.call, created.id);
    expect(detail.chat).toMatchObject({
      title: 'New chat (continued)', instructions: 'Use French.', contextNote: 'We built a page and made it blue.',
      continuedFrom: { id: old.id, title: 'New chat' },
    });
    expect(detail.messages).toHaveLength(1);
    expect(detail.messages[0]).toMatchObject({ role: 'assistant', parentId: null, modelId: null });
    expect(detail.messages[0].content).toBe(`Files from the previous chat:\n\n${f('a.html', 'v2')}\n\n${f('b.csv', 'x,y')}`);
    expect(detail.chat.activeLeafId).toBe(detail.messages[0].id);

    // The old chat is untouched, and the summary is logged (and paid for) under it.
    expect((await detailOf(ctx.call, old.id)).messages).toHaveLength(4);
    const rows = loadChatUsageRows(ctx.db, old.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ purpose: 'summary', modelId: 'anthropic/claude-haiku-4.5', cost: 0.002, cachedTokens: 800, status: 'complete' });
  });

  it('treats an unanswered last message as an open question instead of sending it to be answered', async () => {
    const { complete, calls } = summarizer();
    const ctx = makeApp({ complete });
    const old = await seededChat(ctx, false);
    const leaf = getChatRow(ctx.db, old.id)!.active_leaf_id!;
    const u3 = insertMessage(ctx.db, { chatId: old.id, parentId: leaf, role: 'user', content: 'Which font should we use?' });
    setActiveLeaf(ctx.db, old.id, u3.id);

    expect((await ctx.call('POST', `/api/chats/${old.id}/continue`, { modelId: 'm/x' })).status).toBe(201);
    const sent = calls[0].messages;
    expect(sent.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user', 'assistant', 'user']);
    expect(sent.at(-1)!.content).toBe(`${SUMMARY_PROMPT}\n\nThe user's last message never got a reply; include it as an open question:\n\nWhich font should we use?`);
  });

  it('continues without a seed when no files were made', async () => {
    const { complete } = summarizer();
    const ctx = makeApp({ complete });
    const old = await seededChat(ctx, false);
    const created = (await (await ctx.call('POST', `/api/chats/${old.id}/continue`, { modelId: 'm/x' })).json()) as ChatSummary;
    const detail = await detailOf(ctx.call, created.id);
    expect(detail.messages).toEqual([]);
    expect(detail.chat.activeLeafId).toBeNull();
    expect(detail.chat.contextNote).toBe('We built a page and made it blue.');
  });

  it('creates nothing when the summary call fails', async () => {
    const { complete } = summarizer(new OpenRouterError('Your OpenRouter account is out of credits.', 402));
    const ctx = makeApp({ complete });
    const old = await seededChat(ctx);
    const res = await ctx.call('POST', `/api/chats/${old.id}/continue`, { modelId: 'm/x' });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain('out of credits');
    expect((await (await ctx.call('GET', '/api/chats')).json()) as ChatSummary[]).toHaveLength(1);
    expect(loadChatUsageRows(ctx.db, old.id)[0]).toMatchObject({ purpose: 'summary', status: 'error' });
  });

  it('refuses an empty summary, an empty chat and a missing model', async () => {
    const ctx = makeApp(summarizer('   '));
    const old = await seededChat(ctx);
    expect((await ctx.call('POST', `/api/chats/${old.id}/continue`, { modelId: 'm/x' })).status).toBe(502);
    expect((await ctx.call('POST', `/api/chats/${old.id}/continue`, {})).status).toBe(400);
    const empty = (await (await ctx.call('POST', '/api/chats')).json()) as ChatSummary;
    expect((await ctx.call('POST', `/api/chats/${empty.id}/continue`, { modelId: 'm/x' })).status).toBe(400);
    expect((await (await ctx.call('GET', '/api/chats')).json()) as ChatSummary[]).toHaveLength(2);
  });

  it('locks the note once the chat has a user message', async () => {
    const streamChat: OpenRouterClient['streamChat'] = async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'delta', text: 'ok' };
    };
    const ctx = makeApp({ ...summarizer(), streamChat });
    const old = await seededChat(ctx);
    const created = (await (await ctx.call('POST', `/api/chats/${old.id}/continue`, { modelId: 'm/x' })).json()) as ChatSummary;

    const edited = (await (await ctx.call('PATCH', `/api/chats/${created.id}`, { contextNote: ' Edited note. ' })).json()) as ChatDetail;
    expect(edited.chat.contextNote).toBe('Edited note.');
    // Only continued chats have a note.
    expect((await ctx.call('PATCH', `/api/chats/${old.id}`, { contextNote: 'x' })).status).toBe(400);

    await readEvents(await ctx.call('POST', `/api/chats/${created.id}/messages`, { content: 'Next', modelId: 'm/x' }));
    expect((await ctx.call('PATCH', `/api/chats/${created.id}`, { contextNote: 'Too late' })).status).toBe(409);
  });

  it('sends the note before the seed on the first reply', async () => {
    const prompts: ChatMessage[][] = [];
    const streamChat: OpenRouterClient['streamChat'] = async function* ({ messages }): AsyncGenerator<StreamEvent> {
      prompts.push(messages);
      yield { type: 'delta', text: 'ok' };
    };
    const ctx = makeApp({ ...summarizer(), streamChat });
    const old = await seededChat(ctx);
    const created = (await (await ctx.call('POST', `/api/chats/${old.id}/continue`, { modelId: 'm/x' })).json()) as ChatSummary;
    await readEvents(await ctx.call('POST', `/api/chats/${created.id}/messages`, { content: 'Next', modelId: 'm/x' }));
    const sent = prompts[0];
    expect(sent.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(sent[1].content).toBe('Context from a previous chat:\n\nWe built a page and made it blue.');
    expect(sent[2].content).toContain(f('a.html', 'v2'));
    expect(sent[3].content).toBe('Next');
  });

  it("counts the note in the new chat's context", async () => {
    const ctx = makeApp(summarizer('word '.repeat(400)));
    const old = await seededChat(ctx, false);
    const created = (await (await ctx.call('POST', `/api/chats/${old.id}/continue`, { modelId: 'm/x' })).json()) as ChatSummary;
    const u = (await (await ctx.call('GET', `/api/context?model=m%2Fx&chat=${created.id}`)).json()) as { parts: { user: number } };
    expect(u.parts.user).toBeGreaterThan(450);
  });
});
