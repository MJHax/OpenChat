import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db';
import { createChat, deleteChat } from '../src/chats';
import { insertMessage } from '../src/messages';
import { cacheSavings, loadUsageRows, recordUsage, type UsageEventInput } from '../src/usage';

const event = (over: Partial<UsageEventInput> = {}): UsageEventInput => ({
  purpose: 'reply', chatId: null, messageId: null, runId: 'run-1', kind: 'send', compare: false, modelId: 'a/b',
  usage: { promptTokens: 100, completionTokens: 20, cost: 0.01, webSearches: 2, cachedTokens: 60, cacheWriteTokens: 0, reasoningTokens: 8, loadMs: null, generationMs: null },
  webSearch: true, webSearches: 2, attachments: 1, firstTokenMs: 400, durationMs: 2000, status: 'complete', createdAt: 1000,
  ...over,
});

function cacheCatalog(db: DB, models: object[]) {
  db.prepare('INSERT INTO model_catalog_cache (id, fetched_at, json) VALUES (1, ?, ?)').run(Date.now(), JSON.stringify({ models, rankings: {} }));
}

describe('recordUsage', () => {
  it('round-trips every field', () => {
    const db = openDb(':memory:');
    const chat = createChat(db);
    recordUsage(db, event({ chatId: chat.id, messageId: 'm-1' }));
    expect(loadUsageRows(db, null)).toEqual([expect.objectContaining({
      purpose: 'reply', chatId: chat.id, messageId: 'm-1', runId: 'run-1', kind: 'send', compare: false, modelId: 'a/b',
      promptTokens: 100, completionTokens: 20, cachedTokens: 60, cacheWriteTokens: 0, reasoningTokens: 8, cost: 0.01,
      cacheSavings: null, webSearch: true, webSearches: 2, attachments: 1, firstTokenMs: 400, durationMs: 2000,
      status: 'complete', backfilled: false, createdAt: 1000,
    })]);
  });

  it('stores null usage as nulls, never zeros', () => {
    const db = openDb(':memory:');
    recordUsage(db, event({ usage: null, purpose: 'memory', kind: null, webSearches: null, firstTokenMs: null, status: 'error' }));
    expect(loadUsageRows(db, null)[0]).toMatchObject({
      promptTokens: null, completionTokens: null, cost: null, cachedTokens: null, reasoningTokens: null, firstTokenMs: null, kind: null,
    });
  });

  it('loads rows from a start time, oldest first', () => {
    const db = openDb(':memory:');
    recordUsage(db, event({ createdAt: 3000 }));
    recordUsage(db, event({ createdAt: 1000 }));
    recordUsage(db, event({ createdAt: 2000 }));
    expect(loadUsageRows(db, 2000).map((r) => r.createdAt)).toEqual([2000, 3000]);
  });

  it('keeps a chat\'s rows when the chat is deleted', () => {
    const db = openDb(':memory:');
    const chat = createChat(db);
    recordUsage(db, event({ chatId: chat.id }));
    deleteChat(db, chat.id);
    expect(loadUsageRows(db, null)).toHaveLength(1);
  });

  it('stores the estimated cache savings', () => {
    const db = openDb(':memory:');
    cacheCatalog(db, [{ id: 'a/b', promptPrice: 3e-6, cacheReadPrice: 3e-7 }]);
    recordUsage(db, event());
    expect(loadUsageRows(db, null)[0].cacheSavings).toBeCloseTo(60 * 2.7e-6);
  });
});

describe('cacheSavings', () => {
  it('prices cached tokens at the prompt price minus the cache read price', () => {
    const db = openDb(':memory:');
    cacheCatalog(db, [{ id: 'a/b', promptPrice: 3e-6, cacheReadPrice: 3e-7 }, { id: 'a/old', promptPrice: 3e-6 }]);
    expect(cacheSavings(db, 'a/b', 1000)).toBeCloseTo(0.0027);
    expect(cacheSavings(db, 'a/b', null)).toBeNull();
    expect(cacheSavings(db, 'x/unknown', 1000)).toBeNull();
    expect(cacheSavings(db, 'a/old', 1000)).toBeNull();
  });
});

describe('usage backfill', () => {
  it('copies existing replies once, on the first open after the table appears', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'openchat-')), 'old.db');
    let db = openDb(file);
    const chat = createChat(db);
    const user = insertMessage(db, { chatId: chat.id, parentId: null, role: 'user', content: 'Hi', webSearch: true });
    const a = insertMessage(db, { chatId: chat.id, parentId: user.id, role: 'assistant', content: 'A', modelId: 'm/x', promptTokens: 5, completionTokens: 2, cost: 0.25, webSearches: 1 });
    const b = insertMessage(db, { chatId: chat.id, parentId: user.id, role: 'assistant', content: 'B', modelId: 'm/y', cost: 0.5, status: 'stopped' });
    // Make the file look like it came from a version without the usage log.
    db.exec("DROP TABLE usage_events; DELETE FROM settings WHERE key = 'usage_backfill_done'");
    db.close();

    db = openDb(file);
    const rows = loadUsageRows(db, null);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.messageId === a.id)).toMatchObject({
      purpose: 'reply', chatId: chat.id, modelId: 'm/x', promptTokens: 5, completionTokens: 2, cost: 0.25, webSearch: true,
      webSearches: 1, status: 'complete', createdAt: a.createdAt, backfilled: true, kind: null, compare: false, cachedTokens: null,
    });
    expect(rows.find((r) => r.messageId === b.id)).toMatchObject({ cost: 0.5, status: 'stopped', backfilled: true });
    expect(new Set(rows.map((r) => r.runId)).size).toBe(2);
    db.close();

    db = openDb(file);
    expect(loadUsageRows(db, null)).toHaveLength(2);
  });

  it('copies nothing into a fresh database', () => {
    expect(loadUsageRows(openDb(':memory:'), null)).toEqual([]);
  });
});
