import { describe, it, expect } from 'vitest';
import { openDb, now, SCHEMA_VERSION } from '../src/db';
import { hashBytes, insertPending } from '../src/attachments';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { insertMessage, getChatMessages, getMessage } from '../src/messages';
import { createChat, listChats, deleteChat, getChatRow, touchChat, DEFAULT_TITLE } from '../src/chats';
import { logReply } from './usageHelpers';

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
    const a = insertMessage(db, { chatId: older.id, parentId: u.id, role: 'assistant', content: 'a', cost: 0.25 });
    const b = insertMessage(db, { chatId: older.id, parentId: u.id, role: 'assistant', content: 'b', cost: 0.5 });
    logReply(db, { chatId: older.id, messageId: a.id, cost: 0.25 });
    logReply(db, { chatId: older.id, messageId: b.id, cost: 0.5 });
    touchChat(db, newer.id);
    const list = listChats(db);
    expect(list.map((c) => c.id)).toEqual([newer.id, older.id]);
    expect(list[1].totalCost).toBeCloseTo(0.75);
    expect(list[0].totalCost).toBe(0);
  });

  it('adds input_modalities to an old models table', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'openchat-')), 'old.db');
    const old = new Database(file);
    old.exec('CREATE TABLE models (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, context_length INTEGER, prompt_price REAL, completion_price REAL, added_at INTEGER NOT NULL)');
    old.close();
    const db = openDb(file);
    const cols = (db.prepare('PRAGMA table_info(models)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('input_modalities');
    db.close();
  });

  it('messages include their attachments in order', () => {
    const db = openDb(':memory:');
    const chat = createChat(db);
    const u = insertMessage(db, { chatId: chat.id, parentId: null, role: 'user', content: 'see files' });
    const a = insertMessage(db, { chatId: chat.id, parentId: u.id, role: 'assistant', content: 'ok' });
    const add = (name: string, position: number) => {
      const att = insertPending(db, { filename: name, kind: 'text', mime: 'text/plain', data: new TextEncoder().encode(name) });
      db.prepare('UPDATE attachments SET message_id = ?, position = ? WHERE id = ?').run(u.id, position, att.id);
    };
    add('second.txt', 1);
    add('first.txt', 0);
    const [user, reply] = getChatMessages(db, chat.id);
    expect(user.attachments.map((x) => x.filename)).toEqual(['first.txt', 'second.txt']);
    expect(user.attachments[0]).not.toHaveProperty('data');
    expect(reply.attachments).toEqual([]);
    expect(getMessage(db, u.id)?.attachments.map((x) => x.filename)).toEqual(['first.txt', 'second.txt']);
    expect(getMessage(db, a.id)?.attachments).toEqual([]);
  });
});

describe('image and video storage', () => {
  it('creates media tables', () => {
    const db = openDb(':memory:');
    const chat = createChat(db);
    const m = insertMessage(db, { chatId: chat.id, parentId: null, role: 'assistant', content: '' });
    db.prepare("INSERT INTO media_models (id, kind, display_name, added_at) VALUES ('x/img', 'image', 'Img', 1)").run();
    db.prepare("INSERT INTO media_models (id, kind, display_name, added_at) VALUES ('x/img', 'video', 'Img', 1)").run();
    db.prepare("INSERT INTO media_catalog_cache (kind, fetched_at, json) VALUES ('image', 1, '[]')").run();
    db.prepare("INSERT INTO media_generations (message_id, kind, model_id, prompt, settings, mode, started_at) VALUES (?, 'image', 'x/img', 'p', '{}', 'new', 1)").run(m.id);
    db.prepare("INSERT INTO media_events (created_at, kind, thread_id, message_id, model_id, settings, status) VALUES (1, 'image', ?, ?, 'x/img', '{}', 'complete')").run(chat.id, m.id);
    deleteChat(db, chat.id);
    expect((db.prepare('SELECT count(*) AS n FROM media_generations').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT count(*) AS n FROM media_events').get() as { n: number }).n).toBe(1);
    expect(getChatRow(db, createChat(db).id)).toMatchObject({ kind: 'chat' });
  });

  it('migrates existing rows', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'openchat-')), 'old.db');
    const old = new Database(file);
    old.exec(`
      CREATE TABLE chats (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, active_leaf_id TEXT);
      CREATE TABLE usage_events (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, purpose TEXT NOT NULL, chat_id TEXT,
        message_id TEXT, run_id TEXT, kind TEXT, compare INTEGER NOT NULL DEFAULT 0, model_id TEXT NOT NULL, prompt_tokens INTEGER,
        completion_tokens INTEGER, cached_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER, cost REAL, cache_savings REAL,
        web_search INTEGER NOT NULL DEFAULT 0, web_searches INTEGER, attachments INTEGER NOT NULL DEFAULT 0, first_token_ms INTEGER,
        duration_ms INTEGER, status TEXT NOT NULL, backfilled INTEGER NOT NULL DEFAULT 0);
      INSERT INTO chats VALUES ('c1', 'Old', 1, 1, NULL);
      INSERT INTO usage_events (created_at, purpose, chat_id, model_id, status) VALUES (1, 'reply', 'c1', 'm/x', 'complete');
    `);
    old.close();
    const db = openDb(file);
    expect(db.prepare("SELECT kind FROM chats WHERE id = 'c1'").get()).toEqual({ kind: 'chat' });
    expect(db.prepare('SELECT thread_kind FROM usage_events').get()).toEqual({ thread_kind: 'chat' });
    db.close();
  });

  it('backfills hashes for attachments written before the column existed', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'openchat-')), 'old.db');
    const db = openDb(file);
    const data = new TextEncoder().encode('hello');
    const a = insertPending(db, { filename: 'a.txt', kind: 'text', mime: 'text/plain', data });
    db.prepare('UPDATE attachments SET hash = NULL').run();
    db.close();
    const again = openDb(file);
    expect(again.prepare('SELECT hash FROM attachments WHERE id = ?').get(a.id)).toEqual({ hash: hashBytes(data) });
    again.close();
  });
});

describe('summary usage rows', () => {
  it('migrates usage_events to allow summary rows, keeping old rows', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'openchat-')), 'old.db');
    const old = new Database(file);
    old.exec(`
      CREATE TABLE usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL,
        purpose TEXT NOT NULL CHECK (purpose IN ('reply', 'title', 'memory')),
        chat_id TEXT, message_id TEXT, run_id TEXT, kind TEXT, compare INTEGER NOT NULL DEFAULT 0, model_id TEXT NOT NULL,
        prompt_tokens INTEGER, completion_tokens INTEGER, cached_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER,
        cost REAL, cache_savings REAL, web_search INTEGER NOT NULL DEFAULT 0, web_searches INTEGER, attachments INTEGER NOT NULL DEFAULT 0,
        first_token_ms INTEGER, duration_ms INTEGER, status TEXT NOT NULL CHECK (status IN ('complete', 'stopped', 'error')),
        backfilled INTEGER NOT NULL DEFAULT 0, thread_kind TEXT NOT NULL DEFAULT 'chat');
      CREATE INDEX usage_events_time ON usage_events(created_at);
      INSERT INTO usage_events (created_at, purpose, chat_id, model_id, cost, status) VALUES (5, 'title', 'c1', 'm/x', 0.25, 'complete');
    `);
    old.close();
    const db = openDb(file);
    db.prepare("INSERT INTO usage_events (created_at, purpose, model_id, status) VALUES (6, 'summary', 'm/x', 'complete')").run();
    expect(db.prepare('SELECT purpose, cost FROM usage_events ORDER BY id').all()).toEqual([
      { purpose: 'title', cost: 0.25 }, { purpose: 'summary', cost: null },
    ]);
    expect(() => db.prepare("INSERT INTO usage_events (created_at, purpose, model_id, status) VALUES (7, 'other', 'm/x', 'complete')").run()).toThrow();
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'usage_events'").all() as { name: string }[]).map((r) => r.name);
    expect(indexes).toEqual(expect.arrayContaining(['usage_events_time', 'usage_events_chat', 'usage_events_model']));
    db.close();
    // Opening again leaves it alone.
    const again = openDb(file);
    expect((again.prepare('SELECT count(*) AS n FROM usage_events').get() as { n: number }).n).toBe(2);
    again.close();
  });
});

describe('web search storage', () => {
  it('stores the search flag and sources on messages', () => {
    const db = openDb(':memory:');
    const chat = createChat(db);
    const u = insertMessage(db, { chatId: chat.id, parentId: null, role: 'user', content: 'news?', webSearch: true });
    const a = insertMessage(db, {
      chatId: chat.id, parentId: u.id, role: 'assistant', content: 'ok',
      sources: [{ url: 'https://a.example', title: 'A' }], webSearches: 2,
    });
    const plain = insertMessage(db, { chatId: chat.id, parentId: a.id, role: 'user', content: 'thanks' });
    const [user, reply, last] = getChatMessages(db, chat.id);
    expect(user.webSearch).toBe(true);
    expect(reply).toMatchObject({ webSearch: false, sources: [{ url: 'https://a.example', title: 'A' }], webSearches: 2 });
    expect(last).toMatchObject({ webSearch: false, sources: [], webSearches: null });
    expect(getMessage(db, a.id)?.sources).toEqual([{ url: 'https://a.example', title: 'A' }]);
    expect(getMessage(db, plain.id)?.sources).toEqual([]);
  });

  it('adds the web search columns to old databases', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'openchat-')), 'old.db');
    const old = new Database(file);
    old.exec(`
      CREATE TABLE models (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, context_length INTEGER, prompt_price REAL, completion_price REAL, added_at INTEGER NOT NULL);
      CREATE TABLE chats (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, active_leaf_id TEXT);
      CREATE TABLE messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, chat_id TEXT NOT NULL, parent_id TEXT,
        role TEXT NOT NULL, content TEXT NOT NULL, model_id TEXT, prompt_tokens INTEGER, completion_tokens INTEGER, cost REAL,
        status TEXT NOT NULL DEFAULT 'complete', created_at INTEGER NOT NULL);
      INSERT INTO chats VALUES ('c1', 'Old', 1, 1, 'm1');
      INSERT INTO messages (id, chat_id, parent_id, role, content, created_at) VALUES ('m1', 'c1', NULL, 'user', 'hi', 1);
    `);
    old.close();
    const db = openDb(file);
    const cols = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols('messages')).toEqual(expect.arrayContaining(['web_search', 'sources', 'web_searches']));
    expect(cols('models')).toContain('supports_tools');
    expect(getMessage(db, 'm1')).toMatchObject({ webSearch: false, sources: [], webSearches: null });
    db.close();
  });

  it('adds the timing columns to old databases, and old messages read timing: null', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'openchat-')), 'old.db');
    const old = new Database(file);
    old.exec(`
      CREATE TABLE chats (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, active_leaf_id TEXT);
      CREATE TABLE messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, chat_id TEXT NOT NULL, parent_id TEXT,
        role TEXT NOT NULL, content TEXT NOT NULL, model_id TEXT, prompt_tokens INTEGER, completion_tokens INTEGER, cost REAL,
        status TEXT NOT NULL DEFAULT 'complete', created_at INTEGER NOT NULL);
      INSERT INTO chats VALUES ('c1', 'Old', 1, 1, 'm1');
      INSERT INTO messages (id, chat_id, parent_id, role, content, completion_tokens, created_at) VALUES ('m1', 'c1', NULL, 'assistant', 'hi', 20, 1);
    `);
    old.close();
    const db = openDb(file);
    const cols = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols('messages')).toEqual(expect.arrayContaining(['first_token_ms', 'load_ms', 'generation_ms']));
    expect(cols('usage_events')).toEqual(expect.arrayContaining(['load_ms', 'generation_ms']));
    expect(getMessage(db, 'm1')?.timing).toBeNull();
    db.close();
  });
});

describe('discussion storage', () => {
  const cols = (db: ReturnType<typeof openDb>, table: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

  it('creates discussion tables and message columns', () => {
    const db = openDb(':memory:');
    expect(cols(db, 'discussions')).toEqual(expect.arrayContaining([
      'chat_id', 'topic', 'turn_limit', 'status', 'end_reason', 'end_note', 'summary', 'summary_model_id', 'summary_cost', 'summary_at',
    ]));
    expect(cols(db, 'discussion_participants')).toEqual(expect.arrayContaining([
      'id', 'chat_id', 'position', 'name', 'model_id', 'instructions', 'is_moderator',
    ]));
    expect(cols(db, 'messages')).toEqual(expect.arrayContaining(['participant_id', 'handoff_to']));
  });

  it('adds participant columns to an old messages table', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'openchat-')), 'old.db');
    const old = new Database(file);
    old.exec(`
      CREATE TABLE chats (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, active_leaf_id TEXT);
      CREATE TABLE messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, chat_id TEXT NOT NULL, parent_id TEXT,
        role TEXT NOT NULL, content TEXT NOT NULL, model_id TEXT, prompt_tokens INTEGER, completion_tokens INTEGER, cost REAL,
        status TEXT NOT NULL DEFAULT 'complete', created_at INTEGER NOT NULL);
      INSERT INTO chats VALUES ('c1', 'Old', 1, 1, 'm1');
      INSERT INTO messages (id, chat_id, parent_id, role, content, created_at) VALUES ('m1', 'c1', NULL, 'user', 'hi', 1);
    `);
    old.close();
    const db = openDb(file);
    expect(cols(db, 'messages')).toEqual(expect.arrayContaining(['participant_id', 'handoff_to']));
    expect(getMessage(db, 'm1')).toMatchObject({ participantId: null, handoffTo: null });
    db.close();
  });

  it('deleting a discussion chat removes its discussion and participants', () => {
    const db = openDb(':memory:');
    const chat = createChat(db, 'discussion');
    db.prepare("INSERT INTO discussions (chat_id, topic, turn_limit, status) VALUES (?, 'T', 10, 'active')").run(chat.id);
    db.prepare("INSERT INTO discussion_participants (id, chat_id, position, name, model_id, instructions, is_moderator) VALUES ('p1', ?, 0, 'A', 'm', '', 0)")
      .run(chat.id);
    deleteChat(db, chat.id);
    expect(db.prepare('SELECT count(*) AS n FROM discussions').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM discussion_participants').get()).toEqual({ n: 0 });
  });
});

describe('schema version', () => {
  it('stamps the schema version', () => {
    const db = openDb(':memory:');
    expect(SCHEMA_VERSION).toBeGreaterThan(0);
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
  });
});
