import { EFFORTS, type Effort } from '../../../shared/types';

export const effortKey = (chatId: string) => `openchat.effort.${chatId}`;
/** The last effort picked anywhere, which a new chat starts with. */
const LAST_KEY = 'openchat.effort.last';

const parse = (raw: string | null): Effort | null => (EFFORTS.includes(raw as Effort) ? (raw as Effort) : null);

/** A chat's reasoning effort (null = the model's default); a new chat, or one never set, takes the last one picked. */
export function loadEffort(chatId: string | null): Effort | null {
  try {
    const own = chatId ? localStorage.getItem(effortKey(chatId)) : null;
    return own !== null ? parse(own) : parse(localStorage.getItem(LAST_KEY));
  } catch {
    return null;
  }
}

export function saveEffort(chatId: string | null, effort: Effort | null): void {
  try {
    if (chatId) localStorage.setItem(effortKey(chatId), effort ?? 'default');
    localStorage.setItem(LAST_KEY, effort ?? 'default');
  } catch {
    // storage unavailable (private window); the choice just won't be remembered
  }
}

export const EFFORT_TOOLTIP = 'How long the model thinks before answering. Higher effort can give better answers to hard questions, but uses more tokens and costs more.';
