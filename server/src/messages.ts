import type { DB } from './db';
import { newId, now } from './db';
import type { Message, MessageStatus, Role } from '../../shared/types';

interface MessageRow {
  id: string;
  chat_id: string;
  parent_id: string | null;
  role: string;
  content: string;
  model_id: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cost: number | null;
  status: string;
  created_at: number;
}

const toMessage = (r: MessageRow): Message => ({
  id: r.id,
  chatId: r.chat_id,
  parentId: r.parent_id,
  role: r.role as Role,
  content: r.content,
  modelId: r.model_id,
  promptTokens: r.prompt_tokens,
  completionTokens: r.completion_tokens,
  cost: r.cost,
  status: r.status as MessageStatus,
  createdAt: r.created_at,
});

export type NewMessage = Pick<Message, 'chatId' | 'parentId' | 'role' | 'content'> &
  Partial<Pick<Message, 'id' | 'modelId' | 'promptTokens' | 'completionTokens' | 'cost' | 'status'>>;

export function insertMessage(db: DB, m: NewMessage): Message {
  const id = m.id ?? newId();
  db.prepare(
    `INSERT INTO messages (id, chat_id, parent_id, role, content, model_id, prompt_tokens, completion_tokens, cost, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, m.chatId, m.parentId, m.role, m.content, m.modelId ?? null,
    m.promptTokens ?? null, m.completionTokens ?? null, m.cost ?? null, m.status ?? 'complete', now(),
  );
  return getMessage(db, id)!;
}

export function getMessage(db: DB, id: string): Message | undefined {
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined;
  return row && toMessage(row);
}

/** All messages in a chat, oldest first. */
export function getChatMessages(db: DB, chatId: string): Message[] {
  const rows = db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at, seq').all(chatId) as MessageRow[];
  return rows.map(toMessage);
}
