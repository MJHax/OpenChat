import type { DB } from './db';
import { newId, now } from './db';
import { HttpError } from './http';
import { chatImages } from './attachments';
import { getChatMessages } from './messages';
import { activePath, repliesTo, withSiblings } from './tree';
import type { ChatDetail, ChatSummary } from '../../shared/types';

export const DEFAULT_TITLE = 'New chat';

export interface ChatRow {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  active_leaf_id: string | null;
  compare_parent_id: string | null;
}

export function createChat(db: DB): ChatSummary {
  const id = newId();
  const t = now();
  db.prepare('INSERT INTO chats (id, title, created_at, updated_at, active_leaf_id) VALUES (?, ?, ?, ?, NULL)').run(id, DEFAULT_TITLE, t, t);
  return { id, title: DEFAULT_TITLE, updatedAt: t, totalCost: 0 };
}

export function getChatRow(db: DB, id: string): ChatRow | undefined {
  return db.prepare('SELECT * FROM chats WHERE id = ?').get(id) as ChatRow | undefined;
}

export function requireChat(db: DB, id: string): ChatRow {
  const row = getChatRow(db, id);
  if (!row) throw new HttpError(404, 'Chat not found.');
  return row;
}

export function listChats(db: DB): ChatSummary[] {
  return db.prepare(
    `SELECT c.id, c.title, c.updated_at AS updatedAt, COALESCE(SUM(u.cost), 0) AS totalCost
     FROM chats c LEFT JOIN usage_events u ON u.chat_id = c.id
     GROUP BY c.id ORDER BY c.updated_at DESC`,
  ).all() as ChatSummary[];
}

export function renameChat(db: DB, id: string, title: string): void {
  db.prepare('UPDATE chats SET title = ? WHERE id = ?').run(title, id);
}

export function setActiveLeaf(db: DB, id: string, leafId: string | null): void {
  db.prepare('UPDATE chats SET active_leaf_id = ? WHERE id = ?').run(leafId, id);
}

export function setCompareParent(db: DB, id: string, parentId: string | null): void {
  db.prepare('UPDATE chats SET compare_parent_id = ? WHERE id = ?').run(parentId, id);
}

/**
 * The user message whose replies await a choice, or null. A marker with no saved replies (e.g. the server
 * stopped mid-comparison) is ignored so it can never lock the chat.
 */
export function pendingChoice(db: DB, chat: ChatRow): string | null {
  if (!chat.compare_parent_id) return null;
  const hasReply = db.prepare("SELECT 1 FROM messages WHERE parent_id = ? AND role = 'assistant' LIMIT 1").get(chat.compare_parent_id);
  return hasReply ? chat.compare_parent_id : null;
}

export function touchChat(db: DB, id: string): void {
  db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(now(), id);
}

export function deleteChat(db: DB, id: string): void {
  db.prepare('DELETE FROM chats WHERE id = ?').run(id);
}

/** Everything the chat's calls cost, replies on every branch plus its title, from the usage log. */
export function chatCost(db: DB, id: string): number {
  return (db.prepare('SELECT COALESCE(SUM(cost), 0) AS total FROM usage_events WHERE chat_id = ?').get(id) as { total: number }).total;
}

export function getChatDetail(db: DB, id: string): ChatDetail {
  const row = requireChat(db, id);
  const all = getChatMessages(db, id);
  const totalCost = chatCost(db, id);
  const choiceParent = pendingChoice(db, row);
  return {
    chat: { id: row.id, title: row.title, updatedAt: row.updated_at, totalCost, activeLeafId: row.active_leaf_id },
    messages: withSiblings(all, activePath(all, row.active_leaf_id)),
    compare: choiceParent ? { parentId: choiceParent, replies: repliesTo(all, choiceParent) } : null,
    chatImages: chatImages(db, id),
  };
}
