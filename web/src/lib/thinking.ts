export const thinkingKey = (chatId: string) => `openchat.thinking.${chatId}`;
/** The last choice made anywhere, which a new chat starts with. */
const LAST_KEY = 'openchat.thinking.last';

/** Whether a local reasoning model thinks before answering; on unless turned off. A new chat takes the last choice. */
export function loadThinking(chatId: string | null): boolean {
  try {
    const own = chatId ? localStorage.getItem(thinkingKey(chatId)) : null;
    return (own ?? localStorage.getItem(LAST_KEY)) !== 'off';
  } catch {
    return true;
  }
}

export function saveThinking(chatId: string | null, on: boolean): void {
  try {
    const value = on ? 'on' : 'off';
    if (chatId) localStorage.setItem(thinkingKey(chatId), value);
    localStorage.setItem(LAST_KEY, value);
  } catch {
    // storage unavailable (private window); the choice just won't be remembered
  }
}

export const THINKING_TOOLTIP = 'Whether the model reasons before it answers. Turning it off is faster, but it may answer worse on hard questions.';
