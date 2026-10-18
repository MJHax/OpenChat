import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { Deps } from './app';
import type { DB } from './db';
import { newId, now as realNow } from './db';
import { HttpError } from './http';
import { attachToMessage, getAttachmentData, getAttachmentRow, type AttachmentRow } from './attachments';
import { getChatRow, requireChat, setActiveLeaf, touchChat } from './chats';
import { getMessage, insertMessage } from './messages';
import { cachedMediaModel, getMediaCatalog, listMediaLibrary } from './mediaLibrary';
import { OpenRouterError, type Usage } from './openrouter';
import { getSetting, resolveApiKey } from './settings';
import { maybeGenerateTitle } from './title';
import { buildVideoRequest, snapVideoSettings, videoPrice, type VideoModel, type VideoSettings } from '../../shared/videoModels';
import { BAD_ATTACHMENT } from '../../shared/attachments';

export interface VideoRequest {
  prompt: string;
  modelId: string;
  settings: VideoSettings;
  /** Pending uploads, or photos already in this thread (Tweak & retry). */
  startAttachmentId: string | null;
  endAttachmentId: string | null;
}

/** Every 30 s for the first half hour, then every 5 min, until OpenRouter gives a final status. Never gives up on its own. */
export const FAST_POLL_MS = 30_000;
export const SLOW_POLL_MS = 5 * 60_000;
export const SLOW_AFTER_MS = 30 * 60_000;
const FINAL = new Set(['completed', 'failed', 'cancelled', 'expired']);

const nextPoll = (startedAt: number, at: number) => at + (at - startedAt < SLOW_AFTER_MS ? FAST_POLL_MS : SLOW_POLL_MS);

export const clipPath = (mediaDir: string, messageId: string) => join(mediaDir, `${messageId}.mp4`);

const dataUrl = (row: AttachmentRow, db: DB) => `data:${row.mime};base64,${(getAttachmentData(db, row.id) ?? Buffer.alloc(0)).toString('base64')}`;

/** A photo for a frame slot: a pending upload, or an image already on a message in this thread. */
function framePhoto(db: DB, threadId: string, id: string | null): AttachmentRow | null {
  if (!id) return null;
  const row = getAttachmentRow(db, id);
  const owner = row?.messageId ? getMessage(db, row.messageId) : undefined;
  if (!row || row.kind !== 'image' || (row.messageId !== null && owner?.chatId !== threadId)) throw new HttpError(400, BAD_ATTACHMENT);
  return row;
}

/**
 * Starts a video: submits the job to OpenRouter first (so a refused request leaves nothing behind), then saves the
 * prompt, its photos and a rendering reply. The poller finishes it.
 */
export async function startVideoGeneration(deps: Deps, threadId: string, req: VideoRequest): Promise<{ userMessageId: string; assistantMessageId: string }> {
  const { db, openrouter, env } = deps;
  const thread = requireChat(db, threadId);
  if (thread.kind !== 'video') throw new HttpError(400, 'This is not a video thread.');
  if (!listMediaLibrary(db, 'video').some((m) => m.id === req.modelId)) throw new HttpError(400, 'Add this model to your video models first.');
  const model = (cachedMediaModel(db, 'video', req.modelId)
    ?? (await getMediaCatalog(db, openrouter, 'video', false)).models.find((m) => m.id === req.modelId)) as VideoModel | undefined;
  if (!model) throw new HttpError(400, 'That model is no longer offered by OpenRouter.');
  const prompt = String(req.prompt ?? '').trim();
  if (!prompt) throw new HttpError(400, 'Describe what should happen in the clip.');
  if (db.prepare('SELECT 1 FROM video_jobs WHERE thread_id = ? AND finished_at IS NULL').get(threadId)) {
    throw new HttpError(409, 'A clip is still rendering in this thread.');
  }
  const start = framePhoto(db, threadId, req.startAttachmentId);
  const end = framePhoto(db, threadId, req.endAttachmentId);
  if (start && !model.frames.first) throw new HttpError(400, "This model can't start from a photo.");
  if (end && !model.frames.last) throw new HttpError(400, "This model can't end on a photo.");
  const { key } = resolveApiKey(db, env);
  if (!key) throw new HttpError(400, 'No OpenRouter API key set. Add one in Settings.');

  const settings = snapVideoSettings(model, req.settings);
  const body = buildVideoRequest(model, settings, prompt, { first: start && dataUrl(start, db), last: end && dataUrl(end, db) });
  let job: { jobId: string; pollingUrl: string };
  try {
    job = await openrouter.submitVideo({ apiKey: key, body });
  } catch (err) {
    if (err instanceof OpenRouterError) throw new HttpError(err.status >= 400 && err.status < 500 ? 400 : 502, err.message);
    throw err;
  }

  const user = insertMessage(db, { chatId: threadId, parentId: thread.active_leaf_id, role: 'user', content: prompt });
  const photos = [start, end].filter((a): a is AttachmentRow => a !== null);
  attachToMessage(db, user.id, photos);
  const attached = getMessage(db, user.id)!.attachments;
  const frames = { start: start ? attached[0].id : null, end: end ? attached[start ? 1 : 0].id : null };
  const assistantId = newId();
  insertMessage(db, { id: assistantId, chatId: threadId, parentId: user.id, role: 'assistant', content: '', modelId: model.id, status: 'generating' });
  const startedAt = Date.now();
  db.prepare(
    `INSERT INTO media_generations (message_id, kind, model_id, prompt, settings, reference_ids, mode, job_id, started_at)
     VALUES (?, 'video', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(assistantId, model.id, prompt, JSON.stringify(settings), JSON.stringify([frames.start, frames.end]), photos.length ? 'edit_upload' : 'new', job.jobId, startedAt);
  db.prepare(
    `INSERT INTO video_jobs (job_id, thread_id, message_id, model_id, settings, photos, polling_url, started_at, next_poll_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(job.jobId, threadId, assistantId, model.id, JSON.stringify(settings), photos.length, job.pollingUrl, startedAt, startedAt + FAST_POLL_MS);
  setActiveLeaf(db, threadId, assistantId);
  touchChat(db, threadId);
  return { userMessageId: user.id, assistantMessageId: assistantId };
}

interface JobRow {
  job_id: string; thread_id: string | null; message_id: string; model_id: string; settings: string; photos: number; polling_url: string;
  started_at: number; next_poll_at: number;
}

function recordEvent(db: DB, j: JobRow, o: { alive: boolean; usage: Usage | null; cost: number | null; estimated: boolean; status: 'complete' | 'error'; at: number }) {
  const settings = JSON.parse(j.settings) as VideoSettings;
  db.prepare(
    `INSERT INTO media_events (created_at, kind, thread_id, message_id, model_id, mode, settings, cost, cost_estimated, seconds, duration_ms, status)
     VALUES (?, 'video', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    realNow(), j.thread_id, o.alive ? j.message_id : null, j.model_id, j.photos ? 'edit_upload' : 'new', j.settings, o.cost, o.estimated ? 1 : 0,
    o.status === 'complete' ? settings.duration : null, Math.max(0, o.at - j.started_at), o.status,
  );
}

/** Polls every unfinished video job that is due; `now` and the timer are injectable for tests. */
export function createVideoPoller(deps: Deps, opts: { now?: () => number; intervalMs?: number } = {}) {
  const { db, openrouter, env } = deps;
  const clock = opts.now ?? Date.now;
  let timer: ReturnType<typeof setInterval> | null = null;
  let busy = false;

  async function finish(j: JobRow, key: string, status: string, error: string | null, usage: Usage | null, at: number): Promise<void> {
    const alive = !!getMessage(db, j.message_id) && !!(j.thread_id && getChatRow(db, j.thread_id));
    if (status === 'completed') {
      mkdirSync(deps.mediaDir, { recursive: true });
      const part = `${clipPath(deps.mediaDir, j.message_id)}.part`;
      // A failed download leaves the job due again: the clip is paid for and must not be lost.
      const stream = await openrouter.downloadVideo({ apiKey: key, jobId: j.job_id });
      await pipeline(Readable.fromWeb(stream as WebReadableStream<Uint8Array>), createWriteStream(part));
      const model = cachedMediaModel(db, 'video', j.model_id) as VideoModel | null;
      const estimate = model ? videoPrice(model, JSON.parse(j.settings) as VideoSettings, j.photos).cost : null;
      const cost = usage?.cost ?? estimate;
      recordEvent(db, j, { alive, usage, cost, estimated: usage?.cost == null, status: 'complete', at });
      db.prepare('UPDATE video_jobs SET finished_at = ? WHERE job_id = ?').run(at, j.job_id);
      if (!alive) { rmSync(part, { force: true }); return; }
      renameSync(part, clipPath(deps.mediaDir, j.message_id));
      db.prepare("UPDATE messages SET status = 'complete', cost = ? WHERE id = ?").run(cost, j.message_id);
      db.prepare('UPDATE media_generations SET finished_at = ? WHERE message_id = ?').run(at, j.message_id);
      touchChat(db, j.thread_id!);
      await maybeGenerateTitle(deps, j.thread_id!, key, getSetting(db, 'default_model_id') || j.model_id);
      return;
    }
    recordEvent(db, j, { alive, usage, cost: usage?.cost ?? 0, estimated: false, status: 'error', at });
    db.prepare('UPDATE video_jobs SET finished_at = ? WHERE job_id = ?').run(at, j.job_id);
    if (!alive) return;
    db.prepare("UPDATE messages SET status = 'error', cost = ? WHERE id = ?").run(usage?.cost ?? 0, j.message_id);
    db.prepare('UPDATE media_generations SET error = ?, finished_at = ? WHERE message_id = ?')
      .run(error ?? (status === 'expired' ? 'The job expired before it finished.' : `The job was ${status}.`), at, j.message_id);
  }

  async function tick(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const at = clock();
      const due = db.prepare('SELECT * FROM video_jobs WHERE finished_at IS NULL AND next_poll_at <= ?').all(at) as JobRow[];
      const { key } = resolveApiKey(db, env);
      if (!key) return;
      for (const j of due) {
        db.prepare('UPDATE video_jobs SET next_poll_at = ? WHERE job_id = ?').run(nextPoll(j.started_at, at), j.job_id);
        try {
          const job = await openrouter.getVideoJob({ apiKey: key, jobId: j.job_id, pollingUrl: j.polling_url });
          setJobStatus(j.message_id, job.status);
          if (FINAL.has(job.status)) await finish(j, key, job.status, job.error, job.usage, at);
        } catch (err) {
          console.error(`Video job ${j.job_id}: ${(err as Error).message}`); // tried again on the next poll
        }
      }
    } finally {
      busy = false;
    }
  }

  return {
    tick,
    /** Checks every unfinished job at once (resuming after a restart), then keeps polling. */
    start() {
      db.prepare('UPDATE video_jobs SET next_poll_at = ? WHERE finished_at IS NULL').run(clock());
      void tick();
      timer = setInterval(() => void tick(), opts.intervalMs ?? 15_000);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

// Latest status from OpenRouter per rendering message, for the thread view ("pending", "in_progress").
const statuses = new Map<string, string>();
const setJobStatus = (messageId: string, status: string) => statuses.set(messageId, status);
export const jobStatusOf = (messageId: string): string | null => statuses.get(messageId) ?? null;

/** Removes the clip files of a thread's messages (called before the thread is deleted). */
export function deleteThreadClips(deps: Deps, threadId: string): void {
  const ids = deps.db.prepare('SELECT id FROM messages WHERE chat_id = ?').all(threadId) as { id: string }[];
  for (const { id } of ids) {
    const file = clipPath(deps.mediaDir, id);
    if (existsSync(file)) rmSync(file, { force: true });
  }
}
