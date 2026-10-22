import { canViewImages } from '../../shared/attachments';
import { collapseSuperseded } from '../../shared/files';
import { isLocalModelId } from '../../shared/localModels';
import type { ContextOverflow, ContextUsage, Message } from '../../shared/types';
import { chatImageNames, getAttachmentData, type AttachmentRow } from './attachments';
import { getChatRow } from './chats';
import { estimateContext, textTokens } from './context';
import { buildDiscussionPrompt, moderatorTools, nextSpeaker } from './discussion/engine';
import { getDiscussionRow, getParticipants } from './discussion/store';
import type { DB } from './db';
import { displayNameOf, modelContextLength, modelModalities } from './library';
import { pdfTextFor } from './pdfText';
import { getChatMessages } from './messages';
import { replySystemPrompt } from './prompt';
import { chatPersona } from './settings';
import { activePath } from './tree';

/** Room kept for the reply; erring toward asking. */
export const OVERFLOW_MARGIN = 1_024;

/** Room kept for web search results when a local model will search. */
export const SEARCH_RESERVE_TOKENS = 3_000;

/** How full `modelId`'s window is for `path` (a chat's active path, oldest first), as a reply would be sent. */
export function estimatePath(db: DB, o: { modelId: string; chatId: string | null; path: Message[]; instructions?: string; windows?: Map<string, number> }): ContextUsage {
  // What the model is actually sent: older versions of a file are reduced to a stub.
  const sent = collapseSuperseded(o.path);
  const input = {
    modelId: o.modelId,
    contextLength: o.windows?.get(o.modelId) ?? modelContextLength(db, o.modelId),
    system: replySystemPrompt(chatPersona(db, o.chatId, o.instructions ?? ''), o.chatId ? chatImageNames(db, o.chatId) : []),
    note: o.chatId ? getChatRow(db, o.chatId)?.context_note ?? null : null,
    path: o.path.map((m, i) => ({ ...m, content: sent[i] })),
    canViewImages: canViewImages(modelModalities(db, o.modelId)),
    loadData: (id: string) => getAttachmentData(db, id) ?? Buffer.alloc(0),
    pdfText: pdfTextFor(db, o.modelId),
  };
  const anchored = estimateContext(input);
  if (!isLocalModelId(o.modelId)) return anchored;
  // A local server that overflows drops the oldest messages and then reports only what it kept, so a saved prompt
  // count can be far too small. Never trust it below what counting the characters says.
  const counted = estimateContext({ ...input, path: input.path.map((m) => ({ ...m, promptTokens: null })) });
  return counted.used > anchored.used ? counted : anchored;
}

/** The local models among `modelIds` whose window can't hold the chat up to `parentId` plus the message about to be sent. */
export function contextOverflow(db: DB, o: {
  chatId: string;
  parentId: string | null;
  newMessage: { content: string; attachments: AttachmentRow[] } | null;
  modelIds: string[];
  /** The windows LM Studio models are loaded with; they win over the chosen ones. */
  windows?: Map<string, number>;
  /** A web search will run for the reply, so local models need room for its results. */
  webSearch?: boolean;
}): ContextOverflow[] {
  const path = activePath(getChatMessages(db, o.chatId), o.parentId);
  if (o.newMessage) {
    path.push({
      id: '', chatId: o.chatId, parentId: o.parentId, role: 'user', content: o.newMessage.content, attachments: o.newMessage.attachments,
      promptTokens: null, completionTokens: null, webSearches: null, sources: [],
    } as unknown as Message);
  }
  const out: ContextOverflow[] = [];
  for (const modelId of o.modelIds) {
    if (!isLocalModelId(modelId)) continue;
    const window = o.windows?.get(modelId) ?? modelContextLength(db, modelId);
    if (window === null) continue;
    const { used } = estimatePath(db, { modelId, chatId: o.chatId, path, windows: o.windows });
    const reserve = o.webSearch ? SEARCH_RESERVE_TOKENS : 0;
    if (used + reserve + OVERFLOW_MARGIN > window) out.push({ modelId, displayName: displayNameOf(db, modelId), window, estimate: used });
  }
  return out;
}

/** "A", "A and B", "A, B and C". */
export function joinNames(names: string[]): string {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

export const overflowMessage = (overflow: ContextOverflow[]): string =>
  `This chat is longer than ${joinNames(overflow.map((o) => o.displayName))} can remember.`;

/**
 * Whether the next Discussion speaker's local model can hold its turn's prompt. The estimate counts the real prompt
 * (and the moderator's tools) with `textTokens`, and is never below the speaker's last own turn's reported prompt and
 * reply plus the counted text said since. Null for an OpenRouter speaker or a model whose window isn't known.
 */
export function discussionOverflow(db: DB, chatId: string, windows?: Map<string, number>): ContextOverflow | null {
  const participants = getParticipants(db, chatId);
  const messages = getChatMessages(db, chatId);
  const speaker = nextSpeaker(participants, messages);
  if (!isLocalModelId(speaker.modelId)) return null;
  const window = windows?.get(speaker.modelId) ?? modelContextLength(db, speaker.modelId);
  if (window === null) return null;
  const prompt = buildDiscussionPrompt(getDiscussionRow(db, chatId).topic, participants, messages, speaker);
  const tools = speaker.isModerator ? JSON.stringify(moderatorTools(participants)) : '';
  const counted = prompt.reduce((n, m) => n + textTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)), 0) + textTokens(tools);
  const anchorIndex = messages.findLastIndex((m) => m.participantId === speaker.id && m.promptTokens !== null);
  const anchored = anchorIndex === -1 ? 0
    : messages[anchorIndex].promptTokens! + (messages[anchorIndex].completionTokens ?? textTokens(messages[anchorIndex].content))
      + messages.slice(anchorIndex + 1).reduce((n, m) => n + textTokens(m.content), 0) + textTokens(tools);
  const used = Math.max(counted, anchored);
  return used + OVERFLOW_MARGIN > window ? { modelId: speaker.modelId, displayName: displayNameOf(db, speaker.modelId), window, estimate: used } : null;
}

export const discussionOverflowMessage = (o: ContextOverflow): string => `This discussion is longer than ${o.displayName} can remember.`;
