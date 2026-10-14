import type { Deps } from './app';
import { DEFAULT_TITLE, getChatRow, renameChat } from './chats';
import { getChatMessages } from './messages';
import { getSetting } from './settings';
import { activePath } from './tree';

export function cleanTitle(raw: string): string {
  const firstLine = raw.trim().split('\n')[0] ?? '';
  return firstLine
    .replace(/^["'`*#\s]+/, '')
    .replace(/["'`*.\s]+$/, '')
    .slice(0, 80);
}

/** Titles a chat after its first reply. Never throws; returns the new title or null. */
export async function maybeGenerateTitle(deps: Deps, chatId: string, apiKey: string, fallbackModel: string): Promise<string | null> {
  const { db, openrouter } = deps;
  const chat = getChatRow(db, chatId);
  if (!chat || chat.title !== DEFAULT_TITLE) return null;
  const all = getChatMessages(db, chatId);
  // Title after the first complete reply; earlier stopped/partial replies don't count.
  if (all.filter((m) => m.role === 'assistant' && m.status === 'complete').length !== 1) return null;
  const transcript = activePath(all, chat.active_leaf_id)
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n\n')
    .slice(0, 4000);
  try {
    const raw = await openrouter.complete({
      apiKey,
      model: getSetting(db, 'title_model_id') || fallbackModel,
      maxTokens: 30,
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
