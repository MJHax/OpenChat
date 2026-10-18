import { describe, it, expect } from 'vitest';
import { makeApp, readEvents } from './appHelpers';
import type { OpenRouterClient, StreamEvent, Usage } from '../src/openrouter';
import { recordUsage } from '../src/usage';
import { saveLimits } from '../src/limits';
import { addMediaModel } from '../src/mediaLibrary';
import { insertMessage } from '../src/messages';
import { whenIdle } from '../src/imageGen';
import type { DB } from '../src/db';
import type { ImageModel, ImageSettings } from '../../shared/imageModels';
import type { VideoModel, VideoSettings } from '../../shared/videoModels';
import type { ChatSummary, ThreadKind } from '../../shared/types';

const usage = (cost: number): Usage => ({ promptTokens: 10, completionTokens: 5, cost, webSearches: null, cachedTokens: null, cacheWriteTokens: null, reasoningTokens: null });

function spend(db: DB, cost: number) {
  recordUsage(db, {
    purpose: 'reply', chatId: null, messageId: null, runId: null, kind: 'send', compare: false, modelId: 'm/x', usage: usage(cost),
    webSearch: false, webSearches: null, attachments: 0, firstTokenMs: null, durationMs: null, status: 'complete', createdAt: Date.now(),
  });
}

const limitTo = (db: DB, daily: number) => saveLimits(db, {
  daily: { enabled: true, amount: daily }, weekly: { enabled: false, amount: null }, monthly: { enabled: false, amount: null }, timeZone: 'UTC',
});

const banana: ImageModel = {
  id: 'g/banana', name: 'Banana', description: '', created: null, aspects: ['1:1'], resolutions: ['1K'], qualities: [],
  transparent: false, maxRefs: 4, minRefs: 0, price: { kind: 'token', perOutputToken: 0.00003, perInputImageToken: null }, // ~$0.0387 an image
};
const IMAGE_SETTINGS: ImageSettings = { aspect: '1:1', size: '1K', quality: null, transparent: false };
const veo: VideoModel = {
  id: 'g/veo', name: 'Veo', description: '', created: null, durations: [4], resolutions: ['720p'], aspects: ['16:9'], sizes: [],
  frames: { first: true, last: true }, sound: false, skus: { duration_seconds_without_audio_720p: '0.25' }, // $1.00 a 4 s clip
};
const VIDEO_SETTINGS: VideoSettings = { duration: 4, resolution: '720p', aspect: '16:9', sound: false };

function setup() {
  const counts = { stream: 0, complete: 0, image: 0, video: 0 };
  const client: Partial<OpenRouterClient> = {
    streamChat: async function* (): AsyncGenerator<StreamEvent> {
      counts.stream++;
      yield { type: 'delta', text: 'Hi' };
      yield { type: 'usage', usage: usage(2) };
    },
    complete: async () => { counts.complete++; return 'A title'; },
    generateImage: async () => { counts.image++; return { data: Buffer.from([1]), mime: 'image/png', usage: usage(0.04) }; },
    submitVideo: async () => { counts.video++; return { jobId: `job-${counts.video}`, pollingUrl: 'u' }; },
  };
  const ctx = makeApp(client);
  const { db, call } = ctx;
  for (const [kind, model] of [['image', banana], ['video', veo]] as const) {
    db.prepare('INSERT INTO media_catalog_cache (kind, fetched_at, json) VALUES (?, ?, ?)').run(kind, Date.now(), JSON.stringify([model]));
    addMediaModel(db, kind, model);
  }
  const thread = async (kind: ThreadKind = 'chat') => ((await (await call('POST', '/api/chats', { kind })).json()) as ChatSummary).id;
  const messages = (chatId: string) => (db.prepare('SELECT count(*) AS n FROM messages WHERE chat_id = ?').get(chatId) as { n: number }).n;
  return { ...ctx, counts, thread, messages };
}

const errorOf = async (res: Response) => ({ status: res.status, error: ((await res.json()) as { error: string }).error });

describe('spending limits on paid requests', () => {
  it('refuse send, compare, regenerate and edit once a limit is reached, saving nothing', async () => {
    const s = setup();
    const chatId = await s.thread();
    const user = insertMessage(s.db, { chatId, parentId: null, role: 'user', content: 'Earlier' });
    limitTo(s.db, 1);
    spend(s.db, 1);
    for (const [path, body] of [
      ['messages', { content: 'Hi', modelId: 'm/a' }],
      ['messages', { content: 'Hi', modelIds: ['m/a', 'm/b'] }],
      ['regenerate', { parentId: user.id, modelId: 'm/a' }],
      ['edit', { messageId: user.id, content: 'Changed', modelId: 'm/a' }],
    ] as const) {
      const res = await errorOf(await s.call('POST', `/api/chats/${chatId}/${path}`, body));
      expect(res.status, path).toBe(402);
      expect(res.error).toMatch(/^Daily spending limit reached \(\$1\.00\)\. It resets \w+day, \w+ \d+ at 12:00 AM\.$/);
    }
    expect(s.messages(chatId)).toBe(1);
    expect(s.counts.stream).toBe(0);
  });

  it('let a running reply finish even if it goes over, but skip the title', async () => {
    const s = setup();
    const chatId = await s.thread();
    limitTo(s.db, 1);
    const events = await readEvents(await s.call('POST', `/api/chats/${chatId}/messages`, { content: 'Hi', modelId: 'm/a' }));
    expect(events.map((e) => e.event)).toEqual(['start', 'delta', 'done']);
    expect(events[2].data.message).toMatchObject({ status: 'complete', cost: 2 });
    expect(s.counts.complete).toBe(0);
    // The next one is refused.
    expect((await s.call('POST', `/api/chats/${chatId}/messages`, { content: 'More', modelId: 'm/a' })).status).toBe(402);
  });

  it('refuse an image whose estimated price would go over, and allow one that fits', async () => {
    const s = setup();
    const id = await s.thread('image');
    limitTo(s.db, 0.05);
    spend(s.db, 0.02);
    const generate = () => s.call('POST', `/api/chats/${id}/images`, { prompt: 'a fox', modelId: 'g/banana', settings: IMAGE_SETTINGS, targetAttachmentId: null, attachmentIds: [] });
    const refused = await errorOf(await generate());
    expect(refused.status).toBe(402);
    expect(refused.error).toMatch(/^This costs about \$0\.039, more than the \$0\.03 left of your daily spending limit \(\$0\.05\)/);
    expect(s.messages(id)).toBe(0);
    limitTo(s.db, 0.1);
    expect((await generate()).status).toBe(202);
    await whenIdle();
    expect(s.counts.image).toBe(1);
  });

  it('check a video against its estimated price before submitting it', async () => {
    const s = setup();
    const id = await s.thread('video');
    limitTo(s.db, 1.5);
    spend(s.db, 0.6);
    const start = () => s.call('POST', `/api/chats/${id}/videos`, { prompt: 'waves', modelId: 'g/veo', settings: VIDEO_SETTINGS, startAttachmentId: null, endAttachmentId: null });
    const refused = await errorOf(await start());
    expect(refused.status).toBe(402);
    expect(refused.error).toMatch(/^This costs about \$1\.00, more than the \$0\.90 left/);
    expect(s.counts.video).toBe(0);
    limitTo(s.db, 2);
    expect((await start()).status).toBe(202);
    // The rendering clip's $1.00 now counts, so a second thread can't start another one.
    const other = await s.thread('video');
    const second = await s.call('POST', `/api/chats/${other}/videos`, { prompt: 'more waves', modelId: 'g/veo', settings: VIDEO_SETTINGS, startAttachmentId: null, endAttachmentId: null });
    expect(second.status).toBe(402);
    expect(s.counts.video).toBe(1);
  });

  it('give the Remember box a short message', async () => {
    const s = setup();
    s.db.prepare("INSERT INTO settings (key, value) VALUES ('default_model_id', 'm/a')").run();
    limitTo(s.db, 1);
    spend(s.db, 1);
    const res = await errorOf(await s.call('POST', '/api/memories/suggest', { text: 'I live in Oslo' }));
    expect(res).toEqual({ status: 402, error: 'Daily spending limit reached. Type the fact yourself.' });
    expect(s.counts.complete).toBe(0);
  });
});
