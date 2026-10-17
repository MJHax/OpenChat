import { describe, it, expect } from 'vitest';
import { makeApp } from './appHelpers';
import { insertMessage } from '../src/messages';
import { setActiveLeaf } from '../src/chats';
import { toFtsQuery } from '../src/search';
import { logReply } from './usageHelpers';
import type { ChatDetail, ChatSummary, SearchHit } from '../../shared/types';

async function seed() {
  const ctx = makeApp();
  const chat = (await (await ctx.call('POST', '/api/chats')).json()) as ChatSummary;
  const u1 = insertMessage(ctx.db, { chatId: chat.id, parentId: null, role: 'user', content: 'Tell me about bananas' });
  const a1 = insertMessage(ctx.db, { chatId: chat.id, parentId: u1.id, role: 'assistant', content: 'Bananas are berries.', modelId: 'm/a', cost: 0.001 });
  const a2 = insertMessage(ctx.db, { chatId: chat.id, parentId: u1.id, role: 'assistant', content: 'Bananas grow in clusters.', modelId: 'm/b', cost: 0.002 });
  const u2 = insertMessage(ctx.db, { chatId: chat.id, parentId: a1.id, role: 'user', content: 'More please' });
  logReply(ctx.db, { chatId: chat.id, messageId: a1.id, cost: 0.001 });
  logReply(ctx.db, { chatId: chat.id, messageId: a2.id, cost: 0.002 });
  setActiveLeaf(ctx.db, chat.id, a2.id);
  return { ...ctx, chat, u1, a1, a2, u2 };
}

describe('chat routes', () => {
  it('lists chats with total cost', async () => {
    const { call, chat } = await seed();
    const list = (await (await call('GET', '/api/chats')).json()) as ChatSummary[];
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(chat.id);
    expect(list[0].totalCost).toBeCloseTo(0.003);
  });

  it('returns the active path with sibling info', async () => {
    const { call, chat, u1, a1, a2 } = await seed();
    const detail = (await (await call('GET', `/api/chats/${chat.id}`)).json()) as ChatDetail;
    expect(detail.messages.map((m) => m.id)).toEqual([u1.id, a2.id]);
    expect(detail.messages[1]).toMatchObject({ siblingIds: [a1.id, a2.id], siblingIndex: 1 });
    expect(detail.chat.activeLeafId).toBe(a2.id);
  });

  it('selecting a sibling descends to its newest leaf', async () => {
    const { call, chat, u1, a1, u2 } = await seed();
    const detail = (await (await call('PATCH', `/api/chats/${chat.id}`, { selectMessageId: a1.id })).json()) as ChatDetail;
    expect(detail.messages.map((m) => m.id)).toEqual([u1.id, a1.id, u2.id]);
  });

  it('rejects selecting a message from another chat', async () => {
    const { call, chat, db } = await seed();
    const other = (await (await call('POST', '/api/chats')).json()) as ChatSummary;
    const foreign = insertMessage(db, { chatId: other.id, parentId: null, role: 'user', content: 'x' });
    expect((await call('PATCH', `/api/chats/${chat.id}`, { selectMessageId: foreign.id })).status).toBe(400);
  });

  it('renames chats and rejects empty titles', async () => {
    const { call, chat } = await seed();
    const detail = (await (await call('PATCH', `/api/chats/${chat.id}`, { title: '  Fruit  ' })).json()) as ChatDetail;
    expect(detail.chat.title).toBe('Fruit');
    expect((await call('PATCH', `/api/chats/${chat.id}`, { title: '   ' })).status).toBe(400);
  });

  it('deletes chats', async () => {
    const { call, chat } = await seed();
    expect((await call('DELETE', `/api/chats/${chat.id}`)).status).toBe(200);
    expect((await call('GET', `/api/chats/${chat.id}`)).status).toBe(404);
    expect(await (await call('GET', '/api/search?q=bananas')).json()).toEqual([]);
  });

  it('returns 404 for unknown chats', async () => {
    const { call } = makeApp();
    expect((await call('GET', '/api/chats/nope')).status).toBe(404);
  });
});

describe('search', () => {
  it('finds messages by word prefix with highlighted snippets', async () => {
    const { call, chat } = await seed();
    const hits = (await (await call('GET', '/api/search?q=bana')).json()) as SearchHit[];
    expect(hits.length).toBe(3);
    expect(hits[0]).toMatchObject({ chatId: chat.id, chatTitle: 'New chat' });
    expect(hits[0].snippet).toContain('«');
  });

  it('returns [] for an empty query', async () => {
    const { call } = await seed();
    expect(await (await call('GET', '/api/search?q=')).json()).toEqual([]);
    expect(await (await call('GET', '/api/search')).json()).toEqual([]);
  });

  it('search never errors on FTS syntax characters', async () => {
    const { call } = await seed();
    for (const q of ['"', '*', 'bananas AND (', '-x', 'c++', 'NEAR(', '"unterminated', '^', ':']) {
      const res = await call('GET', `/api/search?q=${encodeURIComponent(q)}`);
      expect(res.status, q).toBe(200);
    }
  });

  it('builds safe prefix queries', () => {
    expect(toFtsQuery('  ')).toBeNull();
    expect(toFtsQuery('*"()')).toBeNull();
    expect(toFtsQuery('c++ AND bananas')).toBe('"c"* "AND"* "bananas"*');
  });
});
