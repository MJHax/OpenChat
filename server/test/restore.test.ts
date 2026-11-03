import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { makeApp } from './appHelpers';
import { readZip } from './zipReader';
import { insertMessage } from '../src/messages';
import { getSetting, setSetting } from '../src/settings';
import { SCHEMA_VERSION } from '../src/db';
import { restoreBackup } from '../src/restore';
import { zipStream } from '../src/zip';
import { HttpError } from '../src/http';
import type { ChatSummary, ThreadKind } from '../../shared/types';

type App = ReturnType<typeof makeApp>;
const work = () => mkdtempSync(join(tmpdir(), 'openchat-restore-test-'));

async function thread(app: App, kind: ThreadKind, user: string, reply: string) {
  const id = ((await (await app.call('POST', '/api/chats', { kind })).json()) as ChatSummary).id;
  const u = insertMessage(app.db, { chatId: id, parentId: null, role: 'user', content: user });
  const r = insertMessage(app.db, { chatId: id, parentId: u.id, role: 'assistant', content: reply, modelId: 'm/a' });
  return { id, user: u, reply: r };
}

/** The app a backup is made from. */
async function source() {
  const app = makeApp();
  const chat = await thread(app, 'chat', 'Tell me about pineapples', 'Pineapples are tropical');
  const video = await thread(app, 'video', 'a fox', '');
  writeFileSync(join(app.deps.mediaDir, `${video.reply.id}.mp4`), Buffer.from('source clip'));
  await app.call('POST', '/api/memories', { content: 'Likes tea' });
  setSetting(app.db, 'about_me', 'From the laptop');
  setSetting(app.db, 'api_key', 'sk-or-source-0000000000');
  return { ...app, chat, video };
}

/** The app a backup is imported into, with data of its own. */
async function target() {
  const app = makeApp();
  const chat = await thread(app, 'chat', 'Mangoes?', 'Mangoes are sweet');
  writeFileSync(join(app.deps.mediaDir, '11111111-1111-1111-1111-111111111111.mp4'), Buffer.from('target clip'));
  setSetting(app.db, 'api_key', 'sk-or-target-1111111111');
  setSetting(app.db, 'tavily_api_key', 'tvly-target');
  return { ...app, chat };
}

async function exportOf(app: App): Promise<string> {
  const file = join(work(), 'export.zip');
  writeFileSync(file, Buffer.from(await (await app.call('GET', '/api/data/export')).arrayBuffer()));
  return file;
}

async function writeZip(files: Map<string, Buffer>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const c of zipStream([...files].map(([name, data]) => ({ name, data: () => [data] })))) chunks.push(c);
  const file = join(work(), 'edited.zip');
  writeFileSync(file, Buffer.concat(chunks));
  return file;
}

const chatIds = (app: App) => (app.db.prepare('SELECT id FROM chats ORDER BY id').all() as { id: string }[]).map((r) => r.id);
const snapshot = (app: App) => ({
  chats: chatIds(app),
  keys: [getSetting(app.db, 'api_key'), getSetting(app.db, 'tavily_api_key')],
  clips: readdirSync(app.deps.mediaDir).sort(),
  siblings: readdirSync(dirname(app.deps.mediaDir)).filter((f) => f.startsWith(`${app.deps.mediaDir.split(/[\\/]/).pop()}.`)),
});
const search = async (app: App, q: string) => (await (await app.call('GET', `/api/search?q=${q}`)).json()) as unknown[];

async function expectRefused(app: App, zip: string, message: RegExp) {
  const before = snapshot(app);
  const err = await restoreBackup(app.deps, zip).then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(HttpError);
  expect((err as HttpError).message).toMatch(message);
  expect(snapshot(app)).toEqual(before);
}

describe('restoreBackup', () => {
  it('replaces everything with the backup', async () => {
    const src = await source();
    const dst = await target();
    await restoreBackup(dst.deps, await exportOf(src));
    expect(chatIds(dst)).toEqual(chatIds(src));
    expect((dst.db.prepare('SELECT content FROM memories').all() as { content: string }[]).map((r) => r.content)).toEqual(['Likes tea']);
    expect(getSetting(dst.db, 'about_me')).toBe('From the laptop');
    expect(readdirSync(dst.deps.mediaDir)).toEqual([`${src.video.reply.id}.mp4`]);
    expect(readFileSync(join(dst.deps.mediaDir, `${src.video.reply.id}.mp4`)).toString()).toBe('source clip');
  });

  it("keeps this instance's keys", async () => {
    const src = await source();
    const dst = await target();
    await restoreBackup(dst.deps, await exportOf(src));
    expect(getSetting(dst.db, 'api_key')).toBe('sk-or-target-1111111111');
    expect(getSetting(dst.db, 'tavily_api_key')).toBe('tvly-target');
  });

  it('search finds restored messages and not old ones', async () => {
    const src = await source();
    const dst = await target();
    await restoreBackup(dst.deps, await exportOf(src));
    expect((await search(dst, 'pineapples')).length).toBeGreaterThan(0);
    expect(await search(dst, 'mangoes')).toEqual([]);
  });

  it('importing twice gives the same result', async () => {
    const src = await source();
    const dst = await target();
    const zip = await exportOf(src);
    await restoreBackup(dst.deps, zip);
    const count = () => (dst.db.prepare('SELECT count(*) AS n FROM messages').get() as { n: number }).n;
    const first = { messages: count(), hits: (await search(dst, 'pineapples')).length };
    await restoreBackup(dst.deps, zip);
    expect({ messages: count(), hits: (await search(dst, 'pineapples')).length }).toEqual(first);
  });

  it('marks unfinished work in the backup as interrupted', async () => {
    const src = await source();
    const image = await thread(src, 'image', 'a cat', '');
    src.db.prepare(
      `INSERT INTO media_generations (message_id, kind, model_id, prompt, settings, mode, started_at) VALUES (?, 'image', 'g/b', 'a cat', '{}', 'new', 1)`,
    ).run(image.reply.id);
    src.db.prepare(
      `INSERT INTO media_generations (message_id, kind, model_id, prompt, settings, mode, job_id, started_at) VALUES (?, 'video', 'v/m', 'a fox', '{}', 'new', 'job-1', 1)`,
    ).run(src.video.reply.id);
    src.db.prepare(
      `INSERT INTO video_jobs (job_id, thread_id, message_id, model_id, settings, polling_url, started_at, next_poll_at) VALUES ('job-1', ?, ?, 'v/m', '{}', 'u', 1, 1)`,
    ).run(src.video.id, src.video.reply.id);
    const zip = await exportOf(src);
    const dst = await target();
    await restoreBackup(dst.deps, zip);
    const status = (id: string) => (dst.db.prepare('SELECT status FROM messages WHERE id = ?').get(id) as { status: string }).status;
    expect(status(image.reply.id)).toBe('error');
    expect(status(src.video.reply.id)).toBe('error');
    expect(dst.db.prepare('SELECT 1 FROM video_jobs WHERE finished_at IS NULL').get()).toBeUndefined();
    expect((dst.db.prepare('SELECT error FROM media_generations WHERE message_id = ?').get(src.video.reply.id) as { error: string }).error)
      .toBe('Interrupted by a restore. The clip may still finish on the OpenChat this backup came from.');
    expect(dst.db.prepare('SELECT count(*) AS n FROM media_events').get()).toEqual({ n: 0 });
  });

  it('refuses an export with no backup inside', async () => {
    const dst = await target();
    const zip = await writeZip(new Map([['openchat-export/data.json', Buffer.from('{}')]]));
    await expectRefused(dst, zip, /isn't an OpenChat backup/);
  });

  it('refuses a newer backup', async () => {
    const files = readZip(readFileSync(await exportOf(await source())));
    const name = 'openchat-export/backup/manifest.json';
    files.set(name, Buffer.from(JSON.stringify({ ...JSON.parse(files.get(name)!.toString()), schemaVersion: SCHEMA_VERSION + 1 })));
    await expectRefused(await target(), await writeZip(files), /Update this OpenChat first/);
  });

  it('imports an older backup', async () => {
    const src = await source();
    const files = readZip(readFileSync(await exportOf(src)));
    const name = 'openchat-export/backup/openchat.db';
    const file = join(work(), 'old.db');
    writeFileSync(file, files.get(name)!);
    const old = new Database(file);
    old.pragma('user_version = 0');
    old.close();
    files.set(name, readFileSync(file));
    const dst = await target();
    await restoreBackup(dst.deps, await writeZip(files));
    expect(chatIds(dst)).toEqual(chatIds(src));
  });

  it('refuses a truncated zip', async () => {
    const zip = await exportOf(await source());
    const bytes = readFileSync(zip);
    writeFileSync(zip, bytes.subarray(0, Math.floor(bytes.length / 2)));
    await expectRefused(await target(), zip, /damaged or incomplete/);
  });

  it('refuses a clip name that leaves the folder', async () => {
    const files = readZip(readFileSync(await exportOf(await source())));
    files.set('openchat-export/backup/clips/../../x.mp4', Buffer.from('evil'));
    const dst = await target();
    await expectRefused(dst, await writeZip(files), /damaged or incomplete/);
    expect(existsSync(join(dirname(dst.deps.mediaDir), 'x.mp4'))).toBe(false);
  });

  it('refuses while a clip renders', async () => {
    const zip = await exportOf(await source());
    const dst = await target();
    dst.db.prepare(
      `INSERT INTO video_jobs (job_id, thread_id, message_id, model_id, settings, polling_url, started_at, next_poll_at) VALUES ('job-9', 'x', 'y', 'v/m', '{}', 'u', 1, 1)`,
    ).run();
    await expectRefused(dst, zip, /clip is still rendering/);
  });
});
