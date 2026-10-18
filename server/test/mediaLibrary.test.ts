import { describe, it, expect } from 'vitest';
import { makeApp } from './appHelpers';
import { listLibrary } from '../src/library';
import { addMediaModel, getMediaCatalog, listMediaLibrary, removeMediaModel } from '../src/mediaLibrary';
import type { ImageModel } from '../../shared/imageModels';
import type { VideoModel } from '../../shared/videoModels';
import type { ChatSummary } from '../../shared/types';

const img = (id: string, extra: Partial<ImageModel> = {}): ImageModel => ({
  id, name: id.toUpperCase(), description: '', created: null, aspects: ['1:1'], resolutions: ['1K'], qualities: [], transparent: false,
  maxRefs: 4, minRefs: 0, price: { kind: 'image', bySize: { '1k': 0.04 } }, ...extra,
});

const event = (db: ReturnType<typeof makeApp>['db'], o: { model: string; cost: number; status?: string; size?: string; quality?: string | null; thread?: string }) =>
  db.prepare('INSERT INTO media_events (created_at, kind, thread_id, model_id, settings, cost, status) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    Date.now(), 'image', o.thread ?? null, o.model, JSON.stringify({ aspect: '1:1', size: o.size ?? '1K', quality: o.quality ?? null, transparent: false }),
    o.cost, o.status ?? 'complete',
  );

describe('media catalog', () => {
  it('caches the image catalog and serves it stale when OpenRouter fails', async () => {
    let calls = 0;
    let fail = false;
    const { db, openrouter } = { ...makeApp(), openrouter: { listImageModels: async () => { calls++; if (fail) throw new Error('down'); return [img('a/one')]; } } };
    const first = await getMediaCatalog(db, openrouter as never, 'image', false);
    expect(first).toMatchObject({ stale: false, models: [{ id: 'a/one' }] });
    await getMediaCatalog(db, openrouter as never, 'image', false);
    expect(calls).toBe(1);
    fail = true;
    expect(await getMediaCatalog(db, openrouter as never, 'image', true)).toMatchObject({ stale: true, models: [{ id: 'a/one' }] });
  });
});

describe('media library', () => {
  it('keeps image models apart from chat models', async () => {
    const { db } = makeApp({ listImageModels: async () => [img('g/banana')] });
    addMediaModel(db, 'image', img('g/banana'));
    expect(listLibrary(db)).toEqual([]);
    expect(listMediaLibrary(db, 'image').map((m) => [m.id, m.displayName, m.kind])).toEqual([['g/banana', 'G/BANANA', 'image']]);
    expect(listMediaLibrary(db, 'video')).toEqual([]);
    removeMediaModel(db, 'image', 'g/banana');
    expect(listMediaLibrary(db, 'image')).toEqual([]);
  });

  it('averages only completed generations, per size and quality', () => {
    const { db } = makeApp();
    addMediaModel(db, 'image', img('g/banana'));
    event(db, { model: 'g/banana', cost: 0.04 });
    event(db, { model: 'g/banana', cost: 0.06 });
    event(db, { model: 'g/banana', cost: 0, status: 'error' });
    event(db, { model: 'g/banana', cost: 0.2, size: '2K', quality: 'high' });
    expect(listMediaLibrary(db, 'image')[0].avgCost).toEqual({ '1K|': 0.05, '2K|high': 0.2 });
  });

  it('adds through the API only from the catalog', async () => {
    const { call } = makeApp({ listImageModels: async () => [img('g/banana')] });
    expect((await call('POST', '/api/media-models', { id: 'g/banana', kind: 'image' })).status).toBe(201);
    expect((await call('POST', '/api/media-models', { id: 'nope/x', kind: 'image' })).status).toBe(400);
    const list = (await (await call('GET', '/api/media-models?kind=image')).json()) as { id: string; model: ImageModel | null }[];
    expect(list.map((m) => [m.id, m.model?.id])).toEqual([['g/banana', 'g/banana']]);
    expect((await call('DELETE', '/api/media-models?id=g%2Fbanana&kind=image')).status).toBe(200);
    expect((await call('GET', '/api/media-models/catalog?kind=image')).status).toBe(200);
    expect((await call('GET', '/api/media-models?kind=bogus')).status).toBe(400);
  });
});

describe('video models', () => {
  const vid = (id: string): VideoModel => ({
    id, name: id.toUpperCase(), description: '', created: null, durations: [4, 8], resolutions: ['720p'], aspects: ['16:9'], sizes: [],
    frames: { first: true, last: true }, sound: false, skus: { duration_seconds: '0.05' },
  });

  it('caches the video catalog, apart from images', async () => {
    const { db, call } = makeApp({ listVideoModels: async () => [vid('g/veo')], listImageModels: async () => [img('g/banana')] });
    const video = (await (await call('GET', '/api/media-models/catalog?kind=video')).json()) as { models: { id: string }[] };
    expect(video.models.map((m) => m.id)).toEqual(['g/veo']);
    const image = (await (await call('GET', '/api/media-models/catalog?kind=image')).json()) as { models: { id: string }[] };
    expect(image.models.map((m) => m.id)).toEqual(['g/banana']);
    expect(db.prepare('SELECT count(*) AS n FROM media_catalog_cache').get()).toEqual({ n: 2 });
  });

  it('keeps the video list apart and averages render time', async () => {
    const { db, call } = makeApp({ listVideoModels: async () => [vid('g/veo')] });
    expect((await call('POST', '/api/media-models', { id: 'g/veo', kind: 'video' })).status).toBe(201);
    expect(listMediaLibrary(db, 'image')).toEqual([]);
    db.prepare("INSERT INTO media_events (created_at, kind, model_id, settings, cost, duration_ms, status) VALUES (1, 'video', 'g/veo', '{}', 0.2, 120000, 'complete')").run();
    db.prepare("INSERT INTO media_events (created_at, kind, model_id, settings, cost, duration_ms, status) VALUES (2, 'video', 'g/veo', '{}', 0.2, 180000, 'complete')").run();
    expect(listMediaLibrary(db, 'video')[0]).toMatchObject({ id: 'g/veo', kind: 'video', avgRenderMs: 150000, recentRenderMs: [180000, 120000], model: { id: 'g/veo' } });
  });
});

describe('threads by kind', () => {
  it('lists each kind apart, and plain GET stays chats only', async () => {
    const { call } = makeApp();
    const chat = (await (await call('POST', '/api/chats')).json()) as ChatSummary;
    const image = (await (await call('POST', '/api/chats', { kind: 'image' })).json()) as ChatSummary;
    expect(image.kind).toBe('image');
    expect(((await (await call('GET', '/api/chats')).json()) as ChatSummary[]).map((c) => c.id)).toEqual([chat.id]);
    expect(((await (await call('GET', '/api/chats?kind=image')).json()) as ChatSummary[]).map((c) => c.id)).toEqual([image.id]);
    expect((await call('POST', '/api/chats', { kind: 'bogus' })).status).toBe(400);
  });

  it('totals include image spend, and a thread knows its thumbnail and whether it is busy', async () => {
    const { db, call } = makeApp();
    const image = (await (await call('POST', '/api/chats', { kind: 'image' })).json()) as ChatSummary;
    event(db, { model: 'g/banana', cost: 0.04, thread: image.id });
    const u = db.prepare("INSERT INTO messages (id, chat_id, parent_id, role, content, created_at) VALUES ('u1', ?, NULL, 'user', 'fox', 1)").run(image.id);
    db.prepare("INSERT INTO messages (id, chat_id, parent_id, role, content, status, created_at) VALUES ('a1', ?, 'u1', 'assistant', '', 'complete', 2)").run(image.id);
    db.prepare("INSERT INTO attachments (id, message_id, kind, filename, mime, size, data, created_at) VALUES ('img1', 'a1', 'image', 'fox.png', 'image/png', 1, x'00', 3)").run();
    db.prepare("INSERT INTO messages (id, chat_id, parent_id, role, content, status, created_at) VALUES ('a2', ?, 'u1', 'assistant', '', 'generating', 4)").run(image.id);
    db.prepare("INSERT INTO media_generations (message_id, kind, model_id, prompt, settings, mode, started_at) VALUES ('a2', 'image', 'g/banana', 'fox', '{}', 'new', 4)").run();
    expect(u.changes).toBe(1);
    const [summary] = (await (await call('GET', '/api/chats?kind=image')).json()) as ChatSummary[];
    expect(summary).toMatchObject({ totalCost: 0.04, thumbnailId: 'img1', busy: true });
  });
});
