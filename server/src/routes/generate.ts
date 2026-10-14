import { Hono } from 'hono';
import type { Deps } from '../app';
import { HttpError, readJson } from '../http';
import { requireChat, setActiveLeaf, touchChat } from '../chats';
import { getMessage, insertMessage } from '../messages';
import { streamReply } from '../generate';
import type { DB } from '../db';
import type { Message } from '../../../shared/types';

const requireText = (value: unknown, error: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, error);
  return value;
};

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

  r.post('/:id/messages', async (c) => {
    const chatId = c.req.param('id');
    const chat = requireChat(db, chatId);
    const body = await readJson<{ content?: string; modelId?: string }>(c);
    const content = requireText(body.content, 'Message is empty.');
    const modelId = requireText(body.modelId, 'Pick a model first.');
    const user = insertMessage(db, { chatId, parentId: chat.active_leaf_id, role: 'user', content });
    setActiveLeaf(db, chatId, user.id);
    touchChat(db, chatId);
    return streamReply(c, deps, { chatId, parentId: user.id, modelId, userMessageId: user.id });
  });

  r.post('/:id/regenerate', async (c) => {
    const chatId = c.req.param('id');
    requireChat(db, chatId);
    const body = await readJson<{ parentId?: string; modelId?: string }>(c);
    const parent = requireUserMessage(db, chatId, body.parentId);
    const modelId = requireText(body.modelId, 'Pick a model first.');
    return streamReply(c, deps, { chatId, parentId: parent.id, modelId, userMessageId: null });
  });

  r.post('/:id/edit', async (c) => {
    const chatId = c.req.param('id');
    requireChat(db, chatId);
    const body = await readJson<{ messageId?: string; content?: string; modelId?: string }>(c);
    const original = requireUserMessage(db, chatId, body.messageId);
    const content = requireText(body.content, 'Message is empty.');
    const modelId = requireText(body.modelId, 'Pick a model first.');
    const user = insertMessage(db, { chatId, parentId: original.parentId, role: 'user', content });
    setActiveLeaf(db, chatId, user.id);
    touchChat(db, chatId);
    return streamReply(c, deps, { chatId, parentId: user.id, modelId, userMessageId: user.id });
  });

  return r;
}
