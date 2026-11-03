import { describe, it, expect } from 'vitest';
import { makeApp, readEvents } from './appHelpers';
import { busyReason, workSets } from '../src/activity';
import { whenIdle } from '../src/imageGen';
import { addMediaModel } from '../src/mediaLibrary';
import type { ImageModel } from '../../shared/imageModels';
import type { ChatSummary } from '../../shared/types';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const banana: ImageModel = {
  id: 'g/banana', name: 'Banana', description: '', created: null, aspects: ['1:1'], resolutions: ['1K'], qualities: [],
  transparent: false, maxRefs: 4, minRefs: 0, price: { kind: 'token', perOutputToken: 0.00003, perInputImageToken: null },
};

describe('busyReason', () => {
  it('is null when nothing is running', () => {
    expect(busyReason(makeApp().deps)).toBeNull();
  });

  it('names a streaming reply', () => {
    const { deps, db } = makeApp();
    workSets(db).replies.add('chat-1');
    expect(busyReason(deps)).toBe('A reply is still being written. Wait for it to finish, then import.');
  });

  it('a reply sent through the chat route counts until it finishes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { call, deps } = makeApp({
      streamChat: async function* () { await gate; yield { type: 'delta', text: 'Hi' }; },
      complete: async () => 'Title',
    });
    const chatId = ((await (await call('POST', '/api/chats')).json()) as ChatSummary).id;
    const res = await call('POST', `/api/chats/${chatId}/messages`, { content: 'Hi', modelId: 'openai/gpt-4o' });
    expect(busyReason(deps)).toBe('A reply is still being written. Wait for it to finish, then import.');
    release();
    await readEvents(res);
    expect(busyReason(deps)).toBeNull();
  });

  it('names a running discussion turn', () => {
    const { deps, db } = makeApp();
    workSets(db).turns.add('d-1');
    expect(busyReason(deps)).toBe('A discussion turn is still running. Wait for it to finish, then import.');
  });

  it('names an image being generated', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const ctx = makeApp({
      generateImage: async () => { await gate; return { data: PNG, mime: 'image/png', usage: null as never }; },
      complete: async () => 'Fox',
    });
    ctx.db.prepare("INSERT INTO media_catalog_cache (kind, fetched_at, json) VALUES ('image', ?, ?)").run(Date.now(), JSON.stringify([banana]));
    addMediaModel(ctx.db, 'image', banana);
    const id = ((await (await ctx.call('POST', '/api/chats', { kind: 'image' })).json()) as ChatSummary).id;
    const res = await ctx.call('POST', `/api/chats/${id}/images`, {
      modelId: 'g/banana', prompt: 'a fox', settings: { aspect: '1:1', size: '1K', quality: null, transparent: false }, targetAttachmentId: null, attachmentIds: [],
    });
    expect(res.status).toBe(202);
    expect(busyReason(ctx.deps)).toBe('An image is still being generated. Wait for it to finish, then import.');
    release();
    await whenIdle();
    expect(busyReason(ctx.deps)).toBeNull();
  });

  it('names an unfinished clip job, even one whose thread was deleted', () => {
    const { deps, db } = makeApp();
    db.prepare(
      `INSERT INTO video_jobs (job_id, thread_id, message_id, model_id, settings, polling_url, started_at, next_poll_at)
       VALUES ('job-1', 'gone', 'msg-gone', 'v/m', '{}', 'u', 1, 1)`,
    ).run();
    expect(busyReason(deps)).toBe('A clip is still rendering. It is already paid for, so wait for it to finish, then import.');
  });
});
