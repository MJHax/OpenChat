import type { Deps } from './app';
import { now } from './db';
import { HttpError } from './http';
import { chatImageNames, getAttachmentData } from './attachments';
import { contextOverflow, overflowMessage } from './contextCheck';
import { createChat, requireChat, setActiveLeaf } from './chats';
import { modelModalities } from './library';
import { getChatMessages, insertMessage } from './messages';
import type { Usage } from './openrouter';
import { chatProviderOrHttp, loadedWindows } from './providers';
import { ProviderError } from './providers/types';
import { buildMessages, withCacheMarkers } from './prompt';
import { chatPersona } from './settings';
import { activePath } from './tree';
import { recordUsage, type UsageStatus } from './usage';
import { parseFileBlocks } from '../../shared/files';
import type { ChatSummary } from '../../shared/types';

export const SUMMARY_PROMPT = [
  'Summarize this conversation so it can continue in a new chat that will not see the messages above.',
  'Cover what the chat is about, the decisions made so far, and the open questions or next steps.',
  'Write plain prose in a few short paragraphs at most, with no headings or lists.',
  'Do not repeat file contents: the latest version of each file is carried over separately.',
  'Reply with the summary only.',
].join(' ');

const SEED_HEADER = 'Files from the previous chat:';

const attr = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/** The seed message for a continued chat: the latest complete version of each generated file, or null when there are none. */
export function seedContent(path: { role: 'user' | 'assistant'; content: string }[]): string | null {
  const latest = new Map<string, string>();
  for (const m of path) {
    if (m.role !== 'assistant') continue;
    for (const s of parseFileBlocks(m.content)) if (s.type === 'file' && s.file.complete) latest.set(s.file.name, s.file.content);
  }
  if (!latest.size) return null;
  const blocks = [...latest].map(([name, content]) => `<file name="${attr(name)}">\n${content}\n</file>`);
  return [SEED_HEADER, ...blocks].join('\n\n');
}

/**
 * Has `modelId` summarize the chat's active path, then opens a new chat holding that summary as its context note, the
 * latest generated files as a seed reply, and the old chat's instructions. Nothing is created if the summary fails.
 */
export async function continueChat(deps: Deps, chatId: string, modelId: string, allowOverflow = false): Promise<ChatSummary> {
  const { db } = deps;
  const chat = requireChat(db, chatId);
  if (chat.kind !== 'chat') throw new HttpError(400, 'Only chats can be continued.');
  const path = activePath(getChatMessages(db, chatId), chat.active_leaf_id);
  if (!path.some((m) => m.role === 'user')) throw new HttpError(400, 'There is nothing to summarize yet.');
  const provider = chatProviderOrHttp(deps, modelId);
  const overflow = contextOverflow(db, { chatId, parentId: chat.active_leaf_id, newMessage: null, modelIds: [modelId], windows: await loadedWindows(deps, [modelId]) });
  if (overflow.length && !allowOverflow) throw new HttpError(409, overflowMessage(overflow), { overflow });

  // The same prompt a reply would get, plus the request: its prefix is likely still cached from the last reply. A last
  // message whose reply was lost goes into the request as an open question; sent as is, the model answers it first.
  const unanswered = path.at(-1)?.role === 'user' ? path.at(-1)! : null;
  const loadData = (id: string) => getAttachmentData(db, id) ?? Buffer.alloc(0);
  const history = buildMessages(chatPersona(db, chatId), unanswered ? path.slice(0, -1) : path,
    { inputModalities: modelModalities(db, modelId), loadData }, { imageNames: chatImageNames(db, chatId) }, chat.context_note);
  const request = unanswered
    ? `${SUMMARY_PROMPT}\n\nThe user's last message never got a reply; include it as an open question:\n\n${unanswered.content}`
    : SUMMARY_PROMPT;
  const messages = withCacheMarkers(modelId, [...history, { role: 'user', content: request }]);

  const startedAt = now();
  const t0 = Date.now();
  let usage: Usage | null = null;
  const log = (status: UsageStatus) =>
    recordUsage(db, {
      purpose: 'summary', chatId, messageId: null, runId: null, kind: null, compare: false, modelId, usage, webSearch: false,
      webSearches: null, attachments: 0, firstTokenMs: null, durationMs: Date.now() - t0, status, createdAt: startedAt,
    });

  let summary: string;
  try {
    // Reasoning models think before answering, so the budget leaves room beyond the summary itself.
    summary = (await provider.complete({ model: modelId, messages, maxTokens: 4000, onUsage: (u) => (usage = u) })).trim();
    log('complete');
  } catch (err) {
    log('error');
    throw new HttpError(502, err instanceof ProviderError ? err.message : 'Could not reach the model to write the summary.');
  }
  if (!summary) throw new HttpError(502, 'The model returned an empty summary. Try again or pick another model.');

  const seed = seedContent(path);
  return db.transaction(() => {
    const created = createChat(db, 'chat', chat.instructions);
    const title = `${chat.title} (continued)`.slice(0, 200);
    db.prepare('UPDATE chats SET title = ?, context_note = ?, continued_from = ? WHERE id = ?').run(title, summary, chatId, created.id);
    if (seed) setActiveLeaf(db, created.id, insertMessage(db, { chatId: created.id, parentId: null, role: 'assistant', content: seed }).id);
    return { ...created, title };
  })();
}
