import type { DB } from '../db';
import { newId } from '../db';
import { HttpError } from '../http';
import { chatCost, createChat, MAX_INSTRUCTIONS, renameChat, requireChat } from '../chats';
import { getChatMessages } from '../messages';
import { modelSupportsTools } from '../library';
import { turnsTaken } from './engine';
import { validateNewDiscussion } from '../../../shared/discussion';
import type {
  DiscussionDetail, DiscussionEndReason, DiscussionParticipant, DiscussionState, DiscussionStatus, DiscussionSummary, NewDiscussion,
} from '../../../shared/types';

export interface DiscussionRow {
  chatId: string;
  topic: string;
  turnLimit: number;
  status: DiscussionStatus;
  endReason: DiscussionEndReason | null;
  endNote: string | null;
}

interface RawDiscussion {
  chat_id: string; topic: string; turn_limit: number; status: DiscussionStatus; end_reason: DiscussionEndReason | null; end_note: string | null;
  moderator_note_after: string | null; summary: string | null; summary_model_id: string | null; summary_cost: number | null; summary_at: number | null;
}

const raw = (db: DB, chatId: string) => db.prepare('SELECT * FROM discussions WHERE chat_id = ?').get(chatId) as RawDiscussion | undefined;

export function getDiscussionRow(db: DB, chatId: string): DiscussionRow {
  const r = raw(db, chatId);
  if (!r) throw new HttpError(404, 'Discussion not found.');
  return { chatId: r.chat_id, topic: r.topic, turnLimit: r.turn_limit, status: r.status, endReason: r.end_reason, endNote: r.end_note };
}

/** By position. */
export function getParticipants(db: DB, chatId: string): DiscussionParticipant[] {
  const rows = db.prepare('SELECT * FROM discussion_participants WHERE chat_id = ? ORDER BY position').all(chatId) as {
    id: string; position: number; name: string; model_id: string; instructions: string; is_moderator: number;
  }[];
  return rows.map((r) => ({ id: r.id, position: r.position, name: r.name, modelId: r.model_id, instructions: r.instructions, isModerator: r.is_moderator === 1 }));
}

export function discussionState(db: DB, chatId: string): DiscussionState {
  const d = getDiscussionRow(db, chatId);
  return {
    status: d.status, endReason: d.endReason, endNote: d.endNote, turnLimit: d.turnLimit,
    turnsTaken: turnsTaken(getParticipants(db, chatId), getChatMessages(db, chatId)),
    moderatorNoteAfter: raw(db, chatId)?.moderator_note_after ?? null,
  };
}

/**
 * Tracks the moderator's misses: a valid tool call resets the count; a miss adds one, and the second in a row
 * marks `messageId` as the message the "not steering" note follows (once; it never moves).
 */
export function recordModeratorTurn(db: DB, chatId: string, messageId: string, valid: boolean): void {
  if (valid) {
    db.prepare('UPDATE discussions SET moderator_misses = 0 WHERE chat_id = ?').run(chatId);
    return;
  }
  db.prepare('UPDATE discussions SET moderator_misses = moderator_misses + 1 WHERE chat_id = ?').run(chatId);
  db.prepare('UPDATE discussions SET moderator_note_after = ? WHERE chat_id = ? AND moderator_misses >= 2 AND moderator_note_after IS NULL')
    .run(messageId, chatId);
}

export function setStatus(db: DB, chatId: string, status: DiscussionStatus, endReason: DiscussionEndReason | null, endNote: string | null = null): void {
  db.prepare('UPDATE discussions SET status = ?, end_reason = ?, end_note = ? WHERE chat_id = ?').run(status, endReason, endNote, chatId);
}

export function setTurnLimit(db: DB, chatId: string, turnLimit: number): void {
  db.prepare('UPDATE discussions SET turn_limit = ? WHERE chat_id = ?').run(turnLimit, chatId);
}

export function saveSummary(db: DB, chatId: string, s: DiscussionSummary): void {
  db.prepare('UPDATE discussions SET summary = ?, summary_model_id = ?, summary_cost = ?, summary_at = ? WHERE chat_id = ?')
    .run(s.text, s.modelId, s.cost, s.createdAt, chatId);
}

/** Validates and saves a new discussion with its participants, ready for its first turn. */
export function createDiscussion(db: DB, d: NewDiscussion): DiscussionDetail {
  const error = validateNewDiscussion(d, MAX_INSTRUCTIONS);
  if (error) throw new HttpError(400, error);
  const moderator = d.participants.find((p) => p.isModerator);
  if (moderator && !modelSupportsTools(db, moderator.modelId.trim())) {
    throw new HttpError(400, 'The moderator needs a model that can use tools. Pick another model for it.');
  }
  const topic = d.topic.trim();
  const chatId = db.transaction(() => {
    const chat = createChat(db, 'discussion');
    renameChat(db, chat.id, topic.slice(0, 200));
    db.prepare("INSERT INTO discussions (chat_id, topic, turn_limit, status) VALUES (?, ?, ?, 'active')").run(chat.id, topic, d.turnLimit);
    const insert = db.prepare(
      'INSERT INTO discussion_participants (id, chat_id, position, name, model_id, instructions, is_moderator) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    d.participants.forEach((p, i) =>
      insert.run(newId(), chat.id, i, p.name.trim(), p.modelId.trim(), (p.instructions ?? '').trim(), p.isModerator ? 1 : 0));
    return chat.id;
  })();
  return getDiscussionDetail(db, chatId);
}

export function getDiscussionDetail(db: DB, chatId: string): DiscussionDetail {
  const chat = requireChat(db, chatId);
  const r = raw(db, chatId);
  if (!r || chat.kind !== 'discussion') throw new HttpError(404, 'Discussion not found.');
  const participants = getParticipants(db, chatId);
  const messages = getChatMessages(db, chatId);
  return {
    chat: { id: chat.id, title: chat.title, updatedAt: chat.updated_at, totalCost: chatCost(db, chatId) },
    topic: r.topic,
    participants: participants.map((p) => {
      const own = messages.filter((m) => m.participantId === p.id);
      return { ...p, turns: turnsTaken(participants, own), cost: own.reduce((t, m) => t + (m.cost ?? 0), 0) };
    }),
    messages,
    state: discussionState(db, chatId),
    summary: r.summary !== null && r.summary_model_id !== null
      ? { text: r.summary, modelId: r.summary_model_id, cost: r.summary_cost, createdAt: r.summary_at ?? 0 }
      : null,
  };
}
