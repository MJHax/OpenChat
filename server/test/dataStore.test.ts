import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeApp } from './appHelpers';
import { insertMessage } from '../src/messages';
import { attachToMessage, getAttachmentRow, insertGenerated, insertPending } from '../src/attachments';
import { ensurePdfText } from '../src/pdfText';
import { pdfWithText } from '../../test/helpers';
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

  it('empties the extracted PDF text', () => {
    const { db, deps } = makeApp();
    db.prepare("INSERT INTO pdf_text (key, text) VALUES ('k', 'text')").run();
    deleteData(deps, 'all');
    expect(db.prepare('SELECT count(*) AS n FROM pdf_text').get()).toEqual({ n: 0 });
  });
});

describe('extracted PDF text', () => {
  const pdfCount = (db: ReturnType<typeof makeApp>['db']) => (db.prepare('SELECT count(*) AS n FROM pdf_text').get() as { n: number }).n;

  it('goes with the last chat that holds the PDF, not the first', async () => {
    const { db, call } = makeApp();
    const data = pdfWithText('Shared contract text');
    const chats: ChatSummary[] = [];
    for (let i = 0; i < 2; i++) {
      const chat = (await (await call('POST', '/api/chats')).json()) as ChatSummary;
      const msg = insertMessage(db, { chatId: chat.id, parentId: null, role: 'user', content: 'see file' });
      const pdf = insertPending(db, { filename: 'a.pdf', kind: 'pdf', mime: 'application/pdf', data });
      attachToMessage(db, msg.id, [getAttachmentRow(db, pdf.id)!]);
      await ensurePdfText(db, [pdf.id]);
      chats.push(chat);
    }
    expect(pdfCount(db)).toBe(1);
    expect((await call('DELETE', `/api/chats/${chats[0].id}`)).status).toBe(200);
    expect(pdfCount(db)).toBe(1);
    expect((await call('DELETE', `/api/chats/${chats[1].id}`)).status).toBe(200);
    expect(pdfCount(db)).toBe(0);
  });

  it('goes when a kind of thread is deleted', async () => {
    const { db, deps, call } = makeApp();
    const chat = (await (await call('POST', '/api/chats')).json()) as ChatSummary;
    const msg = insertMessage(db, { chatId: chat.id, parentId: null, role: 'user', content: 'see file' });
    const pdf = insertPending(db, { filename: 'a.pdf', kind: 'pdf', mime: 'application/pdf', data: pdfWithText('Gone soon') });
    attachToMessage(db, msg.id, [getAttachmentRow(db, pdf.id)!]);
    await ensurePdfText(db, [pdf.id]);
    deleteData(deps, 'chats');
    expect(pdfCount(db)).toBe(0);
  });
});
