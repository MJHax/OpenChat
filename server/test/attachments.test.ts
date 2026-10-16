import { describe, it, expect } from 'vitest';
import { openDb, now } from '../src/db';
import { makeApp, readEvents } from './appHelpers';
import { BAD_ATTACHMENT, MB, TOO_MANY_FILES, UNSUPPORTED_TYPE } from '../../shared/attachments';
import { withCatalogDefaults, type Attachment, type ChatSummary } from '../../shared/types';
import { addModel } from '../src/library';
import { getChatMessages } from '../src/messages';
import type { OpenRouterClient } from '../src/openrouter';
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

describe('attachment routes', () => {
  it('uploads a text file', async () => {
    const { upload } = makeApp();
    const res = await upload('# Hi', 'notes.md');
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ kind: 'text', mime: 'text/plain', filename: 'notes.md', size: 4 });
  });

  it('decides the kind from the content, not the name', async () => {
    const { upload } = makeApp();
    expect(await (await upload(PNG, 'photo.txt')).json()).toMatchObject({ kind: 'image', mime: 'image/png' });
  });

  it('serves the bytes back with safe headers', async () => {
    const { upload, call } = makeApp();
    const image = (await (await upload(PNG, 'photo.txt')).json()) as Attachment;
    const res = await call('GET', `/api/attachments/${image.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Disposition')).toContain("inline; filename*=UTF-8''photo.txt");
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=31536000, immutable');
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...PNG]);

    const text = (await (await upload('hello', 'a.md')).json()) as Attachment;
    expect((await call('GET', `/api/attachments/${text.id}`)).headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
    expect((await call('GET', '/api/attachments/nope')).status).toBe(404);

    const odd = (await (await upload('x', "it's (a)*.md")).json()) as Attachment;
    expect((await call('GET', `/api/attachments/${odd.id}`)).headers.get('Content-Disposition'))
      .toBe("inline; filename*=UTF-8''it%27s%20%28a%29%2A.md");
  });

  it('enforces the size limit for each kind', async () => {
    const { upload } = makeApp();
    const bigText = await upload('a'.repeat(MB + 1), 'notes.txt');
    expect(bigText.status).toBe(413);
    expect((await bigText.json()).error).toBe('notes.txt is too large. The limit for text files is 1 MB.');
    const bigImage = new Uint8Array(5 * MB + 1);
    bigImage.set(PNG);
    const res = await upload(bigImage, 'big.png');
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe('big.png is too large. The limit for image files is 5 MB.');
  });

  it('rejects unreadable and empty files, and requests without a file', async () => {
    const { upload, app } = makeApp();
    const binary = await upload(new Uint8Array([0, 1, 2, 255]), 'x.bin');
    expect(binary.status).toBe(400);
    expect((await binary.json()).error).toBe(UNSUPPORTED_TYPE);
    const empty = await upload('', 'empty.txt');
    expect(empty.status).toBe(400);
    expect((await empty.json()).error).toBe('empty.txt is empty.');
    const bomOnly = await upload(new Uint8Array([0xef, 0xbb, 0xbf]), 'bom.txt');
    expect(bomOnly.status).toBe(400);
    expect((await bomOnly.json()).error).toBe('bom.txt is empty.');
    const none = await app.request('/api/attachments', { method: 'POST', body: new FormData() });
    expect(none.status).toBe(400);
    expect((await none.json()).error).toBe('Attach a file.');
  });

  it('deletes pending attachments but not sent ones', async () => {
    const { upload, call, db } = makeApp();
    const a = (await (await upload('a', 'a.txt')).json()) as Attachment;
    expect((await call('DELETE', `/api/attachments/${a.id}`)).status).toBe(200);
    expect((await call('GET', `/api/attachments/${a.id}`)).status).toBe(404);
    expect((await call('DELETE', `/api/attachments/${a.id}`)).status).toBe(404);

    const b = (await (await upload('b', 'b.txt')).json()) as Attachment;
    const chat = createChat(db);
    const message = insertMessage(db, { chatId: chat.id, parentId: null, role: 'user', content: 'hi' });
    db.prepare('UPDATE attachments SET message_id = ? WHERE id = ?').run(message.id, b.id);
    const res = await call('DELETE', `/api/attachments/${b.id}`);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('This file is already part of a message.');
  });

  it('cleans up stale pending uploads when a new file is uploaded', async () => {
    const { upload, db } = makeApp();
    const stale = (await (await upload('old', 'old.txt')).json()) as Attachment;
    db.prepare('UPDATE attachments SET created_at = ? WHERE id = ?').run(now() - 25 * 60 * 60 * 1000, stale.id);
    await upload('new', 'new.txt');
    expect(getAttachmentRow(db, stale.id)).toBeUndefined();
  });
});

describe('sending with attachments', () => {
  const setup = () => {
    const ctx = makeApp({ streamChat: async function* () { yield { type: 'delta', text: 'ok' }; } });
    addModel(ctx.db, withCatalogDefaults({ id: 't/text', name: 'Text Model' }));
    addModel(ctx.db, withCatalogDefaults({ id: 'v/vision', name: 'Vision Model', inputModalities: ['text', 'image'] }));
    const newChat = async () => ((await (await ctx.call('POST', '/api/chats')).json()) as ChatSummary).id;
    const up = async (data: Uint8Array | string, name: string) => (await (await ctx.upload(data, name)).json()) as Attachment;
    const send = (chatId: string, body: object) => ctx.call('POST', `/api/chats/${chatId}/messages`, { modelId: 'v/vision', ...body });
    const userMessages = (chatId: string) => getChatMessages(ctx.db, chatId).filter((m) => m.role === 'user');
    return { ...ctx, newChat, up, send, userMessages };
  };

  it('claims the attachments in request order', async () => {
    const { newChat, up, send, userMessages, db } = setup();
    const chatId = await newChat();
    const a = await up('a', 'a.txt');
    const b = await up(PNG, 'b.png');
    await readEvents(await send(chatId, { content: 'Look', attachmentIds: [b.id, a.id] }));
    const [user] = userMessages(chatId);
    expect(user.attachments.map((x) => x.id)).toEqual([b.id, a.id]);
    expect(getAttachmentRow(db, a.id)?.messageId).toBe(user.id);
  });

  it('allows a message with attachments and no text, but not an empty one', async () => {
    const { newChat, up, send } = setup();
    const chatId = await newChat();
    const a = await up('a', 'a.txt');
    const ok = await send(chatId, { content: '', attachmentIds: [a.id] });
    expect(ok.status).toBe(200);
    await readEvents(ok);
    const empty = await send(chatId, { content: '' });
    expect(empty.status).toBe(400);
    expect((await empty.json()).error).toBe('Message is empty.');
  });

  it('rejects unknown, duplicate, already-used and too many attachment ids', async () => {
    const { newChat, up, send } = setup();
    const chatId = await newChat();
    const a = await up('a', 'a.txt');
    for (const attachmentIds of [['nope'], [a.id, a.id]]) {
      const res = await send(chatId, { content: 'x', attachmentIds });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(BAD_ATTACHMENT);
    }
    await readEvents(await send(chatId, { content: 'x', attachmentIds: [a.id] }));
    const reused = await send(chatId, { content: 'y', attachmentIds: [a.id] });
    expect((await reused.json()).error).toBe(BAD_ATTACHMENT);
    const many = await Promise.all(Array.from({ length: 11 }, (_, i) => up(String(i), `${i}.txt`)));
    const tooMany = await send(chatId, { content: 'z', attachmentIds: many.map((m) => m.id) });
    expect(tooMany.status).toBe(400);
    expect((await tooMany.json()).error).toBe(TOO_MANY_FILES);
  });

  it('rejects a new image for a model that cannot view images, but allows PDFs and text', async () => {
    const { newChat, up, send, call } = setup();
    const chatId = await newChat();
    const image = await up(PNG, 'photo.png');
    const res = await send(chatId, { content: 'x', modelId: 't/text', attachmentIds: [image.id] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Text Model can't view images.");
    const compare = await call('POST', `/api/chats/${chatId}/messages`, { content: 'x', modelIds: ['v/vision', 't/text'], attachmentIds: [image.id] });
    expect(compare.status).toBe(400);
    const pdf = await up(PDF, 'doc.pdf');
    const text = await up('notes', 'n.md');
    const ok = await send(chatId, { content: 'x', modelId: 't/text', attachmentIds: [pdf.id, text.id] });
    expect(ok.status).toBe(200);
    await readEvents(ok);
  });

  it('leaves attachments pending when the chat is busy', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const streamChat: OpenRouterClient['streamChat'] = async function* () { yield { type: 'delta', text: 'Working' }; await gate; };
    const { call, upload, db } = makeApp({ streamChat });
    const chatId = ((await (await call('POST', '/api/chats')).json()) as ChatSummary).id;
    const first = await call('POST', `/api/chats/${chatId}/messages`, { content: 'Long', modelId: 'm/a' });
    const a = (await (await upload('a', 'a.txt')).json()) as Attachment;
    const busy = await call('POST', `/api/chats/${chatId}/messages`, { content: 'Next', modelId: 'm/a', attachmentIds: [a.id] });
    expect(busy.status).toBe(409);
    expect(getAttachmentRow(db, a.id)?.messageId).toBeNull();
    release();
    await readEvents(first);
  });

  it('edit copies kept attachments, claims new ones and leaves the original alone', async () => {
    const { newChat, up, send, call, userMessages } = setup();
    const chatId = await newChat();
    const keep = await up('keep', 'keep.txt');
    const drop = await up('drop', 'drop.txt');
    await readEvents(await send(chatId, { content: 'v1', attachmentIds: [keep.id, drop.id] }));
    const [original] = userMessages(chatId);
    const added = await up('new', 'new.txt');
    const res = await call('POST', `/api/chats/${chatId}/edit`, { messageId: original.id, content: 'v2', modelId: 'v/vision', attachmentIds: [keep.id, added.id] });
    expect(res.status).toBe(200);
    await readEvents(res);
    const versions = userMessages(chatId);
    const edited = versions.find((m) => m.content === 'v2')!;
    expect(edited.attachments.map((x) => x.filename)).toEqual(['keep.txt', 'new.txt']);
    expect(edited.attachments[0].id).not.toBe(keep.id);
    expect(edited.attachments[1].id).toBe(added.id);
    expect(versions.find((m) => m.content === 'v1')!.attachments.map((x) => x.id)).toEqual([keep.id, drop.id]);
  });

  it('edit keeps an existing image for a text-only model, but blocks adding a new one', async () => {
    const { newChat, up, send, call, userMessages } = setup();
    const chatId = await newChat();
    const image = await up(PNG, 'photo.png');
    await readEvents(await send(chatId, { content: 'v1', attachmentIds: [image.id] }));
    const [original] = userMessages(chatId);
    const kept = await call('POST', `/api/chats/${chatId}/edit`, { messageId: original.id, content: 'v2', modelId: 't/text', attachmentIds: [image.id] });
    expect(kept.status).toBe(200);
    await readEvents(kept);
    const another = await up(PNG, 'second.png');
    const added = await call('POST', `/api/chats/${chatId}/edit`, { messageId: original.id, content: 'v3', modelId: 't/text', attachmentIds: [image.id, another.id] });
    expect(added.status).toBe(400);
    expect((await added.json()).error).toBe("Text Model can't view images.");
  });

  it('edit rejects attachments that belong to a different message', async () => {
    const { newChat, up, send, call, userMessages } = setup();
    const chatId = await newChat();
    const other = await up('other', 'other.txt');
    await readEvents(await send(chatId, { content: 'first', attachmentIds: [other.id] }));
    await readEvents(await send(chatId, { content: 'second' }));
    const second = userMessages(chatId).find((m) => m.content === 'second')!;
    const res = await call('POST', `/api/chats/${chatId}/edit`, { messageId: second.id, content: 'x', modelId: 'v/vision', attachmentIds: [other.id] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(BAD_ATTACHMENT);
  });
});
