import type { Deps } from './app';
import type { DB } from './db';
import { newId, now } from './db';
import { HttpError } from './http';
import { getAttachmentData, getAttachmentRow, insertGenerated, resolveAttachmentIds, attachToMessage, type AttachmentRow } from './attachments';
import { getChatRow, requireChat, setActiveLeaf, touchChat } from './chats';
import { getMessage, insertMessage } from './messages';
import { cachedMediaModel, getMediaCatalog, listMediaLibrary } from './mediaLibrary';
import { replyErrorMessage } from './generate';
import type { Usage } from './openrouter';
import { getSetting, resolveApiKey } from './settings';
import { maybeGenerateTitle } from './title';
import { jobErrorOf, jobStatusOf } from './videoJobs';
import { canGenerate, estimateImageCost, snapSettings, type ImageModel, type ImageSettings } from '../../shared/imageModels';
import { checkSpend } from './limits';
import { imageDataUrl, SVG_MIME } from './svg';
import type { ImageGeneration } from '../../shared/types';

export interface ImageRequest {
  prompt: string;
  modelId: string;
  settings: ImageSettings;
  /** The image to edit (any image in the thread); null for a new image. */
  targetAttachmentId: string | null;
  /** Photos uploaded with this message (pending attachments). */
  attachmentIds: string[];
  /** "Again": generate a new reply to this user message instead of sending a new one. */
  parentId?: string;
}

type Mode = ImageGeneration['mode'];

// Generations still running, so tests (and shutdown) can wait for them.
const running = new Set<Promise<void>>();

/** Resolves once every generation started so far has finished, including its title. */
export async function whenIdle(): Promise<void> {
  while (running.size) await Promise.all([...running]);
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'image';

const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', [SVG_MIME]: 'svg' };

function busy(db: DB, threadId: string): boolean {
  return !!db.prepare(
    'SELECT 1 FROM media_generations g JOIN messages m ON m.id = g.message_id WHERE m.chat_id = ? AND g.finished_at IS NULL',
  ).get(threadId);
}

/** An attachment that belongs to a message in this thread. */
function threadAttachment(db: DB, threadId: string, id: string): AttachmentRow {
  const row = getAttachmentRow(db, id);
  const owner = row?.messageId ? getMessage(db, row.messageId) : undefined;
  if (!row || row.kind !== 'image' || owner?.chatId !== threadId) throw new HttpError(400, 'That image is not in this thread.');
  return row;
}

function recordEvent(db: DB, e: {
  threadId: string; messageId: string | null; modelId: string; mode: Mode; settings: ImageSettings; usage: Usage | null;
  durationMs: number; status: 'complete' | 'error';
}): void {
  db.prepare(
    `INSERT INTO media_events (created_at, kind, thread_id, message_id, model_id, mode, settings, prompt_tokens, completion_tokens, cost,
       duration_ms, status)
     VALUES (?, 'image', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    now(), e.threadId, e.messageId, e.modelId, e.mode, JSON.stringify(e.settings), e.usage?.promptTokens ?? null,
    e.usage?.completionTokens ?? null, e.status === 'complete' ? e.usage?.cost ?? null : e.usage?.cost ?? 0, e.durationMs, e.status,
  );
}

/**
 * Saves the request and starts the call without waiting for it. The image is saved when it arrives even if the client
 * has gone, because it is paid for either way.
 */
export async function startImageGeneration(deps: Deps, threadId: string, req: ImageRequest): Promise<{ userMessageId: string; assistantMessageId: string }> {
  const { db, openrouter, env } = deps;
  const thread = requireChat(db, threadId);
  if (thread.kind !== 'image') throw new HttpError(400, 'This is not an image thread.');
  if (!listMediaLibrary(db, 'image').some((m) => m.id === req.modelId)) throw new HttpError(400, 'Add this model to your image models first.');
  const model = (cachedMediaModel(db, 'image', req.modelId)
    ?? (await getMediaCatalog(db, openrouter, 'image', false)).models.find((m) => m.id === req.modelId)) as ImageModel | undefined; // the image catalog holds only image models
  if (!model) throw new HttpError(400, 'That model is no longer offered by OpenRouter.');
  if (busy(db, threadId)) throw new HttpError(409, 'An image is still being made in this thread.');
  const { key } = resolveApiKey(db, env);
  if (!key) throw new HttpError(400, 'No OpenRouter API key set. Add one in Settings.');

  const parent = req.parentId ? getMessage(db, req.parentId) : undefined;
  if (req.parentId && (parent?.chatId !== threadId || parent.role !== 'user')) throw new HttpError(400, 'Message is not in this thread.');
  const uploads = parent ? [] : resolveAttachmentIds(db, req.attachmentIds ?? [], { editedMessageId: null });
  const prompt = String(req.prompt ?? '').trim();
  const photos = parent ? parent.attachments.length : uploads.length;
  if (!prompt && photos === 0) throw new HttpError(400, 'Describe the image, or attach a photo.');
  const target = req.targetAttachmentId ? threadAttachment(db, threadId, req.targetAttachmentId) : null;

  const refIds = [...new Set([...(target ? [target.id] : []), ...(parent ? parent.attachments.map((a) => a.id) : uploads.map((a) => a.id))])];
  const blocked = canGenerate(model, refIds.length);
  if (blocked) throw new HttpError(400, blocked);
  const settings = snapSettings(model, req.settings);
  checkSpend(db, { estimate: estimateImageCost(model, settings, null).cost });
  const uploadedRef = uploads.length > 0 || (parent?.attachments.length ?? 0) > 0
    || (target !== null && getMessage(db, target.messageId!)?.role === 'user');
  const mode: Mode = refIds.length === 0 ? 'new' : uploadedRef ? 'edit_upload' : 'edit_generated';

  const userMessage = parent ?? insertMessage(db, { chatId: threadId, parentId: thread.active_leaf_id, role: 'user', content: prompt });
  if (!parent) attachToMessage(db, userMessage.id, uploads);
  const assistantId = newId();
  insertMessage(db, { id: assistantId, chatId: threadId, parentId: userMessage.id, role: 'assistant', content: '', modelId: model.id, status: 'generating' });
  const startedAt = now();
  db.prepare(
    `INSERT INTO media_generations (message_id, kind, model_id, prompt, settings, target_attachment_id, reference_ids, mode, started_at)
     VALUES (?, 'image', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(assistantId, model.id, prompt || userMessage.content, JSON.stringify(settings), target?.id ?? null, JSON.stringify(refIds), mode, startedAt);
  setActiveLeaf(db, threadId, assistantId);
  touchChat(db, threadId);

  const references = refIds.map((id) => imageDataUrl(getAttachmentRow(db, id)!.mime, getAttachmentData(db, id) ?? Buffer.alloc(0)));
  const run = (async () => {
    const t0 = Date.now();
    let usage: Usage | null = null;
    try {
      const image = await openrouter.generateImage({ apiKey: key, model: model.id, prompt: prompt || userMessage.content, settings, references });
      usage = image.usage;
      const alive = !!getMessage(db, assistantId);
      recordEvent(db, { threadId, messageId: alive ? assistantId : null, modelId: model.id, mode, settings, usage, durationMs: Date.now() - t0, status: 'complete' });
      if (!alive) return;
      const n = (db.prepare(
        "SELECT count(*) AS n FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.chat_id = ? AND m.role = 'assistant'",
      ).get(threadId) as { n: number }).n + 1;
      insertGenerated(db, {
        messageId: assistantId, filename: `${slug(prompt || userMessage.content)}-${n}.${EXTENSIONS[image.mime] ?? 'png'}`, kind: 'image',
        mime: image.mime, data: image.data,
      });
      db.prepare("UPDATE messages SET status = 'complete', cost = ?, prompt_tokens = ?, completion_tokens = ? WHERE id = ?")
        .run(usage?.cost ?? null, usage?.promptTokens ?? null, usage?.completionTokens ?? null, assistantId);
      db.prepare('UPDATE media_generations SET finished_at = ? WHERE message_id = ?').run(now(), assistantId);
      touchChat(db, threadId);
      await maybeGenerateTitle(deps, threadId, key, getSetting(db, 'default_model_id') || model.id);
    } catch (err) {
      const message = replyErrorMessage(err);
      const alive = !!getChatRow(db, threadId) && !!getMessage(db, assistantId);
      recordEvent(db, { threadId, messageId: alive ? assistantId : null, modelId: model.id, mode, settings, usage, durationMs: Date.now() - t0, status: 'error' });
      if (!alive) return;
      db.prepare("UPDATE messages SET status = 'error' WHERE id = ?").run(assistantId);
      db.prepare('UPDATE media_generations SET error = ?, finished_at = ? WHERE message_id = ?').run(message, now(), assistantId);
    }
  })();
  running.add(run);
  void run.finally(() => running.delete(run));
  return { userMessageId: userMessage.id, assistantMessageId: assistantId };
}

/** Generations a server restart cut off. Nothing came back, so nothing was charged. */
export function failInterruptedGenerations(db: DB): number {
  const stuck = db.prepare("SELECT message_id FROM media_generations WHERE kind = 'image' AND finished_at IS NULL").all() as { message_id: string }[];
  for (const { message_id } of stuck) {
    db.prepare("UPDATE messages SET status = 'error' WHERE id = ?").run(message_id);
    db.prepare("UPDATE media_generations SET error = 'Interrupted. Not charged.', finished_at = ? WHERE message_id = ?").run(now(), message_id);
  }
  return stuck.length;
}

/** The generation behind each assistant message in the thread, for the thread view. */
export function threadGenerations(db: DB, threadId: string): Record<string, ImageGeneration> {
  const rows = db.prepare(
    `SELECT g.*, m.cost FROM media_generations g JOIN messages m ON m.id = g.message_id WHERE m.chat_id = ?`,
  ).all(threadId) as {
    message_id: string; model_id: string; settings: string; mode: Mode; error: string | null; started_at: number; finished_at: number | null;
    target_attachment_id: string | null; cost: number | null; prompt: string; kind: string; reference_ids: string;
  }[];
  return Object.fromEntries(rows.map((r) => {
    const g: ImageGeneration = {
      modelId: r.model_id, prompt: r.prompt, settings: JSON.parse(r.settings) as ImageSettings, mode: r.mode, error: r.error, startedAt: r.started_at,
      finishedAt: r.finished_at, targetAttachmentId: r.target_attachment_id, cost: r.cost,
    };
    if (r.kind === 'video') {
      // Video settings are VideoSettings; reference_ids holds [start photo, end photo].
      const [start = null, end = null] = JSON.parse(r.reference_ids) as (string | null)[];
      g.frames = { start, end };
      g.jobStatus = r.finished_at === null ? jobStatusOf(r.message_id) : null;
      g.jobError = r.finished_at === null ? jobErrorOf(r.message_id) : null;
    }
    return [r.message_id, g];
  }));
}
