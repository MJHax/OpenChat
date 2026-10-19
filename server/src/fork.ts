import type { DB } from './db';
import { newId } from './db';
import { HttpError } from './http';
import { createChat, requireChat, setActiveLeaf } from './chats';
import { getChatMessages } from './messages';
import { activePath } from './tree';
import type { ChatSummary } from '../../shared/types';

/**
 * Opens a new chat holding a copy of the conversation up to and including `messageId`: the messages on its path, their
 * attachments, and the chat's instructions and context note. Usage stays with the original chat, so the fork starts at $0.
 */
export function forkChat(db: DB, chatId: string, messageId: string): ChatSummary {
  const chat = requireChat(db, chatId);
  if (chat.kind !== 'chat') throw new HttpError(400, 'Only chats can be forked.');
  const all = getChatMessages(db, chatId);
  if (!all.some((m) => m.id === messageId)) throw new HttpError(400, 'Message is not in this chat.');
  const path = activePath(all, messageId);

  const copyMessage = db.prepare(
    `INSERT INTO messages (id, chat_id, parent_id, role, content, model_id, prompt_tokens, completion_tokens, cost, status, created_at,
       web_search, sources, web_searches, participant_id, handoff_to)
     SELECT ?, ?, ?, role, content, model_id, prompt_tokens, completion_tokens, cost, status, created_at,
       web_search, sources, web_searches, participant_id, handoff_to
     FROM messages WHERE id = ?`,
  );
  const copyAttachments = db.prepare(
    `INSERT INTO attachments (id, message_id, position, kind, filename, mime, size, data, created_at)
     SELECT ?, ?, position, kind, filename, mime, size, data, created_at FROM attachments WHERE id = ?`,
  );

  return db.transaction(() => {
    const created = createChat(db, 'chat', chat.instructions);
    const title = `${chat.title} (fork)`.slice(0, 200);
    db.prepare('UPDATE chats SET title = ?, context_note = ?, continued_from = ? WHERE id = ?')
      .run(title, chat.context_note, chat.continued_from, created.id);
    let parentId: string | null = null;
    for (const m of path) {
      const id = newId();
      copyMessage.run(id, created.id, parentId, m.id);
      for (const a of m.attachments) copyAttachments.run(newId(), id, a.id);
      parentId = id;
    }
    setActiveLeaf(db, created.id, parentId);
    return { ...created, title };
  })();
}
