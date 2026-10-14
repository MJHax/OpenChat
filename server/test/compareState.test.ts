import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeApp } from './appHelpers';
import { openDb } from '../src/db';
import { insertMessage } from '../src/messages';
import { setActiveLeaf, setCompareParent, getChatRow } from '../src/chats';
import type { ChatDetail, ChatSummary, Message } from '../../shared/types';

async function seed() {
  const ctx = makeApp();
  const chat = (await (await ctx.call('POST', '/api/chats')).json()) as ChatSummary;
  const u = insertMessage(ctx.db, { chatId: chat.id, parentId: null, role: 'user', content: 'Q' });
  const a = insertMessage(ctx.db, { chatId: chat.id, parentId: u.id, role: 'assistant', content: 'A', modelId: 'm/a' });
  const b = insertMessage(ctx.db, { chatId: chat.id, parentId: u.id, role: 'assistant', content: 'B', modelId: 'm/b' });
  setActiveLeaf(ctx.db, chat.id, u.id);
  setCompareParent(ctx.db, chat.id, u.id);
  return { ...ctx, chat, u, a, b };
}

describe('comparison state', () => {
  it('adds compare_parent_id to an existing database', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'openchat-')), 'old.db');
    const old = new Database(file);
    old.exec('CREATE TABLE chats (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, active_leaf_id TEXT)');
    old.prepare("INSERT INTO chats VALUES ('c1', 'Old chat', 1, 1, NULL)").run();
    old.close();
    const db = openDb(file);
    expect(getChatRow(db, 'c1')).toMatchObject({ title: 'Old chat', compare_parent_id: null });
    db.close();
  });

  it('chat detail lists every reply awaiting a choice', async () => {
    const { call, chat, u, a, b } = await seed();
    const detail = (await (await call('GET', `/api/chats/${chat.id}`)).json()) as ChatDetail;
    expect(detail.messages.map((m) => m.id)).toEqual([u.id]);
    expect(detail.compare).toEqual({ parentId: u.id, replies: [expect.objectContaining({ id: a.id }), expect.objectContaining({ id: b.id })] });
  });

  it('detail.compare is null when no choice is pending', async () => {
    const { call } = makeApp();
    const chat = (await (await call('POST', '/api/chats')).json()) as ChatSummary;
    expect(((await (await call('GET', `/api/chats/${chat.id}`)).json()) as ChatDetail).compare).toBeNull();
  });

  it('choosing a reply clears the pending choice', async () => {
    const { call, chat, u, b } = await seed();
    const detail = (await (await call('PATCH', `/api/chats/${chat.id}`, { selectMessageId: b.id })).json()) as ChatDetail;
    expect(detail.compare).toBeNull();
    expect(detail.messages.map((m) => m.id)).toEqual([u.id, b.id]);
  });

  it('a pending choice with no saved replies does not lock the chat', async () => {
    // e.g. the server stopped mid-comparison before any reply was saved
    const { call, db } = makeApp({ streamChat: async function* () { yield { type: 'delta', text: 'ok' }; } });
    const chat = (await (await call('POST', '/api/chats')).json()) as ChatSummary;
    const u = insertMessage(db, { chatId: chat.id, parentId: null, role: 'user', content: 'Q' });
    setActiveLeaf(db, chat.id, u.id);
    setCompareParent(db, chat.id, u.id);
    const detail = (await (await call('GET', `/api/chats/${chat.id}`)).json()) as ChatDetail;
    expect(detail.compare).toBeNull();
    expect((await call('POST', `/api/chats/${chat.id}/regenerate`, { parentId: u.id, modelId: 'm/a' })).status).toBe(200);
  });

  it('lists every version of a reply', async () => {
    const { call, chat, u, a, b } = await seed();
    const replies = (await (await call('GET', `/api/chats/${chat.id}/replies?parentId=${u.id}`)).json()) as Message[];
    expect(replies.map((m) => m.id)).toEqual([a.id, b.id]);
    expect((await call('GET', `/api/chats/${chat.id}/replies?parentId=${a.id}`)).status).toBe(400);
    expect((await call('GET', `/api/chats/${chat.id}/replies`)).status).toBe(400);
  });
});
