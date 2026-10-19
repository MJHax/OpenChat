import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db';
import { createChat, deleteChat } from '../src/chats';
import { insertMessage } from '../src/messages';
import { attachToMessage, copyGenerated, getAttachmentRow, insertGenerated, insertPending } from '../src/attachments';
import { clipPath } from '../src/videoJobs';
import { libraryItems } from '../src/fileLibrary';
import { makeApp } from './appHelpers';
import type { ThreadKind } from '../../shared/types';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]);
const utf8 = (s: string) => new TextEncoder().encode(s);
const file = (name: string, body: string) => `<file name="${name}">\n${body}\n</file>`;

function setup() {
  const db = openDb(':memory:');
  const mediaDir = mkdtempSync(join(tmpdir(), 'openchat-lib-'));
  return { db, mediaDir };
}

function chat(db: DB, title: string, kind: ThreadKind = 'chat') {
  const c = createChat(db, kind);
  db.prepare('UPDATE chats SET title = ? WHERE id = ?').run(title, c.id);
  return c;
}

/** A user message in `chatId` carrying a sent copy of `data`. */
function send(db: DB, chatId: string, filename: string, data: Uint8Array, kind: 'image' | 'text' | 'pdf' = 'image', parentId: string | null = null) {
  const m = insertMessage(db, { chatId, parentId, role: 'user', content: 'here' });
  const p = insertPending(db, { filename, kind, mime: kind === 'image' ? 'image/png' : 'text/plain', data });
  attachToMessage(db, m.id, [getAttachmentRow(db, p.id)!]);
  return { message: m, attachmentId: p.id };
}

function reply(db: DB, chatId: string, parentId: string | null, content: string) {
  return insertMessage(db, { chatId, parentId, role: 'assistant', content });
}

describe('libraryItems', () => {
  it('lists a sent upload under uploads with its chat', () => {
    const { db, mediaDir } = setup();
    const a = chat(db, 'Recipes');
    send(db, a.id, 'a.png', PNG);
    const lib = libraryItems(db, mediaDir);
    expect(lib.generated).toEqual([]);
    expect(lib.uploads).toHaveLength(1);
    expect(lib.uploads[0]).toMatchObject({ type: 'image', name: 'a.png', size: PNG.length, chats: [{ chatId: a.id, kind: 'chat', title: 'Recipes' }] });
  });

  it('leaves out pending uploads', () => {
    const { db, mediaDir } = setup();
    insertPending(db, { filename: 'a.png', kind: 'image', mime: 'image/png', data: PNG });
    expect(libraryItems(db, mediaDir).uploads).toEqual([]);
  });

  it('groups identical uploads across chats, newest chat first, each chat once', () => {
    const { db, mediaDir } = setup();
    const [a, b, c] = [chat(db, 'A'), chat(db, 'B'), chat(db, 'C')];
    send(db, a.id, 'r.png', PNG);
    send(db, b.id, 'r.png', PNG);
    const inC = send(db, c.id, 'receipt.png', PNG);
    // A branch copy in C: the same row attached to a second message of the same chat.
    const again = insertMessage(db, { chatId: c.id, parentId: null, role: 'user', content: 'again' });
    attachToMessage(db, again.id, [getAttachmentRow(db, inC.attachmentId)!]);
    const { uploads } = libraryItems(db, mediaDir);
    expect(uploads).toHaveLength(1);
    expect(uploads[0].chats.map((x) => x.chatId)).toEqual([c.id, b.id, a.id]);
    expect(uploads[0].source.type).toBe('attachment');
    const newest = db.prepare('SELECT id FROM attachments WHERE message_id = ?').get(again.id) as { id: string };
    expect(uploads[0].source).toMatchObject({ attachmentId: newest.id });
    expect(uploads[0].createdAt).toBe(uploads[0].chats[0].at);
  });

  it('does not group uploads that only share a name', () => {
    const { db, mediaDir } = setup();
    const a = chat(db, 'A');
    send(db, a.id, 'x.txt', utf8('one'), 'text');
    send(db, a.id, 'x.txt', utf8('two'), 'text');
    const { uploads } = libraryItems(db, mediaDir);
    expect(uploads).toHaveLength(2);
    expect(uploads[0].type).toBe('doc');
  });

  it('lists generated images, chat files and finished videos', () => {
    const { db, mediaDir } = setup();
    const img = chat(db, 'Fox', 'image');
    const iu = insertMessage(db, { chatId: img.id, parentId: null, role: 'user', content: 'a fox' });
    const ia = reply(db, img.id, iu.id, '');
    insertGenerated(db, { messageId: ia.id, filename: 'a-fox-1.png', kind: 'image', mime: 'image/png', data: PNG });

    const code = chat(db, 'Refactor');
    const cu = insertMessage(db, { chatId: code.id, parentId: null, role: 'user', content: 'write it' });
    const ca = reply(db, code.id, cu.id, file('parser.ts', 'export {}'));
    db.prepare('UPDATE chats SET active_leaf_id = ? WHERE id = ?').run(ca.id, code.id);

    const vid = chat(db, 'Ocean', 'video');
    const vu = insertMessage(db, { chatId: vid.id, parentId: null, role: 'user', content: 'waves' });
    const va = reply(db, vid.id, vu.id, '');
    db.prepare(
      `INSERT INTO video_jobs (job_id, thread_id, message_id, model_id, settings, polling_url, started_at, next_poll_at, finished_at)
       VALUES ('j1', ?, ?, 'v/m', '{}', 'u', 1, 1, 2)`,
    ).run(vid.id, va.id);
    writeFileSync(clipPath(mediaDir, va.id), Buffer.alloc(42));

    const { generated, uploads } = libraryItems(db, mediaDir);
    expect(uploads).toEqual([]);
    expect(generated).toHaveLength(3);
    expect(generated.find((g) => g.type === 'image')).toMatchObject({ name: 'a-fox-1.png', chats: [{ chatId: img.id, kind: 'image' }] });
    expect(generated.find((g) => g.type === 'code')).toMatchObject({
      name: 'parser.ts', source: { type: 'chatFile', messageId: ca.id, name: 'parser.ts' }, chats: [{ chatId: code.id }],
    });
    expect(generated.find((g) => g.type === 'video')).toMatchObject({
      name: 'Ocean.mp4', size: 42, source: { type: 'video', messageId: va.id }, chats: [{ chatId: vid.id, kind: 'video' }],
    });
  });

  it('leaves out incomplete file blocks and unfinished clips', () => {
    const { db, mediaDir } = setup();
    const c = chat(db, 'Cut off');
    const u = insertMessage(db, { chatId: c.id, parentId: null, role: 'user', content: 'go' });
    const a = reply(db, c.id, u.id, '<file name="half.ts">\nexport const x');
    db.prepare('UPDATE chats SET active_leaf_id = ? WHERE id = ?').run(a.id, c.id);
    const v = chat(db, 'Rendering', 'video');
    const vu = insertMessage(db, { chatId: v.id, parentId: null, role: 'user', content: 'waves' });
    const va = reply(db, v.id, vu.id, '');
    db.prepare(
      `INSERT INTO video_jobs (job_id, thread_id, message_id, model_id, settings, polling_url, started_at, next_poll_at)
       VALUES ('j2', ?, ?, 'v/m', '{}', 'u', 1, 1)`,
    ).run(v.id, va.id);
    expect(libraryItems(db, mediaDir).generated).toEqual([]);
  });

  it('a reused generated file adds its chat to the generated item instead of uploads', () => {
    const { db, mediaDir } = setup();
    const img = chat(db, 'Fox', 'image');
    const iu = insertMessage(db, { chatId: img.id, parentId: null, role: 'user', content: 'a fox' });
    const fox = insertGenerated(db, { messageId: reply(db, img.id, iu.id, '').id, filename: 'fox.png', kind: 'image', mime: 'image/png', data: PNG });
    const d = chat(db, 'D');
    const copy = copyGenerated(db, { attachmentId: fox.id });
    const m = insertMessage(db, { chatId: d.id, parentId: null, role: 'user', content: 'look' });
    attachToMessage(db, m.id, [getAttachmentRow(db, copy.id)!]);
    const { uploads, generated } = libraryItems(db, mediaDir);
    expect(uploads).toEqual([]);
    expect(generated).toHaveLength(1);
    expect(generated[0].chats.map((x) => x.chatId)).toEqual([d.id, img.id]);
    expect(generated[0].source).toMatchObject({ type: 'attachment', attachmentId: fox.id });
  });

  it('an attached older version of a chat file counts as a reuse', () => {
    const { db, mediaDir } = setup();
    const e = chat(db, 'E');
    const u1 = insertMessage(db, { chatId: e.id, parentId: null, role: 'user', content: 'draft' });
    const a1 = reply(db, e.id, u1.id, file('notes.md', 'v1'));
    const u2 = insertMessage(db, { chatId: e.id, parentId: a1.id, role: 'user', content: 'again' });
    const a2 = reply(db, e.id, u2.id, file('notes.md', 'v2'));
    db.prepare('UPDATE chats SET active_leaf_id = ? WHERE id = ?').run(a2.id, e.id);
    const f = chat(db, 'F');
    send(db, f.id, 'notes.md', utf8('v1'), 'text');
    const { uploads, generated } = libraryItems(db, mediaDir);
    expect(uploads).toEqual([]);
    expect(generated).toHaveLength(1);
    expect(generated[0]).toMatchObject({ type: 'doc', source: { type: 'chatFile', messageId: a2.id, name: 'notes.md' } });
    expect(generated[0].chats.map((x) => x.chatId)).toEqual([f.id, e.id]);
  });

  it('identical files written in two chats collapse into one generated item', () => {
    const { db, mediaDir } = setup();
    for (const title of ['One', 'Two']) {
      const c = chat(db, title);
      const u = insertMessage(db, { chatId: c.id, parentId: null, role: 'user', content: 'go' });
      const a = reply(db, c.id, u.id, file('same.ts', 'export {}'));
      db.prepare('UPDATE chats SET active_leaf_id = ? WHERE id = ?').run(a.id, c.id);
    }
    const { generated } = libraryItems(db, mediaDir);
    expect(generated).toHaveLength(1);
    expect(generated[0].chats.map((x) => x.title)).toEqual(['Two', 'One']);
  });

  it('deleting a chat removes it from every item', () => {
    const { db, mediaDir } = setup();
    const [a, b] = [chat(db, 'A'), chat(db, 'B')];
    send(db, a.id, 'r.png', PNG);
    send(db, b.id, 'r.png', PNG);
    deleteChat(db, a.id);
    expect(libraryItems(db, mediaDir).uploads[0].chats.map((x) => x.chatId)).toEqual([b.id]);
    deleteChat(db, b.id);
    expect(libraryItems(db, mediaDir).uploads).toEqual([]);
  });
});

describe('reusing a shrunk copy', () => {
  it('an upload marked as a copy of a generated image counts as a reuse even though its bytes differ', async () => {
    const ctx = makeApp();
    const img = chat(ctx.db, 'Big', 'image');
    const iu = insertMessage(ctx.db, { chatId: img.id, parentId: null, role: 'user', content: 'huge' });
    const big = insertGenerated(ctx.db, { messageId: reply(ctx.db, img.id, iu.id, '').id, filename: 'big.png', kind: 'image', mime: 'image/png', data: PNG });
    const form = new FormData();
    const shrunk = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    form.append('file', new File([shrunk], 'big.jpg'));
    form.append('copyOf', big.id);
    const res = await ctx.app.request('/api/attachments', { method: 'POST', body: form });
    expect(res.status).toBe(201);
    const copy = await res.json();
    const d = chat(ctx.db, 'D');
    const m = insertMessage(ctx.db, { chatId: d.id, parentId: null, role: 'user', content: 'look' });
    attachToMessage(ctx.db, m.id, [getAttachmentRow(ctx.db, copy.id)!]);
    const { uploads, generated } = libraryItems(ctx.db, ctx.deps.mediaDir);
    expect(uploads).toEqual([]);
    expect(generated[0].chats.map((x) => x.chatId)).toEqual([d.id, img.id]);
  });
});

describe('/api/library', () => {
  it('lists the library', async () => {
    const ctx = makeApp();
    const a = chat(ctx.db, 'A');
    send(ctx.db, a.id, 'a.png', PNG);
    const res = await ctx.call('GET', '/api/library');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.uploads).toHaveLength(1);
    expect(body.generated).toEqual([]);
  });

  it('serves a chat-written file as text, whatever its name', async () => {
    const ctx = makeApp();
    const c = chat(ctx.db, 'C');
    const u = insertMessage(ctx.db, { chatId: c.id, parentId: null, role: 'user', content: 'go' });
    const a = reply(ctx.db, c.id, u.id, file('my notes/ü.md', 'héllo'));
    const res = await ctx.call('GET', `/api/library/files/${a.id}/${encodeURIComponent('my notes/ü.md')}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe('héllo');
    expect((await ctx.call('GET', `/api/library/files/${a.id}/missing.md`)).status).toBe(404);
  });
});
