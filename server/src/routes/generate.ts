import { Hono, type Context } from 'hono';
import type { Deps } from '../app';
import { HttpError, readJson } from '../http';
import { pendingChoice, requireChat, setActiveLeaf, touchChat, type ChatRow } from '../chats';
import { getMessage, insertMessage } from '../messages';
import { attachToMessage, requireViewable, resolveAttachmentIds, type AttachmentRow } from '../attachments';
import { streamReply } from '../generate';
import { streamComparison } from '../compare';
import type { DB } from '../db';
import type { Message } from '../../../shared/types';

const requireText = (value: unknown, error: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, error);
  return value;
};

const requireFlag = (value: unknown): boolean => {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new HttpError(400, 'webSearch must be true or false.');
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

  /** Reserves the chat for one generation. A running generation wins over a pending choice (it sets that choice). */
  function claim(chat: ChatRow): void {
    if (inFlight.has(chat.id)) throw new HttpError(409, 'A reply is still being generated in this chat. Wait for it to finish.');
    if (pendingChoice(db, chat)) throw new HttpError(409, 'Pick a reply to continue.');
    inFlight.add(chat.id);
  }

  function reply(c: Context, o: { chatId: string; parentId: string; modelIds: string[]; userMessageId: string | null }): Response {
    const onFinish = () => inFlight.delete(o.chatId);
    try {
      if (o.modelIds.length === 1) {
        return streamReply(c, deps, { chatId: o.chatId, parentId: o.parentId, modelId: o.modelIds[0], userMessageId: o.userMessageId, onFinish });
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
    const body = await readJson<{ content?: string; modelId?: unknown; modelIds?: unknown; attachmentIds?: unknown; webSearch?: unknown }>(c);
    const webSearch = requireFlag(body.webSearch);
    const attachments = resolveAttachmentIds(db, body.attachmentIds, { editedMessageId: null });
    const content = requireContent(body.content, attachments);
    const modelIds = requireModels(body);
    requireViewable(db, modelIds, attachments);
    claim(chat);
    const user = saveUserMessage(chatId, chat.active_leaf_id, content, attachments, webSearch);
    setActiveLeaf(db, chatId, user.id);
    touchChat(db, chatId);
    return reply(c, { chatId, parentId: user.id, modelIds, userMessageId: user.id });
  });

  r.post('/:id/regenerate', async (c) => {
    const chatId = c.req.param('id');
    const chat = requireChat(db, chatId);
    const body = await readJson<{ parentId?: string; modelId?: unknown; modelIds?: unknown }>(c);
    const parent = requireUserMessage(db, chatId, body.parentId);
    const modelIds = requireModels(body);
    claim(chat);
    return reply(c, { chatId, parentId: parent.id, modelIds, userMessageId: null });
  });

  r.post('/:id/edit', async (c) => {
    const chatId = c.req.param('id');
    const chat = requireChat(db, chatId);
    const body = await readJson<{ messageId?: string; content?: string; modelId?: unknown; modelIds?: unknown; attachmentIds?: unknown; webSearch?: unknown }>(c);
    const webSearch = requireFlag(body.webSearch);
    const original = requireUserMessage(db, chatId, body.messageId);
    const attachments = resolveAttachmentIds(db, body.attachmentIds, { editedMessageId: original.id });
    const content = requireContent(body.content, attachments);
    const modelIds = requireModels(body);
    // Only images added in this edit are blocked; kept ones reach a text-only model as a note, like any earlier image.
    requireViewable(db, modelIds, attachments.filter((a) => a.messageId === null));
    claim(chat);
    const user = saveUserMessage(chatId, original.parentId, content, attachments, webSearch);
    setActiveLeaf(db, chatId, user.id);
    touchChat(db, chatId);
    return reply(c, { chatId, parentId: user.id, modelIds, userMessageId: user.id });
  });

  return r;
}
