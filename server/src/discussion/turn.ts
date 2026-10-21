import type { Context } from 'hono';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';
import type { Deps } from '../app';
import { newId, type DB } from '../db';
import { getChatRow, setActiveLeaf, touchChat } from '../chats';
import { getChatMessages, insertMessage } from '../messages';
import type { Usage } from '../openrouter';
import { chatProvider } from '../providers';
import { recordUsage, type UsageStatus } from '../usage';
import { displayNameOf } from '../library';
import { statusMessage } from '../../../shared/localModels';
import { callTimer, failureStatus, timingFields, replyErrorMessage, saveIfChatExists } from '../generate';
import { buildDiscussionPrompt, cleanReply, moderatorTools, nextSpeaker, readToolCall, turnsTaken } from './engine';
import { discussionState, getDiscussionRow, getParticipants, setStatus } from './store';
import type {
  DiscussionParticipant, DiscussionState, DiscussionTurnDone, DiscussionTurnError, DiscussionTurnStart, Message, MessageStatus, StreamStatus,
} from '../../../shared/types';

/** The participant who speaks next: the choice `streamTurn` makes, shared so the route can check the limit against its model. */
export function turnSpeaker(db: DB, chatId: string): DiscussionParticipant {
  return nextSpeaker(getParticipants(db, chatId), getChatMessages(db, chatId));
}

/**
 * Streams one discussion turn as SSE: start → (delta|reasoning)* → done | error. The server picks the speaker, saves its
 * reply (cleaned) when the stream ends, and ends the discussion when the moderator says so or the turn limit is reached.
 * The caller has already checked that a turn may start.
 */
export function streamTurn(c: Context, deps: Deps, chatId: string, onFinish: () => void): Response {
  const { db } = deps;
  const { topic } = getDiscussionRow(db, chatId);
  const participants = getParticipants(db, chatId);
  const history = getChatMessages(db, chatId);
  const speaker = turnSpeaker(db, chatId);
  const others = participants.filter((p) => p.id !== speaker.id).map((p) => p.name);
  const messages = buildDiscussionPrompt(topic, participants, history, speaker);
  const tools = speaker.isModerator ? moderatorTools(participants) : undefined;
  const messageId = newId();
  const abort = new AbortController();
  let finished = false;
  c.req.raw.signal.addEventListener('abort', () => abort.abort());

  const finish = () => {
    if (finished) return;
    finished = true;
    onFinish();
  };

  return streamSSE(c, async (stream) => {
    try {
      await run(stream);
    } finally {
      finish();
    }
  });

  async function run(stream: SSEStreamingApi) {
    stream.onAbort(() => abort.abort());
    const send = (event: string, data: unknown) => stream.writeSSE({ event, data: JSON.stringify(data) });
    let text = '';
    let usage: Usage | null = null;
    let call: { name: string; arguments: string } | null = null;
    const timer = callTimer();
    const log = (status: UsageStatus, savedId: string | null) =>
      recordUsage(db, {
        purpose: 'reply', chatId, messageId: savedId, runId: newId(), kind: 'send', compare: false, modelId: speaker.modelId, usage,
        webSearch: false, webSearches: null, attachments: 0, ...timer.finish(), status, createdAt: timer.startedAt, threadKind: 'discussion',
      });
    const save = (status: MessageStatus, content: string, handoffTo: string | null): Message => {
      const message = insertMessage(db, {
        id: messageId, chatId, parentId: getChatRow(db, chatId)?.active_leaf_id ?? null, role: 'assistant', content,
        modelId: speaker.modelId, promptTokens: usage?.promptTokens ?? null, completionTokens: usage?.completionTokens ?? null,
        cost: usage?.cost ?? null, status, participantId: speaker.id, handoffTo,
        ...timingFields(speaker.modelId, usage, timer.finish()),
      });
      setActiveLeaf(db, chatId, message.id);
      touchChat(db, chatId);
      return message;
    };
    /** Ends the discussion if the moderator said so or the turn limit is reached; one that ended meanwhile (Stop) stays as it is. */
    const settle = (end: string | null) => {
      const { status, turnLimit } = getDiscussionRow(db, chatId);
      if (status !== 'active') return;
      if (end !== null) setStatus(db, chatId, 'ended', 'moderator', end);
      else if (turnsTaken(participants, getChatMessages(db, chatId)) >= turnLimit) setStatus(db, chatId, 'ended', 'limit');
    };

    await send('start', { messageId, participantId: speaker.id } satisfies DiscussionTurnStart);
    let resolved = false;
    try {
      const provider = chatProvider(deps, speaker.modelId);
      resolved = true;
      for await (const event of provider.streamChat({ model: speaker.modelId, messages, tools, signal: abort.signal })) {
        if (event.type === 'delta') {
          timer.token();
          text += event.text;
          await send('delta', { text: event.text });
        } else if (event.type === 'reasoning') {
          timer.token();
          await send('reasoning', { text: event.text });
        } else if (event.type === 'status') {
          await send('status', { message: statusMessage(event.status, displayNameOf(db, speaker.modelId)) } satisfies StreamStatus);
        } else if (event.type === 'usage') {
          usage = event.usage;
        } else if (event.type === 'tool_call') {
          call ??= event; // only the first call counts
        }
      }
      const decision = speaker.isModerator && call ? readToolCall(participants, call) : null;
      const handoffTo = decision && 'handoffTo' in decision ? decision.handoffTo : null;
      const message = save('complete', cleanReply(text, speaker.name, others), handoffTo);
      log('complete', message.id);
      settle(decision && 'end' in decision ? decision.end : null);
      await send('done', { message, state: discussionState(db, chatId) } satisfies DiscussionTurnDone);
    } catch (err) {
      // A cut-off reply still counts as a turn, so it is cleaned like any other and can reach the turn limit.
      const partial = text ? saveIfChatExists(() => save('stopped', cleanReply(text, speaker.name, others), null)) : null;
      if (resolved) log(failureStatus(abort.signal), partial?.id ?? null);
      let state: DiscussionState;
      try {
        if (partial) settle(null);
        state = discussionState(db, chatId);
      } catch {
        return; // the discussion was deleted mid-turn
      }
      if (abort.signal.aborted) return; // client went away; nothing to send
      await send('error', { message: replyErrorMessage(err), partial, state } satisfies DiscussionTurnError);
    }
  }
}
