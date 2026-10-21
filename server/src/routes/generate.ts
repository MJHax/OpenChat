import { Hono, type Context } from 'hono';
import type { Deps } from '../app';
import { HttpError, readJson } from '../http';
import { pendingChoice, requireChat, setActiveLeaf, touchChat, type ChatRow } from '../chats';
import { getMessage, insertMessage } from '../messages';
import { attachToMessage, requireViewable, resolveAttachmentIds, type AttachmentRow } from '../attachments';
import { streamReply } from '../generate';
import { streamComparison } from '../compare';
import type { DB } from '../db';
import { EFFORTS, type Effort, type Message } from '../../../shared/types';
import type { ReplyKind } from '../usage';
import { checkSpend, spendBlock } from '../limits';
import { isLocalModelId } from '../../../shared/localModels';
import { contextOverflow, overflowMessage } from '../contextCheck';
import { loadedWindows } from '../providers';

const requireText = (value: unknown, error: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, error);
  return value;
};

const requireFlag = (value: unknown): boolean => {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new HttpError(400, 'webSearch must be true or false.');
  return value;
};

/** A reasoning effort, or undefined for the model's default. */
const requireEffort = (value: unknown): Effort | undefined => {
  if (value === undefined || value === null) return undefined;
  if (!EFFORTS.includes(value as Effort)) throw new HttpError(400, `effort must be one of ${EFFORTS.join(', ')}.`);
  return value as Effort;
};

/** Whether a local thinking model thinks; undefined leaves the model's default. */
const requireThinking = (value: unknown): boolean | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new HttpError(400, 'thinking must be true or false.');
  return value;
};

/** Message text, which may be empty when the message has attachments. */
const requireContent = (value: unknown, attachments: AttachmentRow[]): string => {
  if (attachments.length > 0 && (value === undefined || value === '' || (typeof value === 'string' && !value.trim()))) return '';
  return requireText(value, 'Message is empty.');
};

/** One model (`modelId`) or a comparison of 2–4 distinct models (`modelIds`). */
function requireModels(body: { modelId?: unknown; modelIds?: unknown }): string[] {
  if (body.modelIds === undefined) return [requireText(body.modelId, 'Pick a model first.')];
  if (body.modelId !== undefined) throw new HttpError(400, 'Send modelId or modelIds, not both.');
  if (!Array.isArray(body.modelIds) || body.modelIds.length < 2 || body.modelIds.length > 4) {
    throw new HttpError(400, 'Compare needs 2 to 4 models.');
  }
  const ids = body.modelIds.map((id) => (typeof id === 'string' ? id.trim() : ''));
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) throw new HttpError(400, 'Compare models must be different and non-empty.');
  return ids;
}

function requireUserMessage(db: DB, chatId: string, id: unknown): Message {
  const message = typeof id === 'string' ? getMessage(db, id) : undefined;
  if (!message || message.chatId !== chatId || message.role !== 'user') {
    throw new HttpError(400, 'That message is not a user message in this chat.');
  }
  return message;
}

export function generationRoutes(deps: Deps): Hono {
  const { db } = deps;
  const r = new Hono();
  // Chats with a reply currently streaming; a second generation would fork the tree mid-reply.
  const inFlight = new Set<string>();

  /**
   * Reserves the chat for one generation. A running generation wins over a pending choice (it sets that choice).
   * A reached spending limit refuses new OpenRouter work here, before anything is saved; work already running is never stopped.
   * Local models are free, so they never wait on it. A comparison mixing both returns the limit message for its OpenRouter slots.
   */
  function claim(chat: ChatRow, modelIds: string[]): string | undefined {
    const paid = modelIds.filter((id) => !isLocalModelId(id));
    if (paid.length === modelIds.length) checkSpend(db);
    const limitMessage = paid.length > 0 && paid.length < modelIds.length ? spendBlock(db)?.message : undefined;
    if (inFlight.has(chat.id)) throw new HttpError(409, 'A reply is still being generated in this chat. Wait for it to finish.');
    if (pendingChoice(db, chat)) throw new HttpError(409, 'Pick a reply to continue.');
    inFlight.add(chat.id);
    return limitMessage;
  }

  /**
   * Before anything is saved: the local models that can't hold the chat plus the new message. Refuses with the list
   * unless the user chose to send anyway, in which case those models' replies are marked as having lost context.
   * On a refusal the chat is released again.
   */
  async function checkOverflow(chatId: string, allowOverflow: unknown, o: Parameters<typeof contextOverflow>[1]): Promise<Set<string>> {
    try {
      if (allowOverflow !== undefined && typeof allowOverflow !== 'boolean') throw new HttpError(400, 'allowOverflow must be true or false.');
      const overflow = contextOverflow(db, { ...o, windows: await loadedWindows(deps, o.modelIds) });
      if (overflow.length && allowOverflow !== true) throw new HttpError(409, overflowMessage(overflow), { overflow });
      return new Set(overflow.map((x) => x.modelId));
    } catch (err) {
      inFlight.delete(chatId);
      throw err;
    }
  }

  function reply(c: Context, o: {
    chatId: string; parentId: string; modelIds: string[]; userMessageId: string | null; kind: ReplyKind; attachments: number;
    effort: Effort | undefined; thinking: boolean | undefined; droppedModelIds: Set<string>; limitMessage?: string;
  }): Response {
    const onFinish = () => inFlight.delete(o.chatId);
    try {
      if (o.modelIds.length === 1) {
        const { modelIds, ...rest } = o;
        return streamReply(c, deps, { ...rest, modelId: modelIds[0], onFinish });
      }
      return streamComparison(c, deps, { ...o, onFinish });
    } catch (err) {
      inFlight.delete(o.chatId);
      throw err;
    }
  }

  /** Saves a user message and its attachments together. */
  const saveUserMessage = db.transaction((chatId: string, parentId: string | null, content: string, attachments: AttachmentRow[], webSearch: boolean) => {
    const user = insertMessage(db, { chatId, parentId, role: 'user', content, webSearch });
    attachToMessage(db, user.id, attachments);
    return user;
  });

  r.post('/:id/messages', async (c) => {
    const chatId = c.req.param('id');
    const chat = requireChat(db, chatId);
    const body = await readJson<{ content?: string; modelId?: unknown; modelIds?: unknown; attachmentIds?: unknown; webSearch?: unknown; effort?: unknown; thinking?: unknown; allowOverflow?: unknown }>(c);
    const webSearch = requireFlag(body.webSearch);
    const effort = requireEffort(body.effort);
    const thinking = requireThinking(body.thinking);
    const attachments = resolveAttachmentIds(db, body.attachmentIds, { editedMessageId: null });
    const content = requireContent(body.content, attachments);
    const modelIds = requireModels(body);
    requireViewable(db, modelIds, attachments);
    const limitMessage = claim(chat, modelIds);
    const droppedModelIds = await checkOverflow(chatId, body.allowOverflow, { chatId, parentId: chat.active_leaf_id, newMessage: { content, attachments }, modelIds });
    const user = saveUserMessage(chatId, chat.active_leaf_id, content, attachments, webSearch);
    setActiveLeaf(db, chatId, user.id);
    touchChat(db, chatId);
    return reply(c, { chatId, parentId: user.id, modelIds, userMessageId: user.id, kind: 'send', attachments: attachments.length, effort, thinking, droppedModelIds, limitMessage });
  });

  r.post('/:id/regenerate', async (c) => {
    const chatId = c.req.param('id');
    const chat = requireChat(db, chatId);
    const body = await readJson<{ parentId?: string; modelId?: unknown; modelIds?: unknown; effort?: unknown; thinking?: unknown; allowOverflow?: unknown }>(c);
    const effort = requireEffort(body.effort);
    const thinking = requireThinking(body.thinking);
    const parent = requireUserMessage(db, chatId, body.parentId);
    const modelIds = requireModels(body);
    const limitMessage = claim(chat, modelIds);
    const droppedModelIds = await checkOverflow(chatId, body.allowOverflow, { chatId, parentId: parent.id, newMessage: null, modelIds });
    return reply(c, { chatId, parentId: parent.id, modelIds, userMessageId: null, kind: 'regenerate', attachments: 0, effort, thinking, droppedModelIds, limitMessage });
  });

  r.post('/:id/edit', async (c) => {
    const chatId = c.req.param('id');
    const chat = requireChat(db, chatId);
    const body = await readJson<{
      messageId?: string; content?: string; modelId?: unknown; modelIds?: unknown; attachmentIds?: unknown; webSearch?: unknown; effort?: unknown; thinking?: unknown; allowOverflow?: unknown;
    }>(c);
    const webSearch = requireFlag(body.webSearch);
    const effort = requireEffort(body.effort);
    const thinking = requireThinking(body.thinking);
    const original = requireUserMessage(db, chatId, body.messageId);
    const attachments = resolveAttachmentIds(db, body.attachmentIds, { editedMessageId: original.id });
    const content = requireContent(body.content, attachments);
    const modelIds = requireModels(body);
    // Only images added in this edit are blocked; kept ones reach a text-only model as a note, like any earlier image.
    requireViewable(db, modelIds, attachments.filter((a) => a.messageId === null));
    const limitMessage = claim(chat, modelIds);
    const droppedModelIds = await checkOverflow(chatId, body.allowOverflow, { chatId, parentId: original.parentId, newMessage: { content, attachments }, modelIds });
    const user = saveUserMessage(chatId, original.parentId, content, attachments, webSearch);
    setActiveLeaf(db, chatId, user.id);
    touchChat(db, chatId);
    return reply(c, { chatId, parentId: user.id, modelIds, userMessageId: user.id, kind: 'edit', attachments: attachments.length, effort, thinking, droppedModelIds, limitMessage });
  });

  return r;
}
