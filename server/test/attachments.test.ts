import { describe, it, expect } from 'vitest';
import { openDb, now } from '../src/db';
import { createChat, deleteChat } from '../src/chats';
import { insertMessage } from '../src/messages';
import {
  attachmentsFor, cleanFilename, cleanupPending, deletePending, detectKind, getAttachmentData, getAttachmentRow, insertPending,
} from '../src/attachments';

const bytes = (...values: number[]) => new Uint8Array(values);
const utf8 = (text: string) => new TextEncoder().encode(text);
const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

export const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3);
export const PDF = utf8('%PDF-1.7\n%âãÏÓ\n');

describe('detectKind', () => {
  it('recognises images by their signature', () => {
    expect(detectKind(PNG)).toMatchObject({ kind: 'image', mime: 'image/png' });
    expect(detectKind(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10))).toMatchObject({ kind: 'image', mime: 'image/jpeg' });
    expect(detectKind(bytes(...ascii('GIF89a'), 1, 0))).toMatchObject({ kind: 'image', mime: 'image/gif' });
    expect(detectKind(bytes(...ascii('GIF87a'), 1, 0))).toMatchObject({ kind: 'image', mime: 'image/gif' });
    expect(detectKind(bytes(...ascii('RIFF'), 0x24, 0, 0, 0, ...ascii('WEBPVP8 ')))).toMatchObject({ kind: 'image', mime: 'image/webp' });
  });

  it('recognises PDFs', () => {
    expect(detectKind(PDF)).toMatchObject({ kind: 'pdf', mime: 'application/pdf' });
  });

  it('treats valid UTF-8 without NUL bytes as text and strips a byte-order mark', () => {
    expect(detectKind(utf8('const x = "é";'))).toMatchObject({ kind: 'text', mime: 'text/plain' });
    const withBom = detectKind(bytes(0xef, 0xbb, 0xbf, ...utf8('hi')));
    expect(withBom?.kind).toBe('text');
    expect([...withBom!.bytes]).toEqual([...utf8('hi')]);
  });

  it('rejects empty files, NUL bytes, non-UTF-8 text and binary data', () => {
    expect(detectKind(bytes())).toBeNull();
    expect(detectKind(bytes(0x63, 0x00, 0x64))).toBeNull();
    expect(detectKind(bytes(0x63, 0x61, 0x66, 0xe9))).toBeNull(); // "café" in Windows-1252
    expect(detectKind(bytes(0x00, 0x01, 0x02, 0xff))).toBeNull();
  });
});

describe('cleanFilename', () => {
  it('keeps the last path segment without control characters, at most 200 characters', () => {
    expect(cleanFilename('C:\\Users\\me\\notes.md')).toBe('notes.md');
    expect(cleanFilename('a/b/c.txt')).toBe('c.txt');
    expect(cleanFilename('bad\u0007name.txt')).toBe('badname.txt');
    expect(cleanFilename('')).toBe('file');
    expect(cleanFilename('x'.repeat(300))).toHaveLength(200);
  });
});

describe('attachment storage', () => {
  const setup = () => {
    const db = openDb(':memory:');
    const chat = createChat(db);
    const message = insertMessage(db, { chatId: chat.id, parentId: null, role: 'user', content: 'hi' });
    const claim = (id: string, position = 0) =>
      db.prepare('UPDATE attachments SET message_id = ?, position = ? WHERE id = ?').run(message.id, position, id);
    return { db, chat, message, claim };
  };

  it('stores pending attachments and reads their bytes back', () => {
    const { db } = setup();
    const a = insertPending(db, { filename: 'photo.png', kind: 'image', mime: 'image/png', data: PNG });
    expect(getAttachmentRow(db, a.id)).toEqual({ ...a, messageId: null });
    expect(a.size).toBe(PNG.length);
    expect([...getAttachmentData(db, a.id)!]).toEqual([...PNG]);
  });

  it('deletes only pending attachments', () => {
    const { db, claim } = setup();
    const pending = insertPending(db, { filename: 'a.txt', kind: 'text', mime: 'text/plain', data: utf8('a') });
    const sent = insertPending(db, { filename: 'b.txt', kind: 'text', mime: 'text/plain', data: utf8('b') });
    claim(sent.id);
    expect(deletePending(db, pending.id)).toBe('deleted');
    expect(getAttachmentRow(db, pending.id)).toBeUndefined();
    expect(deletePending(db, sent.id)).toBe('sent');
    expect(deletePending(db, 'nope')).toBe('missing');
  });

  it('cleans up old pending attachments only', () => {
    const { db, claim } = setup();
    const add = (name: string) => insertPending(db, { filename: name, kind: 'text', mime: 'text/plain', data: utf8(name) });
    const old = add('old');
    const fresh = add('fresh');
    const oldSent = add('old-sent');
    claim(oldSent.id);
    db.prepare('UPDATE attachments SET created_at = ? WHERE id IN (?, ?)').run(now() - 2000, old.id, oldSent.id);
    expect(cleanupPending(db, 1000)).toBe(1);
    expect(getAttachmentRow(db, old.id)).toBeUndefined();
    expect(getAttachmentRow(db, fresh.id)).toBeDefined();
    expect(getAttachmentRow(db, oldSent.id)).toBeDefined();
  });

  it('lists attachments per message in position order', () => {
    const { db, message, claim } = setup();
    const first = insertPending(db, { filename: 'first.txt', kind: 'text', mime: 'text/plain', data: utf8('1') });
    const second = insertPending(db, { filename: 'second.txt', kind: 'text', mime: 'text/plain', data: utf8('2') });
    claim(first.id, 1);
    claim(second.id, 0);
    expect(attachmentsFor(db, [message.id]).get(message.id)?.map((a) => a.filename)).toEqual(['second.txt', 'first.txt']);
    expect(attachmentsFor(db, []).size).toBe(0);
  });

  it('removes attachments when their chat is deleted', () => {
    const { db, chat, claim } = setup();
    const a = insertPending(db, { filename: 'a.txt', kind: 'text', mime: 'text/plain', data: utf8('a') });
    claim(a.id);
    deleteChat(db, chat.id);
    expect(getAttachmentRow(db, a.id)).toBeUndefined();
  });
});
