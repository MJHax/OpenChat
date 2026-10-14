import type { Deps } from './app';
import { DEFAULT_TITLE, getChatRow, renameChat } from './chats';
import { getChatMessages } from './messages';
import { getSetting } from './settings';
import { activePath, repliesTo } from './tree';

export function cleanTitle(raw: string): string {
  const firstLine = raw.trim().split('\n')[0] ?? '';
  return firstLine
    .replace(/^["'`*#\s]+/, '')
    .replace(/["'`*.\s]+$/, '')
    .slice(0, 80);
}

// Chats with a title request in flight; a slow title call must not be duplicated by the next reply.
const titling = new Set<string>();

/** Titles a chat once it has a complete reply. Never throws; returns the new title or null. */
export async function maybeGenerateTitle(deps: Deps, chatId: string, apiKey: string, fallbackModel: string): Promise<string | null> {
  if (titling.has(chatId)) return null;
  titling.add(chatId);
  try {
    return await generateTitle(deps, chatId, apiKey, fallbackModel);
  } finally {
    titling.delete(chatId);
  }
}

async function generateTitle(deps: Deps, chatId: string, apiKey: string, fallbackModel: string): Promise<string | null> {
  const { db, openrouter } = deps;
  const chat = getChatRow(db, chatId);
  if (!chat || chat.title !== DEFAULT_TITLE) return null;
  const all = getChatMessages(db, chatId);
  // Title once any reply has completed; stopped/partial replies don't count.
  if (!all.some((m) => m.role === 'assistant' && m.status === 'complete')) return null;
  const path = activePath(all, chat.active_leaf_id);
  const last = path.at(-1);
  // During a comparison the path ends at the user message; include the first complete reply.
  if (last?.role === 'user') {
    const reply = repliesTo(all, last.id).find((m) => m.status === 'complete');
    if (reply) path.push(reply);
  }
  const transcript = path
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n\n')
    .slice(0, 4000);
  try {
    const raw = await openrouter.complete({
      apiKey,
      model: getSetting(db, 'title_model_id') || fallbackModel,
      // Reasoning models think before answering; a small budget is spent entirely on reasoning.
      maxTokens: 1000,
      messages: [
        { role: 'system', content: 'Write a short title (at most 6 words) for this conversation. Reply with the title only.' },
        { role: 'user', content: transcript },
      ],
    });
    const title = cleanTitle(raw);
    if (!title) return null;
    renameChat(db, chatId, title);
    return title;
  } catch {
    return null;
  }
}
