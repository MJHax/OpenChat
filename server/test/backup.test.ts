import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { makeApp } from './appHelpers';
import { readZip } from './zipReader';
import { insertMessage } from '../src/messages';
import { setSetting } from '../src/settings';
import { SCHEMA_VERSION } from '../src/db';
import { backupEntries } from '../src/backup';
import { zipStream } from '../src/zip';
import type { ChatSummary } from '../../shared/types';

async function seed() {
  const ctx = makeApp();
  const { db, call, deps } = ctx;
  const t = (await (await call('POST', '/api/chats', { kind: 'video' })).json()) as ChatSummary;
  const user = insertMessage(db, { chatId: t.id, parentId: null, role: 'user', content: 'a fox' });
  const reply = insertMessage(db, { chatId: t.id, parentId: user.id, role: 'assistant', content: '', modelId: 'v/m' });
  writeFileSync(join(deps.mediaDir, `${reply.id}.mp4`), Buffer.from('clip bytes'));
  await call('POST', '/api/memories', { content: 'Likes tea' });
  setSetting(db, 'api_key', 'sk-or-stored-1234567890');
  setSetting(db, 'tavily_api_key', 'tvly-secret-987');
  return { ...ctx, chatId: t.id, clipId: reply.id };
}

async function exportZip(call: ReturnType<typeof makeApp>['call']): Promise<Buffer> {
  return Buffer.from(await (await call('GET', '/api/data/export')).arrayBuffer());
}

describe('backup in the export', () => {
  it('adds a backup with manifest, database and clips', async () => {
    const { call, clipId } = await seed();
    const files = readZip(await exportZip(call));
    const manifest = JSON.parse(files.get('openchat-export/backup/manifest.json')!.toString());
    expect(manifest).toMatchObject({ format: 'openchat-backup', formatVersion: 1, schemaVersion: SCHEMA_VERSION });
    expect(typeof manifest.createdAt).toBe('string');
    expect(files.has('openchat-export/backup/openchat.db')).toBe(true);
    expect(files.get(`openchat-export/backup/clips/${clipId}.mp4`)!.toString()).toBe('clip bytes');
  });

  it('the database copy holds the data', async () => {
    const { call, chatId } = await seed();
    const files = readZip(await exportZip(call));
    const file = join(mkdtempSync(join(tmpdir(), 'openchat-test-')), 'copy.db');
    writeFileSync(file, files.get('openchat-export/backup/openchat.db')!);
    const copy = new Database(file, { readonly: true });
    expect((copy.prepare('SELECT id FROM chats').all() as { id: string }[]).map((r) => r.id)).toEqual([chatId]);
    expect((copy.prepare('SELECT content FROM memories').get() as { content: string }).content).toBe('Likes tea');
    expect(copy.prepare("SELECT key FROM settings WHERE key IN ('api_key', 'tavily_api_key')").all()).toEqual([]);
    copy.close();
  });

  it('no key text anywhere in the zip', async () => {
    const { call } = await seed();
    const zip = await exportZip(call);
    expect(zip.includes('sk-or-stored-1234567890')).toBe(false);
    expect(zip.includes('tvly-secret-987')).toBe(false);
  });

  it('leaves no temp files behind', async () => {
    const { deps } = await seed();
    const work = mkdtempSync(join(tmpdir(), 'openchat-work-'));
    for await (const _ of zipStream(backupEntries(deps, work))) { /* drain */ }
    expect(readdirSync(work)).toEqual([]);
  });
});
