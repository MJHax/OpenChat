import type { DB } from './db';
import { newId, now } from './db';
import { HttpError } from './http';
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
    `SELECT c.id, c.title, c.updated_at AS updatedAt, COALESCE(SUM(m.cost), 0) AS totalCost
     FROM chats c LEFT JOIN messages m ON m.chat_id = c.id
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

export function touchChat(db: DB, id: string): void {
  db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(now(), id);
}

export function deleteChat(db: DB, id: string): void {
  db.prepare('DELETE FROM chats WHERE id = ?').run(id);
}

export function getChatDetail(db: DB, id: string): ChatDetail {
  const row = requireChat(db, id);
  const all = getChatMessages(db, id);
  const totalCost = all.reduce((sum, m) => sum + (m.cost ?? 0), 0);
  return {
    chat: { id: row.id, title: row.title, updatedAt: row.updated_at, totalCost, activeLeafId: row.active_leaf_id },
    messages: withSiblings(all, activePath(all, row.active_leaf_id)),
    compare: row.compare_parent_id ? { parentId: row.compare_parent_id, replies: repliesTo(all, row.compare_parent_id) } : null,
  };
}
