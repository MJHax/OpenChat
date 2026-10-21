import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, now } from '../src/db';
import { addServer, updateServer, removeServer, listServers, getServer, findServer } from '../src/localServers';
import { listLibrary, modelContextLength, displayNameOf } from '../src/library';
import { getSetting, setSetting } from '../src/settings';
import { createChat } from '../src/chats';
import { insertMessage, getChatMessages } from '../src/messages';
import { HttpError } from '../src/http';

function insertLocalModel(db: ReturnType<typeof openDb>, id: string, extra: { contextWindow?: number | null; contextLength?: number | null } = {}) {
  db.prepare('INSERT INTO models (id, display_name, context_length, context_window, added_at) VALUES (?, ?, ?, ?, ?)').run(
    id, id.split(':').slice(2).join(':'), extra.contextLength ?? null, extra.contextWindow ?? null, now(),
  );
}

describe('local server storage', () => {
  it('normalizes the address and rejects a duplicate', () => {
    const db = openDb(':memory:');
    const s = addServer(db, { type: 'ollama', name: 'Ollama', baseUrl: 'localhost:11434', auto: false });
    expect(s.baseUrl).toBe('http://localhost:11434');
    expect(s.id).toMatch(/^[0-9a-f]{8}$/);
    expect(() => addServer(db, { type: 'ollama', name: 'Again', baseUrl: 'localhost:11434/', auto: false })).toThrow(HttpError);
    try {
      addServer(db, { type: 'ollama', name: 'Again', baseUrl: 'localhost:11434/', auto: false });
    } catch (e) {
      expect((e as HttpError).status).toBe(409);
    }
    expect(listServers(db)).toHaveLength(1);
    expect(getServer(db, s.id)).toEqual(s);
    expect(findServer(db, 'ollama', 'http://localhost:11434/')?.id).toBe(s.id);
  });

  it('updateServer keeps the id and the models', () => {
    const db = openDb(':memory:');
    const s = addServer(db, { type: 'lmstudio', name: 'LM', baseUrl: 'http://localhost:1234', auto: true });
    insertLocalModel(db, `local:${s.id}:qwen`);
    const u = updateServer(db, s.id, { baseUrl: 'http://127.0.0.1:1234/v1', name: 'Renamed', enabled: false });
    expect(u).toMatchObject({ id: s.id, baseUrl: 'http://127.0.0.1:1234', name: 'Renamed', enabled: false });
    expect(listLibrary(db).map((m) => m.id)).toEqual([`local:${s.id}:qwen`]);
  });

  it('removeServer clears settings and models but keeps chat history readable', () => {
    const db = openDb(':memory:');
    const s = addServer(db, { type: 'ollama', name: 'Ollama', baseUrl: 'http://localhost:11434', auto: false });
    const other = addServer(db, { type: 'openai', name: 'Other', baseUrl: 'http://localhost:8080', auto: false });
    const id = `local:${s.id}:llama3:8b`;
    insertLocalModel(db, id);
    insertLocalModel(db, `local:${other.id}:keep`);
    setSetting(db, 'default_model_id', id);
    setSetting(db, 'title_model_id', id);
    setSetting(db, 'memory_model_id', id);
    const chat = createChat(db);
    const u = insertMessage(db, { chatId: chat.id, parentId: null, role: 'user', content: 'hi' });
    insertMessage(db, { chatId: chat.id, parentId: u.id, role: 'assistant', content: 'hello', modelId: id });

    removeServer(db, s.id);

    expect(getSetting(db, 'default_model_id')).not.toBe(id);
    expect(getSetting(db, 'title_model_id')).toBe('');
    expect(getSetting(db, 'memory_model_id')).toBe('');
    expect(listLibrary(db).map((m) => m.id)).toEqual([`local:${other.id}:keep`]);
    expect(getChatMessages(db, chat.id)).toHaveLength(2);
    expect(displayNameOf(db, id)).toBe(id);
    expect(getServer(db, s.id)).toBeNull();
    expect(listServers(db).map((x) => x.id)).toEqual([other.id]);
  });

  it('re-adding a removed server restores the same id', () => {
    const db = openDb(':memory:');
    const s = addServer(db, { type: 'ollama', name: 'Ollama', baseUrl: 'http://localhost:11434', auto: true });
    removeServer(db, s.id);
    expect(findServer(db, 'ollama', 'localhost:11434')).toBeNull();
    expect(findServer(db, 'ollama', 'localhost:11434', { includeRemoved: true })).toMatchObject({ id: s.id, removed: true });
    const again = addServer(db, { type: 'ollama', name: 'New name', baseUrl: 'localhost:11434', auto: false });
    expect(again.id).toBe(s.id);
    expect(again.name).toBe('New name');
    expect(again.enabled).toBe(true);
    expect(listServers(db)).toHaveLength(1);
  });

  it('listLibrary fills source fields', () => {
    const db = openDb(':memory:');
    const o = addServer(db, { type: 'openai', name: 'Gen', baseUrl: 'http://localhost:8080', auto: false });
    const l = addServer(db, { type: 'lmstudio', name: 'LM', baseUrl: 'http://localhost:1234', auto: false });
    insertLocalModel(db, `local:${o.id}:a`, { contextWindow: 8192 });
    insertLocalModel(db, `local:${l.id}:b`);
    insertLocalModel(db, 'local:gone:c');
    db.prepare("INSERT INTO models (id, display_name, added_at) VALUES ('openai/gpt-4o', 'GPT', ?)").run(now());
    const byId = new Map(listLibrary(db).map((m) => [m.id, m]));
    expect(byId.get(`local:${o.id}:a`)).toMatchObject({ source: 'local', serverId: o.id, serverName: 'Gen', contextWindow: 8192, capsKnown: false });
    expect(byId.get(`local:${l.id}:b`)).toMatchObject({ source: 'local', serverName: 'LM', capsKnown: true });
    expect(byId.get('local:gone:c')).toMatchObject({ source: 'local', serverId: 'gone', serverName: null });
    expect(byId.get('openai/gpt-4o')).toMatchObject({ source: 'openrouter', serverId: null, capsKnown: true, contextWindow: null });
  });

  it('modelContextLength prefers context_window', () => {
    const db = openDb(':memory:');
    insertLocalModel(db, 'local:abc:m', { contextWindow: 4096, contextLength: 131072 });
    insertLocalModel(db, 'local:abc:n', { contextLength: 32000 });
    expect(modelContextLength(db, 'local:abc:m')).toBe(4096);
    expect(modelContextLength(db, 'local:abc:n')).toBe(32000);
    expect(modelContextLength(db, 'nope')).toBeNull();
  });

  it('stores context_dropped on messages', () => {
    const db = openDb(':memory:');
    const chat = createChat(db);
    const u = insertMessage(db, { chatId: chat.id, parentId: null, role: 'user', content: 'hi' });
    const a = insertMessage(db, { chatId: chat.id, parentId: u.id, role: 'assistant', content: 'x', contextDropped: true });
    expect(u.contextDropped).toBe(false);
    expect(a.contextDropped).toBe(true);
  });

  it('migrates a database without the new columns', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'openchat-')), 'old.db');
    const old = new Database(file);
    old.exec('CREATE TABLE models (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, context_length INTEGER, prompt_price REAL, completion_price REAL, added_at INTEGER NOT NULL)');
    old.close();
    const db = openDb(file);
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols('models')).toContain('context_window');
    expect(cols('messages')).toContain('context_dropped');
    expect(cols('local_servers')).toContain('removed_at');
  });
});
