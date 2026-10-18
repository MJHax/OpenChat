import type { DB } from './db';
import { attachmentsFor } from './attachments';
import { newId, now } from './db';
import type { Message, MessageStatus, Role, Source } from '../../shared/types';

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
  web_search: number;
  sources: string | null;
  web_searches: number | null;
  participant_id: string | null;
  handoff_to: string | null;
}

const toMessage = (r: MessageRow, attachments: Map<string, Message['attachments']>): Message => ({
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
  attachments: attachments.get(r.id) ?? [],
  webSearch: r.web_search === 1,
  sources: r.sources ? (JSON.parse(r.sources) as Source[]) : [],
  webSearches: r.web_searches,
  participantId: r.participant_id ?? null,
  handoffTo: r.handoff_to ?? null,
});

export type NewMessage = Pick<Message, 'chatId' | 'parentId' | 'role' | 'content'> &
  Partial<Pick<Message,
    'id' | 'modelId' | 'promptTokens' | 'completionTokens' | 'cost' | 'status' | 'webSearch' | 'sources' | 'webSearches' | 'participantId' | 'handoffTo'
  >>;

export function insertMessage(db: DB, m: NewMessage): Message {
  const id = m.id ?? newId();
  db.prepare(
    `INSERT INTO messages (id, chat_id, parent_id, role, content, model_id, prompt_tokens, completion_tokens, cost, status, created_at,
       web_search, sources, web_searches, participant_id, handoff_to)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, m.chatId, m.parentId, m.role, m.content, m.modelId ?? null,
    m.promptTokens ?? null, m.completionTokens ?? null, m.cost ?? null, m.status ?? 'complete', now(),
    m.webSearch ? 1 : 0, m.sources?.length ? JSON.stringify(m.sources) : null, m.webSearches ?? null,
    m.participantId ?? null, m.handoffTo ?? null,
  );
  return getMessage(db, id)!;
}

export function getMessage(db: DB, id: string): Message | undefined {
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined;
  return row && toMessage(row, attachmentsFor(db, [row.id]));
}

/** All messages in a chat, oldest first. */
export function getChatMessages(db: DB, chatId: string): Message[] {
  const rows = db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at, seq').all(chatId) as MessageRow[];
  const attachments = attachmentsFor(db, rows.map((r) => r.id));
  return rows.map((r) => toMessage(r, attachments));
}
