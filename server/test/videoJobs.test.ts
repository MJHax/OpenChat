import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { makeApp } from './appHelpers';
import { OpenRouterError, type OpenRouterClient, type Usage } from '../src/openrouter';
import { addMediaModel } from '../src/mediaLibrary';
import { insertPending } from '../src/attachments';
import { createVideoPoller } from '../src/videoJobs';
import type { VideoModel, VideoSettings } from '../../shared/videoModels';
import type { ChatDetail, ChatSummary } from '../../shared/types';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const CLIP = Buffer.from('fake mp4 bytes 0123456789');
const SETTINGS: VideoSettings = { duration: 4, resolution: '720p', aspect: '16:9', sound: false };
const veo: VideoModel = {
  id: 'g/veo', name: 'Veo', description: '', created: null, durations: [4, 6, 8], resolutions: ['720p'], aspects: ['16:9', '9:16'], sizes: [],
  frames: { first: true, last: true }, sound: true, skus: { duration_seconds_without_audio_720p: '0.03', duration_seconds_with_audio_720p: '0.05' },
};
const usage = (cost: number): Usage => ({ promptTokens: null, completionTokens: null, cost, webSearches: null, cachedTokens: null, cacheWriteTokens: null, reasoningTokens: null, loadMs: null, generationMs: null });
const MIN = 60_000;

/** An app with Veo in the video list and a scripted job; `job.status` etc. can be changed between ticks. */
function setup() {
  const job = { status: 'pending', error: null as string | null, usage: null as Usage | null, downloadFails: false };
  const submitted: object[] = [];
  const polls: string[] = [];
  const client: Partial<OpenRouterClient> = {
    submitVideo: async ({ body }) => { submitted.push(body); return { jobId: `job-${submitted.length}`, pollingUrl: `/api/v1/videos/job-${submitted.length}` }; },
    getVideoJob: async ({ jobId }) => { polls.push(jobId); return { status: job.status, error: job.error, usage: job.usage }; },
    downloadVideo: async () => {
      if (job.downloadFails) throw new OpenRouterError('Could not reach OpenRouter.', 0);
      return new Response(CLIP).body!;
    },
    complete: async () => 'Cats on the couch',
  };
  const ctx = makeApp(client);
  ctx.db.prepare("INSERT INTO media_catalog_cache (kind, fetched_at, json) VALUES ('video', ?, ?)").run(Date.now(), JSON.stringify([veo]));
  addMediaModel(ctx.db, 'video', veo);
  let clock = Date.now(); // jobs record their real start time; the poller's clock moves on from there
  const poller = () => createVideoPoller(ctx.deps, { now: () => clock });
  const advance = (ms: number) => { clock += ms; };
  const thread = async () => ((await (await ctx.call('POST', '/api/chats', { kind: 'video' })).json()) as ChatSummary).id;
  const photo = (name = 'cat.png') => insertPending(ctx.db, { filename: name, kind: 'image', mime: 'image/png', data: PNG });
  const start = async (id: string, body: Record<string, unknown> = {}) =>
    ctx.call('POST', `/api/chats/${id}/videos`, { prompt: 'cats meet', modelId: 'g/veo', settings: SETTINGS, startAttachmentId: null, endAttachmentId: null, ...body });
  const detail = async (id: string) => (await (await ctx.call('GET', `/api/chats/${id}`)).json()) as ChatDetail;
  const events = () => ctx.db.prepare('SELECT * FROM media_events ORDER BY id').all() as Record<string, unknown>[];
  return { ...ctx, job, submitted, polls, poller, advance, now: () => clock, thread, photo, start, detail, events };
}

describe('video jobs', () => {
  it('completes and logs', async () => {
    const s = setup();
    const id = await s.thread();
    const first = s.photo('milo.png');
    const last = s.photo('luna.png');
    const res = await s.start(id, { startAttachmentId: first.id, endAttachmentId: last.id });
    expect(res.status).toBe(202);
    const { assistantMessageId } = (await res.json()) as { assistantMessageId: string };
    const p = s.poller();
    s.advance(31_000);
    s.job.status = 'completed';
    s.job.usage = usage(0.12);
    await p.tick();
    const d = await s.detail(id);
    expect(d.messages.find((m) => m.id === assistantMessageId)).toMatchObject({ status: 'complete', cost: 0.12 });
    expect(readFileSync(join(s.deps.mediaDir, `${assistantMessageId}.mp4`)).equals(CLIP)).toBe(true);
    expect(s.events()).toMatchObject([{ kind: 'video', status: 'complete', cost: 0.12, cost_estimated: 0, seconds: 4, thread_id: id, message_id: assistantMessageId }]);
    expect(d.messages.find((m) => m.role === 'user')!.attachments.map((a) => a.filename)).toEqual(['milo.png', 'luna.png']);
    expect((s.submitted[0] as { frame_images: { frame_type: string }[] }).frame_images.map((f) => f.frame_type)).toEqual(['first_frame', 'last_frame']);
    expect(d.chat.title).toBe('Cats on the couch');
  });

  it('estimates the cost when OpenRouter does not report it', async () => {
    const s = setup();
    const id = await s.thread();
    await s.start(id);
    const p = s.poller();
    s.advance(31_000);
    s.job.status = 'completed';
    await p.tick();
    expect(s.events()).toMatchObject([{ status: 'complete', cost_estimated: 1 }]);
    expect(s.events()[0].cost).toBeCloseTo(0.12);
  });

  it('tells the thread view its photos and job status', async () => {
    const s = setup();
    const id = await s.thread();
    const { assistantMessageId } = (await (await s.start(id, { startAttachmentId: s.photo().id })).json()) as { assistantMessageId: string };
    const p = s.poller();
    s.advance(31_000);
    s.job.status = 'in_progress';
    await p.tick();
    const d = await s.detail(id);
    const userPhoto = d.messages.find((m) => m.role === 'user')!.attachments[0].id;
    expect(d.generations[assistantMessageId]).toMatchObject({ frames: { start: userPhoto, end: null }, jobStatus: 'in_progress', settings: SETTINGS });
  });

  it('sends generate_audio false by default', async () => {
    const s = setup();
    await s.start(await s.thread());
    expect(s.submitted[0]).toMatchObject({ generate_audio: false, duration: 4, resolution: '720p', aspect_ratio: '16:9' });
  });

  it('failed job logs reason', async () => {
    const s = setup();
    const id = await s.thread();
    const { assistantMessageId } = (await (await s.start(id)).json()) as { assistantMessageId: string };
    const p = s.poller();
    s.advance(31_000);
    s.job.status = 'failed';
    s.job.error = 'Content blocked';
    await p.tick();
    const d = await s.detail(id);
    expect(d.messages.find((m) => m.id === assistantMessageId)!.status).toBe('error');
    expect(d.generations[assistantMessageId].error).toBe('Content blocked');
    expect(s.events()).toMatchObject([{ status: 'error', cost: 0 }]);
    expect((await s.start(id)).status).toBe(202); // the thread is free again
  });

  it('polls every 30 seconds, then slows to five minutes after thirty', async () => {
    const s = setup();
    await s.start(await s.thread());
    const p = s.poller();
    await p.tick();
    expect(s.polls).toHaveLength(0); // not due yet
    s.advance(31_000);
    await p.tick();
    expect(s.polls).toHaveLength(1);
    s.advance(31 * MIN);
    await p.tick();
    expect(s.polls).toHaveLength(2);
    s.advance(2 * MIN);
    await p.tick();
    expect(s.polls).toHaveLength(2); // slowed down
    s.advance(3 * MIN);
    await p.tick();
    expect(s.polls).toHaveLength(3);
  });

  it('never gives up on a render', async () => {
    const s = setup();
    const id = await s.thread();
    const { assistantMessageId } = (await (await s.start(id)).json()) as { assistantMessageId: string };
    const p = s.poller();
    for (let i = 0; i < 40; i++) { s.advance(5 * MIN); await p.tick(); }
    expect(s.polls.length).toBeGreaterThan(30);
    expect((await s.detail(id)).messages.find((m) => m.id === assistantMessageId)!.status).toBe('generating');
  });

  it('resumes after restart', async () => {
    const s = setup();
    const id = await s.thread();
    const { assistantMessageId } = (await (await s.start(id)).json()) as { assistantMessageId: string };
    s.advance(3 * 60 * MIN); // OpenChat was off for three hours
    s.job.status = 'completed';
    const fresh = s.poller();
    await fresh.tick();
    expect(existsSync(join(s.deps.mediaDir, `${assistantMessageId}.mp4`))).toBe(true);
    expect((await s.detail(id)).messages.find((m) => m.id === assistantMessageId)!.status).toBe('complete');
  });

  it('retries a failed download', async () => {
    const s = setup();
    const id = await s.thread();
    const { assistantMessageId } = (await (await s.start(id)).json()) as { assistantMessageId: string };
    const p = s.poller();
    s.advance(31_000);
    s.job.status = 'completed';
    s.job.downloadFails = true;
    await p.tick();
    expect((await s.detail(id)).messages.find((m) => m.id === assistantMessageId)!.status).toBe('generating');
    expect(s.events()).toEqual([]);
    s.job.downloadFails = false;
    s.advance(31_000);
    await p.tick();
    expect((await s.detail(id)).messages.find((m) => m.id === assistantMessageId)!.status).toBe('complete');
    expect(s.events()).toHaveLength(1);
  });

  it('gives up on a download that keeps failing for a day, and records it as paid', async () => {
    const s = setup();
    const id = await s.thread();
    const { assistantMessageId } = (await (await s.start(id)).json()) as { assistantMessageId: string };
    const p = s.poller();
    s.advance(31_000);
    s.job.status = 'completed';
    s.job.usage = usage(0.12);
    s.job.downloadFails = true;
    await p.tick(); // the first failed download
    for (let i = 0; i < 287; i++) { s.advance(5 * MIN); await p.tick(); } // 23 h 55 min later
    expect((await s.detail(id)).messages.find((m) => m.id === assistantMessageId)!.status).toBe('generating');
    expect(s.events()).toEqual([]);
    s.advance(5 * MIN);
    await p.tick();
    const d = await s.detail(id);
    expect(d.messages.find((m) => m.id === assistantMessageId)).toMatchObject({ status: 'error', cost: 0.12 });
    expect(d.generations[assistantMessageId].error).toMatch(/likely charged/);
    expect(s.events()).toMatchObject([{ status: 'complete', cost: 0.12, message_id: assistantMessageId }]);
    expect(existsSync(join(s.deps.mediaDir, `${assistantMessageId}.mp4`))).toBe(false);
    expect(existsSync(join(s.deps.mediaDir, `${assistantMessageId}.mp4.part`))).toBe(false);
    const polls = s.polls.length;
    s.advance(5 * MIN);
    await p.tick();
    expect(s.polls).toHaveLength(polls); // stopped trying
    s.job.downloadFails = false;
    expect((await s.start(id)).status).toBe(202); // the thread is free again
  });

  it('thread deleted mid-render', async () => {
    const s = setup();
    const id = await s.thread();
    const { assistantMessageId } = (await (await s.start(id)).json()) as { assistantMessageId: string };
    await s.call('DELETE', `/api/chats/${id}`);
    const p = s.poller();
    s.advance(31_000);
    s.job.status = 'completed';
    s.job.usage = usage(0.12);
    await p.tick();
    expect(s.events()).toMatchObject([{ status: 'complete', cost: 0.12, message_id: null, thread_id: id }]);
    expect(existsSync(join(s.deps.mediaDir, `${assistantMessageId}.mp4`))).toBe(false);
  });

  it('a thread deleted during the download leaves no clip behind', async () => {
    const s = setup();
    const id = await s.thread();
    const { assistantMessageId } = (await (await s.start(id)).json()) as { assistantMessageId: string };
    const deps = s.deps;
    const original = deps.openrouter.downloadVideo;
    deps.openrouter.downloadVideo = async (o) => { await s.call('DELETE', `/api/chats/${id}`); return original(o); };
    s.advance(31_000);
    s.job.status = 'completed';
    await s.poller().tick();
    expect(existsSync(join(s.deps.mediaDir, `${assistantMessageId}.mp4`))).toBe(false);
    expect(s.events()).toMatchObject([{ status: 'complete', message_id: null }]);
  });

  it('a clip that cannot be put in place is retried, not stuck', async () => {
    const s = setup();
    const id = await s.thread();
    const { assistantMessageId } = (await (await s.start(id)).json()) as { assistantMessageId: string };
    const target = join(s.deps.mediaDir, `${assistantMessageId}.mp4`);
    mkdirSync(target, { recursive: true }); // a directory in the way makes the rename fail
    const p = s.poller();
    s.advance(31_000);
    s.job.status = 'completed';
    await p.tick();
    expect((await s.detail(id)).messages.find((m) => m.id === assistantMessageId)!.status).toBe('generating');
    expect(s.events()).toEqual([]);
    rmSync(target, { recursive: true });
    s.advance(31_000);
    await p.tick();
    expect((await s.detail(id)).messages.find((m) => m.id === assistantMessageId)!.status).toBe('complete');
    expect(s.events()).toHaveLength(1);
  });

  it('shows why the last check failed while it keeps trying', async () => {
    const s = setup();
    const id = await s.thread();
    const { assistantMessageId } = (await (await s.start(id)).json()) as { assistantMessageId: string };
    s.advance(31_000);
    s.job.status = 'completed';
    s.job.downloadFails = true;
    await s.poller().tick();
    expect((await s.detail(id)).generations[assistantMessageId]).toMatchObject({ jobStatus: 'downloading', jobError: 'Could not reach OpenRouter.' });
  });

  it('a broken tick never rejects (it would crash the server)', async () => {
    const s = setup();
    s.db.exec('DROP TABLE video_jobs');
    await expect(s.poller().tick()).resolves.toBeUndefined();
  });

  it('rejects a second job while one renders, and frames the model cannot take', async () => {
    const s = setup();
    const id = await s.thread();
    expect((await s.start(id)).status).toBe(202);
    expect((await s.start(id)).status).toBe(409);
    const other = await s.thread();
    s.db.prepare("UPDATE media_models SET id = id WHERE kind = 'video'").run();
    const noEnd = { ...veo, id: 'x/grok', frames: { first: true, last: false } };
    s.db.prepare("UPDATE media_catalog_cache SET json = ? WHERE kind = 'video'").run(JSON.stringify([veo, noEnd]));
    addMediaModel(s.db, 'video', noEnd);
    const res = await s.start(other, { modelId: 'x/grok', startAttachmentId: s.photo().id, endAttachmentId: s.photo().id });
    expect(res.status).toBe(400);
    expect((await s.start(other, { prompt: '  ' })).status).toBe(400);
  });

  it('two simultaneous requests submit one clip', async () => {
    const s = setup();
    const id = await s.thread();
    const original = s.deps.openrouter.submitVideo;
    s.deps.openrouter.submitVideo = async (o) => { await new Promise((r) => setTimeout(r, 20)); return original(o); };
    const statuses = (await Promise.all([s.start(id), s.start(id)])).map((r) => r.status).sort();
    expect(statuses).toEqual([202, 409]);
    expect(s.submitted).toHaveLength(1);
  });

  it('a refused submit frees the thread', async () => {
    const s = setup();
    const id = await s.thread();
    const original = s.deps.openrouter.submitVideo;
    s.deps.openrouter.submitVideo = async () => { throw new OpenRouterError('nope', 400); };
    expect((await s.start(id)).status).toBe(400);
    expect((await s.start(id, { startAttachmentId: 'missing' })).status).toBe(400);
    s.deps.openrouter.submitVideo = original;
    expect((await s.start(id)).status).toBe(202);
  });

  it('tweak and retry reuses photos already in the thread', async () => {
    const s = setup();
    const id = await s.thread();
    const first = s.photo('milo.png');
    await s.start(id, { startAttachmentId: first.id });
    const p = s.poller();
    s.advance(31_000);
    s.job.status = 'completed';
    await p.tick();
    const userMsg = (await s.detail(id)).messages.find((m) => m.role === 'user')!;
    const again = await s.start(id, { prompt: 'cats meet, slowly', startAttachmentId: userMsg.attachments[0].id });
    expect(again.status).toBe(202);
    expect((s.submitted[1] as { frame_images: unknown[] }).frame_images).toHaveLength(1);
  });

  it('serves byte ranges', async () => {
    const s = setup();
    const id = await s.thread();
    const { assistantMessageId } = (await (await s.start(id)).json()) as { assistantMessageId: string };
    const p = s.poller();
    s.advance(31_000);
    s.job.status = 'completed';
    await p.tick();
    const full = await s.app.request(`/api/videos/${assistantMessageId}`);
    expect(full.status).toBe(200);
    expect(full.headers.get('Content-Type')).toBe('video/mp4');
    expect(full.headers.get('Accept-Ranges')).toBe('bytes');
    const part = await s.app.request(`/api/videos/${assistantMessageId}`, { headers: { Range: 'bytes=0-9' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('Content-Range')).toBe(`bytes 0-9/${CLIP.length}`);
    expect(Buffer.from(await part.arrayBuffer()).toString()).toBe(CLIP.subarray(0, 10).toString());
    expect((await s.app.request('/api/videos/nope')).status).toBe(404);
  });

  it('deleting a thread removes its clip files', async () => {
    const s = setup();
    const id = await s.thread();
    const { assistantMessageId } = (await (await s.start(id)).json()) as { assistantMessageId: string };
    const p = s.poller();
    s.advance(31_000);
    s.job.status = 'completed';
    await p.tick();
    const file = join(s.deps.mediaDir, `${assistantMessageId}.mp4`);
    expect(existsSync(file)).toBe(true);
    await s.call('DELETE', `/api/chats/${id}`);
    expect(existsSync(file)).toBe(false);
  });
});
