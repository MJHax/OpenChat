import type { DB } from './db';
import type { SearchHit } from '../../shared/types';

export function toFtsQuery(input: string): string | null {
  const terms = input.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t}"*`).join(' ');
}

export function searchMessages(db: DB, q: string): SearchHit[] {
  const query = toFtsQuery(q);
  if (!query) return [];
  return db.prepare(
    `SELECT m.id AS messageId, m.chat_id AS chatId, c.title AS chatTitle,
            snippet(messages_fts, 0, '«', '»', '…', 12) AS snippet
     FROM messages_fts
     JOIN messages m ON m.seq = messages_fts.rowid
     JOIN chats c ON c.id = m.chat_id
     WHERE messages_fts MATCH ?
     ORDER BY rank
     LIMIT 30`,
  ).all(query) as SearchHit[];
}
