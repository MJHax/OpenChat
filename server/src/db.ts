import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  context_length INTEGER,
  prompt_price REAL,
  completion_price REAL,
  added_at INTEGER NOT NULL,
  input_modalities TEXT,
  supports_tools INTEGER
);

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  active_leaf_id TEXT,
  compare_parent_id TEXT,
  kind TEXT NOT NULL DEFAULT 'chat',
  instructions TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  model_id TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  cost REAL,
  status TEXT NOT NULL DEFAULT 'complete',
  created_at INTEGER NOT NULL,
  web_search INTEGER NOT NULL DEFAULT 0,
  sources TEXT,
  web_searches INTEGER
);
CREATE INDEX IF NOT EXISTS messages_chat ON messages(chat_id, created_at);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, content='messages', content_rowid='seq');
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.seq, new.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.seq, old.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF content ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.seq, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.seq, new.content);
END;

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'pdf', 'text')),
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  data BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS attachments_message ON attachments(message_id, position);

-- One row per OpenRouter generation call. Never deleted; chat_id deliberately has no foreign key.
CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('reply', 'title', 'memory')),
  chat_id TEXT,
  message_id TEXT,
  run_id TEXT,
  kind TEXT CHECK (kind IN ('send', 'edit', 'regenerate')),
  compare INTEGER NOT NULL DEFAULT 0,
  model_id TEXT NOT NULL,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  cached_tokens INTEGER,
  cache_write_tokens INTEGER,
  reasoning_tokens INTEGER,
  cost REAL,
  cache_savings REAL,
  web_search INTEGER NOT NULL DEFAULT 0,
  web_searches INTEGER,
  attachments INTEGER NOT NULL DEFAULT 0,
  first_token_ms INTEGER,
  duration_ms INTEGER,
  status TEXT NOT NULL CHECK (status IN ('complete', 'stopped', 'error')),
  backfilled INTEGER NOT NULL DEFAULT 0,
  -- Which kind of thread the call belonged to ('chat', 'image', 'video'), so title calls count under the right stats.
  thread_kind TEXT NOT NULL DEFAULT 'chat'
);
CREATE INDEX IF NOT EXISTS usage_events_time ON usage_events(created_at);
CREATE INDEX IF NOT EXISTS usage_events_chat ON usage_events(chat_id);
CREATE INDEX IF NOT EXISTS usage_events_model ON usage_events(model_id);

CREATE TABLE IF NOT EXISTS model_catalog_cache (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  fetched_at INTEGER NOT NULL,
  json TEXT NOT NULL
);

-- Image and video models the user added; separate from chat models, and one id may be in both kinds.
CREATE TABLE IF NOT EXISTS media_models (
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'video')),
  display_name TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (id, kind)
);

CREATE TABLE IF NOT EXISTS media_catalog_cache (
  kind TEXT PRIMARY KEY,
  fetched_at INTEGER NOT NULL,
  json TEXT NOT NULL
);

-- The request behind each generated image or video (one per assistant message in an image or video thread).
CREATE TABLE IF NOT EXISTS media_generations (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  model_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  settings TEXT NOT NULL,
  target_attachment_id TEXT,
  reference_ids TEXT NOT NULL DEFAULT '[]',
  mode TEXT NOT NULL,
  job_id TEXT,
  error TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);

-- One row per paid image or video call. Never deleted; no foreign keys, like usage_events.
CREATE TABLE IF NOT EXISTS media_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  thread_id TEXT,
  message_id TEXT,
  model_id TEXT NOT NULL,
  mode TEXT,
  settings TEXT NOT NULL,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  cost REAL,
  cost_estimated INTEGER NOT NULL DEFAULT 0,
  seconds REAL,
  duration_ms INTEGER,
  status TEXT NOT NULL CHECK (status IN ('complete', 'error'))
);
-- Video jobs running on OpenRouter. No foreign keys: a job is paid for even if its thread is deleted, so it is polled to the end.
CREATE TABLE IF NOT EXISTS video_jobs (
  job_id TEXT PRIMARY KEY,
  thread_id TEXT,
  message_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  settings TEXT NOT NULL,
  photos INTEGER NOT NULL DEFAULT 0,
  polling_url TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  next_poll_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS media_events_time ON media_events(created_at);
CREATE INDEX IF NOT EXISTS media_events_thread ON media_events(thread_id);
`;

export function openDb(file: string): DB {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Brings databases created by older versions up to the current schema. */
function migrate(db: DB): void {
  const chatColumns = (db.prepare('PRAGMA table_info(chats)').all() as { name: string }[]).map((c) => c.name);
  if (!chatColumns.includes('compare_parent_id')) db.exec('ALTER TABLE chats ADD COLUMN compare_parent_id TEXT');
  if (!chatColumns.includes('kind')) db.exec("ALTER TABLE chats ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat'");
  if (!chatColumns.includes('instructions')) db.exec("ALTER TABLE chats ADD COLUMN instructions TEXT NOT NULL DEFAULT ''");
  const usageColumns = (db.prepare('PRAGMA table_info(usage_events)').all() as { name: string }[]).map((c) => c.name);
  if (!usageColumns.includes('thread_kind')) db.exec("ALTER TABLE usage_events ADD COLUMN thread_kind TEXT NOT NULL DEFAULT 'chat'");
  const modelColumns = (db.prepare('PRAGMA table_info(models)').all() as { name: string }[]).map((c) => c.name);
  if (!modelColumns.includes('input_modalities')) db.exec('ALTER TABLE models ADD COLUMN input_modalities TEXT');
  if (!modelColumns.includes('supports_tools')) db.exec('ALTER TABLE models ADD COLUMN supports_tools INTEGER');
  const messageColumns = (db.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).map((c) => c.name);
  if (!messageColumns.includes('web_search')) db.exec('ALTER TABLE messages ADD COLUMN web_search INTEGER NOT NULL DEFAULT 0');
  if (!messageColumns.includes('sources')) db.exec('ALTER TABLE messages ADD COLUMN sources TEXT');
  if (!messageColumns.includes('web_searches')) db.exec('ALTER TABLE messages ADD COLUMN web_searches INTEGER');
  backfillUsage(db);
}

/**
 * Copies replies saved before the usage log existed into it, once. Each becomes its own run; what old rows
 * never recorded (kind, cache, reasoning, timing) stays null.
 */
function backfillUsage(db: DB): void {
  if (db.prepare("SELECT 1 FROM settings WHERE key = 'usage_backfill_done'").get()) return;
  db.transaction(() => {
    db.prepare(
      `INSERT INTO usage_events (created_at, purpose, chat_id, message_id, run_id, model_id, prompt_tokens, completion_tokens,
         cost, web_search, web_searches, status, backfilled)
       SELECT m.created_at, 'reply', m.chat_id, m.id, lower(hex(randomblob(16))), COALESCE(m.model_id, ''), m.prompt_tokens,
         m.completion_tokens, m.cost, COALESCE(p.web_search, 0), m.web_searches, m.status, 1
       FROM messages m LEFT JOIN messages p ON p.id = m.parent_id
       WHERE m.role = 'assistant'
       ORDER BY m.seq`,
    ).run();
    db.prepare("INSERT INTO settings (key, value) VALUES ('usage_backfill_done', '1')").run();
  })();
}

export const newId = (): string => randomUUID();

let last = 0;
/** Millisecond timestamp, strictly increasing within this process so ordering never ties. */
export function now(): number {
  const t = Date.now();
  last = t > last ? t : last + 1;
  return last;
}
