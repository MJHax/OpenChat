import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeApp } from './appHelpers';
import { readZip } from './zipReader';
import { insertMessage } from '../src/messages';
import { attachToMessage, insertGenerated, insertPending } from '../src/attachments';
import { renameChat, setActiveLeaf } from '../src/chats';
import { setSetting } from '../src/settings';
import { safeName } from '../src/exportData';
import { addServer } from '../src/localServers';
import type { ChatSummary, ThreadKind } from '../../shared/types';

async function seed() {
  const ctx = makeApp();
  const { db, call, deps } = ctx;
  const thread = async (kind: ThreadKind, title: string) => {
    const t = (await (await call('POST', '/api/chats', { kind })).json()) as ChatSummary;
    renameChat(db, t.id, title);
    return t.id;
  };
  const chatA = await thread('chat', 'Plans: a/b "test"?');
  const chatB = await thread('chat', 'Plans: a/b "test"?');
  const u = insertMessage(db, { chatId: chatA, parentId: null, role: 'user', content: 'Hello there' });
  const r1 = insertMessage(db, { chatId: chatA, parentId: u.id, role: 'assistant', content: 'First answer', modelId: 'm/a' });
  const r2 = insertMessage(db, { chatId: chatA, parentId: u.id, role: 'assistant', content: 'Second answer', modelId: 'm/b' });
  setActiveLeaf(db, chatA, r2.id);
  const upload = insertPending(db, { filename: 'notes.txt', kind: 'text', mime: 'text/plain', data: Buffer.from('my notes') });
  attachToMessage(db, u.id, [{ ...upload, messageId: null }]);
  const image = await thread('image', 'Cats');
  const iu = insertMessage(db, { chatId: image, parentId: null, role: 'user', content: 'a cat' });
  const ir = insertMessage(db, { chatId: image, parentId: iu.id, role: 'assistant', content: '', modelId: 'i/m' });
  const png = insertGenerated(db, { messageId: ir.id, filename: 'cat.png', kind: 'image', mime: 'image/png', data: Buffer.from([1, 2, 3, 4]) });
  const video = await thread('video', 'Waves');
  const vu = insertMessage(db, { chatId: video, parentId: null, role: 'user', content: 'waves' });
  const vr = insertMessage(db, { chatId: video, parentId: vu.id, role: 'assistant', content: '', modelId: 'v/m' });
  writeFileSync(join(deps.mediaDir, `${vr.id}.mp4`), Buffer.from('fake mp4 bytes'));
  setSetting(db, 'api_key', 'sk-or-secret-abcdef123456');
  setSetting(db, 'about_me', 'I like tea');
  await call('POST', '/api/memories', { content: 'Lives by the sea' });
  await call('POST', '/api/prompts', { title: '', content: 'Bullets only' });
  return { ...ctx, chatA, chatB, upload, png, vr, r1 };
}

describe('safeName', () => {
  it('drops characters that are not allowed in file names', () => {
    expect(safeName('Plans: a/b "test"?')).toBe('Plans- a-b -test');
    expect(safeName('  ...  ')).toBe('untitled');
  });
});

describe('GET /api/data/export', () => {
  it('downloads one zip with JSON, Markdown per thread, attachments and clips', async () => {
    const { call, chatA, chatB, upload, png, vr } = await seed();
    const res = await call('GET', '/api/data/export');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="openchat-export-\d{4}-\d{2}-\d{2}\.zip"$/);
    const files = readZip(Buffer.from(await res.arrayBuffer()));
    const names = [...files.keys()];

    const raw = files.get('openchat-export/data.json')!.toString();
    expect(raw).not.toContain('sk-or-secret');
    const data = JSON.parse(raw);
    expect(data.chats).toHaveLength(4);
    expect(data.messages).toHaveLength(7);
    expect(data.memories[0].content).toBe('Lives by the sea');
    expect(data.prompts[0].content).toBe('Bullets only');
    expect(data.settings.about_me).toBe('I like tea');
    expect(data.settings.api_key).toBeUndefined();

    // Same title twice: each file is still separate.
    const a = `openchat-export/chats/Plans- a-b -test-${chatA.slice(0, 8)}.md`;
    expect(names).toContain(a);
    expect(names).toContain(`openchat-export/chats/Plans- a-b -test-${chatB.slice(0, 8)}.md`);
    const md = files.get(a)!.toString();
    expect(md).toContain('Hello there');
    expect(md).toContain('Second answer');
    expect(md).not.toContain('First answer');
    expect(md).toContain('1 message(s) on other branches');
    expect(md).toContain(`[notes.txt](../attachments/${upload.id}/notes.txt)`);
    expect(names.some((n) => n.startsWith('openchat-export/images/Cats-'))).toBe(true);
    expect(names.find((n) => n.startsWith('openchat-export/videos/Waves-'))).toBeDefined();

    expect(files.get(`openchat-export/attachments/${upload.id}/notes.txt`)!.toString()).toBe('my notes');
    expect([...files.get(`openchat-export/attachments/${png.id}/cat.png`)!]).toEqual([1, 2, 3, 4]);
    expect(files.get(`openchat-export/clips/${vr.id}.mp4`)!.toString()).toBe('fake mp4 bytes');
  });

  it('includes columns added to chats later', async () => {
    const { call, db } = await seed();
    db.exec("ALTER TABLE chats ADD COLUMN future_note TEXT DEFAULT 'kept'");
    const files = readZip(Buffer.from(await (await call('GET', '/api/data/export')).arrayBuffer()));
    expect(JSON.parse(files.get('openchat-export/data.json')!.toString()).chats[0].future_note).toBe('kept');
  });

  it("includes each chat's own instructions", async () => {
    const { call, db } = await seed();
    db.prepare('UPDATE chats SET instructions = ?').run('be brief');
    const files = readZip(Buffer.from(await (await call('GET', '/api/data/export')).arrayBuffer()));
    expect(JSON.parse(files.get('openchat-export/data.json')!.toString()).chats[0].instructions).toBe('be brief');
  });
});

describe('local servers in the export', () => {
  it('lists the servers the user added', async () => {
    const { call, db } = makeApp();
    addServer(db, { type: 'ollama', name: 'Ollama', baseUrl: 'http://localhost:11434', auto: false });
    const files = readZip(Buffer.from(await (await call('GET', '/api/data/export')).arrayBuffer()));
    const data = JSON.parse(files.get('openchat-export/data.json')!.toString());
    expect(data.localServers).toHaveLength(1);
    expect(data.localServers[0]).toMatchObject({ type: 'ollama', name: 'Ollama', base_url: 'http://localhost:11434' });
  });
});
