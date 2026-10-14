import { describe, it, expect } from 'vitest';
import { openDb, now } from '../src/db';
import { insertMessage, getChatMessages, getMessage } from '../src/messages';
import { createChat, listChats, deleteChat, getChatRow, touchChat, DEFAULT_TITLE } from '../src/chats';

const ftsCount = (db: ReturnType<typeof openDb>, q: string) =>
  (db.prepare('SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH ?').get(q) as { n: number }).n;

describe('database', () => {
  it('now() is strictly increasing', () => {
    let prev = now();
    for (let i = 0; i < 1000; i++) {
      const t = now();
      expect(t).toBeGreaterThan(prev);
      prev = t;
    }
  });

  it('creates chats with the default title', () => {
    const db = openDb(':memory:');
    const chat = createChat(db);
    expect(chat.title).toBe(DEFAULT_TITLE);
    expect(getChatRow(db, chat.id)?.active_leaf_id).toBeNull();
  });

  it('inserts and reads messages oldest first', () => {
    const db = openDb(':memory:');
    const chat = createChat(db);
    const u = insertMessage(db, { chatId: chat.id, parentId: null, role: 'user', content: 'hi' });
    const a = insertMessage(db, {
      chatId: chat.id, parentId: u.id, role: 'assistant', content: 'hello',
      modelId: 'openai/gpt-4o', promptTokens: 3, completionTokens: 2, cost: 0.001,
    });
    expect(getChatMessages(db, chat.id).map((m) => m.id)).toEqual([u.id, a.id]);
    expect(getMessage(db, a.id)).toMatchObject({ role: 'assistant', modelId: 'openai/gpt-4o', cost: 0.001, status: 'complete' });
  });

  it('indexes message content for full-text search', () => {
    const db = openDb(':memory:');
    const chat = createChat(db);
    insertMessage(db, { chatId: chat.id, parentId: null, role: 'user', content: 'I like bananas' });
    expect(ftsCount(db, 'bananas')).toBe(1);
  });

  it('deleting a chat removes its messages and their search index entries', () => {
    const db = openDb(':memory:');
    const chat = createChat(db);
    const u = insertMessage(db, { chatId: chat.id, parentId: null, role: 'user', content: 'bananas' });
    insertMessage(db, { chatId: chat.id, parentId: u.id, role: 'assistant', content: 'more bananas' });
    deleteChat(db, chat.id);
    expect(getChatMessages(db, chat.id)).toEqual([]);
    expect(ftsCount(db, 'bananas')).toBe(0);
  });

  it('lists chats newest first with total cost across all branches', () => {
    const db = openDb(':memory:');
    const older = createChat(db);
    const newer = createChat(db);
    const u = insertMessage(db, { chatId: older.id, parentId: null, role: 'user', content: 'q' });
    insertMessage(db, { chatId: older.id, parentId: u.id, role: 'assistant', content: 'a', cost: 0.25 });
    insertMessage(db, { chatId: older.id, parentId: u.id, role: 'assistant', content: 'b', cost: 0.5 });
    touchChat(db, newer.id);
    const list = listChats(db);
    expect(list.map((c) => c.id)).toEqual([newer.id, older.id]);
    expect(list[1].totalCost).toBeCloseTo(0.75);
    expect(list[0].totalCost).toBe(0);
  });
});
