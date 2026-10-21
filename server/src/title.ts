import type { Deps } from './app';
import { copyText } from '../../shared/files';
import { DEFAULT_TITLE, getChatRow, renameChat } from './chats';
import { getChatMessages } from './messages';
import { getSetting } from './settings';
import { activePath, repliesTo } from './tree';
import { now, type DB } from './db';
import type { Usage } from './openrouter';
import { chatProvider } from './providers';
import { recordUsage, type UsageStatus } from './usage';
import { spendBlock } from './limits';
import { isLocalModelId } from '../../shared/localModels';

export function cleanTitle(raw: string): string {
  const lines = raw.trim().split('\n').map((line) => line.trim()).filter((line) => line !== '');
  // Small models often open with a preamble ("Here's a title:") before the title itself.
  const answer = lines.find((line) => !line.endsWith(':')) ?? lines[0] ?? '';
  return answer
    .replace(/^title:\s*/i, '')
    .replace(/^["'`*#\s]+/, '')
    .replace(/["'`*.\s]+$/, '')
    .slice(0, 80);
}

/** True when the chat has at least one assistant reply and every one came from a local model. */
export function isLocalOnlyChat(db: DB, chatId: string): boolean {
  const rows = db.prepare("SELECT model_id FROM messages WHERE chat_id = ? AND role = 'assistant'").all(chatId) as { model_id: string | null }[];
  return rows.length > 0 && rows.every((r) => !!r.model_id && isLocalModelId(r.model_id));
}

// Chats with a title request in flight; a slow title call must not be duplicated by the next reply.
const titling = new Set<string>();

/** Titles a chat once it has a complete reply. Never throws; returns the new title or null. */
export async function maybeGenerateTitle(deps: Deps, chatId: string, fallbackModel: string): Promise<string | null> {
  if (titling.has(chatId)) return null;
  titling.add(chatId);
  try {
    return await generateTitle(deps, chatId, fallbackModel);
  } finally {
    titling.delete(chatId);
  }
}

async function generateTitle(deps: Deps, chatId: string, fallbackModel: string): Promise<string | null> {
  const { db } = deps;
  const chat = getChatRow(db, chatId);
  if (!chat || chat.title !== DEFAULT_TITLE) return null;
  const all = getChatMessages(db, chatId);
  // Title once any reply has completed; stopped/partial replies don't count.
  if (!all.some((m) => m.role === 'assistant' && m.status === 'complete')) return null;
  const path = activePath(all, chat.active_leaf_id);
  // An image thread that starts with only a photo has nothing to summarise: it's named after the file, without a model call.
  const opener = path.find((m) => m.role === 'user');
  if (chat.kind !== 'chat' && opener && !opener.content.trim() && opener.attachments.length) {
    const title = `${opener.attachments[0].filename.replace(/\.[^.]+$/, '')} edit`.slice(0, 80);
    renameChat(db, chatId, title);
    return title;
  }
  const last = path.at(-1);
  // During a comparison the path ends at the user message; include the first complete reply.
  if (last?.role === 'user') {
    const reply = repliesTo(all, last.id).find((m) => m.status === 'complete');
    if (reply) path.push(reply);
  }
  const transcript = path
    .map((m) => `${m.role}: ${m.role === 'assistant' ? copyText(m.content) : m.content}${m.attachments.length ? ` [attached: ${m.attachments.map((a) => a.filename).join(', ')}]` : ''}`)
    .join('\n\n')
    .slice(0, 4000);
  // Over a spending limit the chat just keeps its default title.
  if (spendBlock(db)) return null;
  let model = getSetting(db, 'title_model_id') || fallbackModel;
  // A chat that never left the local server isn't titled by OpenRouter, whatever the title setting says.
  if (!isLocalModelId(model) && isLocalOnlyChat(db, chatId)) model = fallbackModel;
  const startedAt = now();
  const t0 = Date.now();
  let usage: Usage | null = null;
  let resolved = false;
  const log = (status: UsageStatus) =>
    recordUsage(db, {
      purpose: 'title', chatId, messageId: null, runId: null, kind: null, compare: false, modelId: model, usage, webSearch: false,
      webSearches: null, attachments: 0, firstTokenMs: null, durationMs: Date.now() - t0, status, createdAt: startedAt,
      threadKind: chat.kind,
    });
  try {
    const provider = chatProvider(deps, model);
    resolved = true;
    const raw = await provider.complete({
      model,
      onUsage: (u) => (usage = u),
      // Reasoning models think before answering; a small budget is spent entirely on reasoning.
      maxTokens: 1000,
      messages: [
        { role: 'system', content: 'Write a short title (at most 6 words) for this conversation. Reply with the title only.' },
        { role: 'user', content: transcript },
      ],
    });
    log('complete');
    const title = cleanTitle(raw);
    if (!title) return null;
    renameChat(db, chatId, title);
    return title;
  } catch {
    if (resolved) log('error');
    return null;
  }
}
