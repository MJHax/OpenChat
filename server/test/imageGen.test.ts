import { describe, it, expect } from 'vitest';
import { makeApp } from './appHelpers';
import { OpenRouterError, type OpenRouterClient, type Usage } from '../src/openrouter';
import { addMediaModel } from '../src/mediaLibrary';
import { failInterruptedGenerations, whenIdle } from '../src/imageGen';
import { insertPending } from '../src/attachments';
import { loadUsageRows } from '../src/usage';
import type { ImageModel, ImageSettings } from '../../shared/imageModels';
import type { Attachment, ChatDetail, ChatSummary } from '../../shared/types';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const USAGE: Usage = { promptTokens: 20, completionTokens: 1290, cost: 0.039, webSearches: null, cachedTokens: null, cacheWriteTokens: null, reasoningTokens: null };
const SETTINGS: ImageSettings = { aspect: '1:1', size: '1K', quality: null, transparent: false };

const banana: ImageModel = {
  id: 'g/banana', name: 'Banana', description: '', created: null, aspects: ['1:1', '16:9'], resolutions: ['1K', '2K'], qualities: [],
  transparent: false, maxRefs: 4, minRefs: 0, price: { kind: 'token', perOutputToken: 0.00003, perInputImageToken: null },
};

type Call = Parameters<OpenRouterClient['generateImage']>[0];

/** An app with Banana in the image library; generateImage answers with `respond`, recording each request. */
function setup(respond: (call: Call) => Promise<Awaited<ReturnType<OpenRouterClient['generateImage']>>> = async () => ({ data: PNG, mime: 'image/png', usage: USAGE })) {
  const calls: Call[] = [];
  const titles: string[] = [];
  const ctx = makeApp({
    generateImage: (o) => { calls.push(o); return respond(o); },
    complete: async ({ messages }) => { titles.push(String(messages.at(-1)?.content)); return 'Fox picture'; },
  });
  ctx.db.prepare("INSERT INTO media_catalog_cache (kind, fetched_at, json) VALUES ('image', ?, ?)").run(Date.now(), JSON.stringify([banana]));
  addMediaModel(ctx.db, 'image', banana);
  const thread = async () => ((await (await ctx.call('POST', '/api/chats', { kind: 'image' })).json()) as ChatSummary).id;
  const generate = (id: string, body: Record<string, unknown>) =>
    ctx.call('POST', `/api/chats/${id}/images`, { modelId: 'g/banana', settings: SETTINGS, targetAttachmentId: null, attachmentIds: [], ...body });
  const detail = async (id: string) => (await (await ctx.call('GET', `/api/chats/${id}`)).json()) as ChatDetail;
  const events = () => ctx.db.prepare('SELECT * FROM media_events ORDER BY id').all() as Record<string, unknown>[];
  return { ...ctx, calls, titles, thread, generate, detail, events };
}

describe('image generation', () => {
  it('saves image and logs usage', async () => {
    const s = setup();
    const id = await s.thread();
    const res = await s.generate(id, { prompt: 'a fox in a field' });
    expect(res.status).toBe(202);
    const { assistantMessageId } = (await res.json()) as { assistantMessageId: string };
    await whenIdle();
    const d = await s.detail(id);
    const reply = d.messages.find((m) => m.id === assistantMessageId)!;
    expect(reply).toMatchObject({ status: 'complete', modelId: 'g/banana', cost: 0.039 });
    expect(reply.attachments).toMatchObject([{ kind: 'image', mime: 'image/png' }]);
    expect(d.generations[assistantMessageId]).toMatchObject({ modelId: 'g/banana', mode: 'new', error: null, settings: SETTINGS });
    expect(s.events()).toMatchObject([{ kind: 'image', thread_id: id, message_id: assistantMessageId, status: 'complete', cost: 0.039, mode: 'new', prompt_tokens: 20 }]);
    expect(s.calls[0]).toMatchObject({ model: 'g/banana', prompt: 'a fox in a field', references: [] });
  });

  it('edits the chosen attachment', async () => {
    const s = setup();
    const id = await s.thread();
    const first = (await (await s.generate(id, { prompt: 'a fox' })).json()) as { assistantMessageId: string };
    await whenIdle();
    const fox = (await s.detail(id)).messages.find((m) => m.id === first.assistantMessageId)!.attachments[0];
    const second = (await (await s.generate(id, { prompt: 'give it a hat', targetAttachmentId: fox.id })).json()) as { assistantMessageId: string };
    await whenIdle();
    expect(s.calls[1].references).toEqual([`data:image/png;base64,${PNG.toString('base64')}`]);
    expect((await s.detail(id)).generations[second.assistantMessageId]).toMatchObject({ mode: 'edit_generated', targetAttachmentId: fox.id });
  });

  it('uploaded photo makes edit_upload', async () => {
    const s = setup();
    const id = await s.thread();
    const photo = insertPending(s.db, { filename: 'desk.png', kind: 'image', mime: 'image/png', data: PNG });
    const res = (await (await s.generate(id, { prompt: 'tidy it', attachmentIds: [photo.id] })).json()) as { userMessageId: string; assistantMessageId: string };
    await whenIdle();
    const d = await s.detail(id);
    expect(d.messages.find((m) => m.id === res.userMessageId)!.attachments.map((a) => a.filename)).toEqual(['desk.png']);
    expect(s.calls[0].references).toHaveLength(1);
    expect(d.generations[res.assistantMessageId].mode).toBe('edit_upload');
  });

  it('rejects a second generation while one runs', async () => {
    let release!: () => void;
    const s = setup(() => new Promise((resolve) => { release = () => resolve({ data: PNG, mime: 'image/png', usage: USAGE }); }));
    const id = await s.thread();
    expect((await s.generate(id, { prompt: 'one' })).status).toBe(202);
    const summary = ((await (await s.call('GET', '/api/chats?kind=image')).json()) as ChatSummary[])[0];
    expect(summary.busy).toBe(true);
    expect((await s.generate(id, { prompt: 'two' })).status).toBe(409);
    release();
    await whenIdle();
    expect((await s.generate(id, { prompt: 'two' })).status).toBe(202);
    release();
    await whenIdle();
  });

  it('failure unlocks and logs zero cost', async () => {
    const s = setup(async () => { throw new OpenRouterError('Content was blocked.', 502); });
    const id = await s.thread();
    const { assistantMessageId } = (await (await s.generate(id, { prompt: 'x' })).json()) as { assistantMessageId: string };
    await whenIdle();
    const d = await s.detail(id);
    expect(d.messages.find((m) => m.id === assistantMessageId)!.status).toBe('error');
    expect(d.generations[assistantMessageId]).toMatchObject({ error: 'Content was blocked.' });
    expect(d.generations[assistantMessageId].finishedAt).not.toBeNull();
    expect(s.events()).toMatchObject([{ status: 'error', cost: 0 }]);
    expect((await s.generate(id, { prompt: 'again' })).status).toBe(202);
    await whenIdle();
  });

  it('thread deleted mid-generation', async () => {
    let release!: () => void;
    const s = setup(() => new Promise((resolve) => { release = () => resolve({ data: PNG, mime: 'image/png', usage: USAGE }); }));
    const id = await s.thread();
    await s.generate(id, { prompt: 'x' });
    await s.call('DELETE', `/api/chats/${id}`);
    release();
    await whenIdle();
    expect(s.events()).toMatchObject([{ status: 'complete', cost: 0.039, message_id: null, thread_id: id }]);
  });

  it('startup marks generating as error', async () => {
    // Stands in for a call the restart cut off; it's settled at the end only so later tests don't wait on it.
    let cutOff!: () => void;
    const s = setup(() => new Promise((_resolve, reject) => { cutOff = () => reject(new Error('process ended')); }));
    const id = await s.thread();
    const { assistantMessageId } = (await (await s.generate(id, { prompt: 'x' })).json()) as { assistantMessageId: string };
    expect(failInterruptedGenerations(s.db)).toBe(1);
    const d = await s.detail(id);
    expect(d.messages.find((m) => m.id === assistantMessageId)!.status).toBe('error');
    expect(d.generations[assistantMessageId].error).toBe('Interrupted. Not charged.');
    cutOff();
    await whenIdle();
  });

  it('photo-only thread is titled from the file name', async () => {
    const s = setup();
    const id = await s.thread();
    const photo = insertPending(s.db, { filename: 'IMG_2041.png', kind: 'image', mime: 'image/png', data: PNG });
    await s.generate(id, { prompt: '', attachmentIds: [photo.id] });
    await whenIdle();
    expect((await s.detail(id)).chat.title).toBe('IMG_2041 edit');
    expect(s.titles).toEqual([]);
  });

  it('titles from the first prompt, logged under images', async () => {
    const s = setup();
    const id = await s.thread();
    await s.generate(id, { prompt: 'a fox in a field' });
    await whenIdle();
    expect((await s.detail(id)).chat.title).toBe('Fox picture');
    expect(s.titles[0]).toContain('a fox in a field');
    expect(loadUsageRows(s.db, null).find((r) => r.purpose === 'title')).toMatchObject({ chatId: id });
    expect(s.db.prepare("SELECT thread_kind FROM usage_events WHERE purpose = 'title'").get()).toEqual({ thread_kind: 'image' });
  });

  it('Again regenerates as a sibling', async () => {
    const s = setup();
    const id = await s.thread();
    const first = (await (await s.generate(id, { prompt: 'a fox' })).json()) as { userMessageId: string; assistantMessageId: string };
    await whenIdle();
    const again = (await (await s.generate(id, { prompt: 'a fox', parentId: first.userMessageId })).json()) as { userMessageId: string; assistantMessageId: string };
    await whenIdle();
    expect(again.userMessageId).toBe(first.userMessageId);
    const d = await s.detail(id);
    expect(d.messages.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(d.messages.at(-1)).toMatchObject({ id: again.assistantMessageId, siblingIds: [first.assistantMessageId, again.assistantMessageId] });
  });

  it('checks what it is asked to do', async () => {
    const s = setup();
    const id = await s.thread();
    const chat = ((await (await s.call('POST', '/api/chats')).json()) as ChatSummary).id;
    expect((await s.generate(chat, { prompt: 'x' })).status).toBe(400);
    expect((await s.generate(id, { prompt: 'x', modelId: 'not/added' })).status).toBe(400);
    expect((await s.generate(id, { prompt: '' })).status).toBe(400);
    expect((await s.generate(id, { prompt: 'x', targetAttachmentId: 'nope' })).status).toBe(400);
    const many = Array.from({ length: 5 }, (_, i) => insertPending(s.db, { filename: `p${i}.png`, kind: 'image', mime: 'image/png', data: PNG }) as Attachment);
    const tooMany = await s.generate(id, { prompt: 'x', attachmentIds: many.map((a) => a.id) });
    expect(tooMany.status).toBe(400);
    expect(((await tooMany.json()) as { error: string }).error).toBe('This model accepts up to 4 images.');
  });
});
