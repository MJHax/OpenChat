import type { DB } from './db';
import { newId, now } from './db';
import { HttpError } from './http';
import { chatImages } from './attachments';
import { threadGenerations } from './imageGen';
import { getChatMessages } from './messages';
import { activePath, repliesTo, withSiblings } from './tree';
import type { ChatDetail, ChatSummary, ThreadKind } from '../../shared/types';

export const DEFAULT_TITLE = 'New chat';

export interface ChatRow {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  active_leaf_id: string | null;
  compare_parent_id: string | null;
  kind: ThreadKind;
  instructions: string;
  context_note: string | null;
  continued_from: string | null;
}

export const MAX_INSTRUCTIONS = 20_000;

/** Per-chat instructions (or a context note) from a request body, trimmed; undefined when absent. */
export function parseInstructions(value: unknown, what = 'Instructions'): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new HttpError(400, `${what} must be text.`);
  const text = value.trim();
  if (text.length > MAX_INSTRUCTIONS) throw new HttpError(400, `${what} can be at most ${MAX_INSTRUCTIONS.toLocaleString('en-US')} characters.`);
  return text;
}

export function createChat(db: DB, kind: ThreadKind = 'chat', instructions = ''): ChatSummary {
  const id = newId();
  const t = now();
  db.prepare('INSERT INTO chats (id, title, created_at, updated_at, active_leaf_id, kind, instructions) VALUES (?, ?, ?, ?, NULL, ?, ?)')
    .run(id, DEFAULT_TITLE, t, t, kind, instructions);
  return { id, title: DEFAULT_TITLE, updatedAt: t, totalCost: 0, kind, thumbnailId: null, busy: false };
}

export function getChatRow(db: DB, id: string): ChatRow | undefined {
  return db.prepare('SELECT * FROM chats WHERE id = ?').get(id) as ChatRow | undefined;
}

export function requireChat(db: DB, id: string): ChatRow {
  const row = getChatRow(db, id);
  if (!row) throw new HttpError(404, 'Chat not found.');
  return row;
}

const COST = `(SELECT COALESCE(SUM(cost), 0) FROM usage_events WHERE chat_id = c.id)
  + (SELECT COALESCE(SUM(cost), 0) FROM media_events WHERE thread_id = c.id)`;

export function listChats(db: DB, kind: ThreadKind = 'chat'): ChatSummary[] {
  const rows = db.prepare(
    `SELECT c.id, c.title, c.updated_at AS updatedAt, c.kind, ${COST} AS totalCost,
       (SELECT a.id FROM attachments a JOIN messages m ON m.id = a.message_id
        WHERE m.chat_id = c.id AND m.role = 'assistant' AND a.kind = 'image' ORDER BY a.created_at DESC LIMIT 1) AS thumbnailId,
       EXISTS (SELECT 1 FROM media_generations g JOIN messages m ON m.id = g.message_id
        WHERE m.chat_id = c.id AND g.finished_at IS NULL) AS busy
     FROM chats c WHERE c.kind = ? ORDER BY c.updated_at DESC`,
  ).all(kind) as (Omit<ChatSummary, 'busy'> & { busy: number })[];
  return rows.map((r) => ({ ...r, busy: r.busy === 1 }));
}

export function renameChat(db: DB, id: string, title: string): void {
  db.prepare('UPDATE chats SET title = ? WHERE id = ?').run(title, id);
}

export function setInstructions(db: DB, id: string, instructions: string): void {
  db.prepare('UPDATE chats SET instructions = ? WHERE id = ?').run(instructions, id);
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

/** Everything the thread's calls cost: replies on every branch, its title, and any images or videos. */
export function chatCost(db: DB, id: string): number {
  return (db.prepare(`SELECT ${COST} AS total FROM chats c WHERE c.id = ?`).get(id) as { total: number } | undefined)?.total ?? 0;
}

/** The chat this one was continued from; its title is null once that chat is deleted. */
function continuedFrom(db: DB, row: ChatRow): { id: string; title: string | null } | null {
  if (!row.continued_from) return null;
  return { id: row.continued_from, title: getChatRow(db, row.continued_from)?.title ?? null };
}

/** Edits a continued chat's summary note; only before the chat's first message is sent. */
export function setContextNote(db: DB, chat: ChatRow, note: string): void {
  if (chat.context_note === null) throw new HttpError(400, 'Only a continued chat has a context note.');
  if (db.prepare("SELECT 1 FROM messages WHERE chat_id = ? AND role = 'user' LIMIT 1").get(chat.id)) {
    throw new HttpError(409, 'The context note can only change before the first message.');
  }
  db.prepare('UPDATE chats SET context_note = ? WHERE id = ?').run(note, chat.id);
}

export function getChatDetail(db: DB, id: string): ChatDetail {
  const row = requireChat(db, id);
  const all = getChatMessages(db, id);
  const totalCost = chatCost(db, id);
  const choiceParent = pendingChoice(db, row);
  return {
    chat: { id: row.id, title: row.title, updatedAt: row.updated_at, totalCost, kind: row.kind, activeLeafId: row.active_leaf_id,
      instructions: row.instructions, contextNote: row.context_note, continuedFrom: continuedFrom(db, row) },
    messages: withSiblings(all, activePath(all, row.active_leaf_id)),
    compare: choiceParent ? { parentId: choiceParent, replies: repliesTo(all, choiceParent) } : null,
    chatImages: chatImages(db, id),
    generations: row.kind === 'chat' ? {} : threadGenerations(db, id),
  };
}
