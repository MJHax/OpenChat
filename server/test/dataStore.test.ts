import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeApp } from './appHelpers';
import { insertMessage } from '../src/messages';
import { insertGenerated } from '../src/attachments';
import { addServer } from '../src/localServers';
import { deleteData } from '../src/dataStore';
import type { ChatSummary } from '../../shared/types';

const MARKER = 'qzxmarker7731';

const fileHas = (file: string, text: string) => existsSync(file) && readFileSync(file).includes(Buffer.from(text));

describe('real deletion', () => {
  it('leaves no trace of a deleted chat in the database file, its WAL or the search index', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'openchat-del-')), 'openchat.db');
    const { db, call } = makeApp({}, undefined, file);
    const chat = (await (await call('POST', '/api/chats')).json()) as ChatSummary;
    // Enough text that the message spills onto overflow pages, plus a blob, so both kinds of freed page are covered.
    const user = insertMessage(db, { chatId: chat.id, parentId: null, role: 'user', content: `Remember ${MARKER} ${'filler '.repeat(2000)}` });
    const reply = insertMessage(db, { chatId: chat.id, parentId: user.id, role: 'assistant', content: `Noted: ${MARKER}`, modelId: 'm/a' });
    insertGenerated(db, { messageId: reply.id, filename: 'note.txt', kind: 'text', mime: 'text/plain', data: Buffer.from(`file ${MARKER}`) });
    db.pragma('wal_checkpoint(TRUNCATE)');
    expect(fileHas(file, MARKER)).toBe(true);

    expect((await call('DELETE', `/api/chats/${chat.id}`)).status).toBe(200);

    expect(db.prepare('SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH ?').get(MARKER)).toEqual({ n: 0 });
    expect(fileHas(file, MARKER)).toBe(false);
    expect(fileHas(`${file}-wal`, MARKER)).toBe(false);
    db.close();
  });
});

describe('delete all my data', () => {
  it('removes the local servers too', () => {
    const { db, deps } = makeApp();
    addServer(db, { type: 'ollama', name: 'Ollama', baseUrl: 'http://localhost:11434', auto: false });
    expect(db.prepare('SELECT count(*) AS n FROM local_servers').get()).toEqual({ n: 1 });
    deleteData(deps, 'all');
    expect(db.prepare('SELECT count(*) AS n FROM local_servers').get()).toEqual({ n: 0 });
  });
});
