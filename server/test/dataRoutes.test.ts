import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeApp } from './appHelpers';
import { logReply } from './usageHelpers';
import { insertMessage } from '../src/messages';
import { attachToMessage, insertGenerated, insertPending } from '../src/attachments';
import { setSetting } from '../src/settings';
import { now } from '../src/db';
import type { ChatSummary, StorageUsage, ThreadKind } from '../../shared/types';

async function seed() {
  const ctx = makeApp();
  const { db, call, deps } = ctx;
  const thread = async (kind: ThreadKind) => {
    const t = (await (await call('POST', '/api/chats', { kind })).json()) as ChatSummary;
    const user = insertMessage(db, { chatId: t.id, parentId: null, role: 'user', content: `${kind} prompt` });
    const reply = insertMessage(db, { chatId: t.id, parentId: user.id, role: 'assistant', content: `${kind} reply`, modelId: 'm/a' });
    logReply(db, { chatId: t.id, messageId: reply.id, cost: 0.01 });
    return { id: t.id, user, reply };
  };
  const chat = await thread('chat');
  attachToMessage(db, chat.user.id, [{ ...insertPending(db, { filename: 'notes.txt', kind: 'text', mime: 'text/plain', data: Buffer.alloc(3000, 1) }), messageId: null }]);
  const image = await thread('image');
  insertGenerated(db, { messageId: image.reply.id, filename: 'cat.png', kind: 'image', mime: 'image/png', data: Buffer.alloc(5000, 2) });
  const video = await thread('video');
  writeFileSync(join(deps.mediaDir, `${video.reply.id}.mp4`), Buffer.alloc(7000, 3));
  db.prepare(
    `INSERT INTO video_jobs (job_id, thread_id, message_id, model_id, settings, polling_url, started_at, next_poll_at, finished_at)
     VALUES ('job-1', ?, ?, 'v/m', '{}', 'u', 1, 1, 2)`,
  ).run(video.id, video.reply.id);
  db.prepare(
    `INSERT INTO media_events (created_at, kind, thread_id, message_id, model_id, settings, cost, status) VALUES (?, 'video', ?, ?, 'v/m', '{}', 0.5, 'complete')`,
  ).run(now(), video.id, video.reply.id);
  await call('POST', '/api/memories', { content: 'Likes tea' });
  setSetting(db, 'about_me', 'A tester');
  setSetting(db, 'api_key', 'sk-or-stored-1234567890');
  return { ...ctx, chat, image, video };
}

const count = (db: ReturnType<typeof makeApp>['db'], sql: string) => (db.prepare(sql).get() as { n: number }).n;
const kinds = (db: ReturnType<typeof makeApp>['db']) =>
  (db.prepare('SELECT kind FROM chats ORDER BY kind').all() as { kind: string }[]).map((r) => r.kind);
const del = (call: ReturnType<typeof makeApp>['call'], target: string, confirm = 'DELETE') => call('POST', '/api/data/delete', { target, confirm });

describe('storage', () => {
  it('breaks disk use down by kind', async () => {
    const { call } = await seed();
    const s = (await (await call('GET', '/api/data/storage')).json()) as StorageUsage;
    expect(s.parts.uploads).toBe(3000);
    expect(s.parts.images).toBe(5000);
    expect(s.parts.videos).toBe(7000);
    expect(s.parts.messages).toBeGreaterThan(0);
    const sum = Object.values(s.parts).reduce((a, b) => a + b, 0);
    expect(s.total).toBe(sum);
    expect(s.total).toBeGreaterThan(15000);
  });

  it('clean up gives back the free pages', async () => {
    const { db, call } = await seed();
    await del(call, 'chats');
    expect(db.pragma('freelist_count', { simple: true })).toBeGreaterThan(0);
    const s = (await (await call('POST', '/api/data/cleanup')).json()) as StorageUsage;
    expect(db.pragma('freelist_count', { simple: true })).toBe(0);
    expect(s.parts.reclaimable).toBe(0);
  });
});

describe('deletes', () => {
  it('needs DELETE typed and a known target', async () => {
    const { call, db } = await seed();
    expect((await del(call, 'chats', 'delete')).status).toBe(400);
    expect((await del(call, 'everything')).status).toBe(400);
    expect(kinds(db)).toEqual(['chat', 'image', 'video']);
  });

  it('delete all chats keeps images, videos, memories, settings and stats', async () => {
    const { call, db, chat } = await seed();
    const res = await del(call, 'chats');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, chatIds: [chat.id] });
    expect(kinds(db)).toEqual(['image', 'video']);
    expect(count(db, "SELECT count(*) AS n FROM attachments WHERE kind = 'text'")).toBe(0);
    expect(count(db, "SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'chat'")).toBe(0);
    expect(count(db, 'SELECT count(*) AS n FROM memories')).toBe(1);
    expect(count(db, 'SELECT count(*) AS n FROM usage_events')).toBe(3);
    // Stats still load, with the deleted chat's spend in the totals.
    const stats = await call('GET', '/api/stats?range=all&tz=UTC');
    expect(stats.status).toBe(200);
  });

  it('delete all images removes image threads and their images only', async () => {
    const { call, db } = await seed();
    expect((await del(call, 'images')).status).toBe(200);
    expect(kinds(db)).toEqual(['chat', 'video']);
    expect(count(db, "SELECT count(*) AS n FROM attachments WHERE kind = 'image'")).toBe(0);
    expect(count(db, "SELECT count(*) AS n FROM attachments WHERE kind = 'text'")).toBe(1);
  });

  it('delete all videos removes clip files and finished job rows', async () => {
    const { call, db, deps } = await seed();
    expect((await del(call, 'videos')).status).toBe(200);
    expect(kinds(db)).toEqual(['chat', 'image']);
    expect(readdirSync(deps.mediaDir).filter((f) => f.endsWith('.mp4'))).toEqual([]);
    expect(count(db, 'SELECT count(*) AS n FROM video_jobs')).toBe(0);
    expect(count(db, 'SELECT count(*) AS n FROM media_events')).toBe(1);
  });

  it('refuses to delete videos or reset while a clip is rendering', async () => {
    const { call, db, video, deps } = await seed();
    db.prepare(
      `INSERT INTO video_jobs (job_id, thread_id, message_id, model_id, settings, polling_url, started_at, next_poll_at)
       VALUES ('job-2', ?, ?, 'v/m', '{}', 'u', 1, 1)`,
    ).run(video.id, video.reply.id);
    for (const target of ['videos', 'all']) {
      const res = await del(call, target);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toMatch(/still rendering/);
    }
    expect(kinds(db)).toEqual(['chat', 'image', 'video']);
    expect(existsSync(join(deps.mediaDir, `${video.reply.id}.mp4`))).toBe(true);
  });

  it('delete all my data returns OpenChat to a fresh install', async () => {
    const { call, db, deps } = await seed();
    db.prepare("INSERT INTO models (id, display_name, added_at) VALUES ('m/a', 'A', 1)").run();
    db.prepare("INSERT INTO media_models (id, kind, display_name, added_at) VALUES ('i/a', 'image', 'I', 1)").run();
    setSetting(db, 'theme', 'dark');
    const res = await del(call, 'all');
    expect(res.status).toBe(200);
    for (const table of ['chats', 'messages', 'attachments', 'memories', 'models', 'media_models', 'usage_events', 'media_events',
      'video_jobs', 'media_generations', 'model_catalog_cache', 'media_catalog_cache']) {
      expect(count(db, `SELECT count(*) AS n FROM ${table}`), table).toBe(0);
    }
    // Only the marker that stops the old-usage backfill from running again is kept.
    expect(db.prepare('SELECT key FROM settings').all()).toEqual([{ key: 'usage_backfill_done' }]);
    expect(readdirSync(deps.mediaDir)).toEqual([]);
    const settings = (await (await call('GET', '/api/settings')).json()) as { aboutMe: string; theme: string; apiKeySource: string };
    expect(settings).toMatchObject({ aboutMe: '', theme: 'system', apiKeySource: 'env' });
  });
});
