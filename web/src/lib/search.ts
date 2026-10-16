import type { Source } from '../../../shared/types';

const storageKey = (chatId: string) => `openchat.search.${chatId}`;

/** Whether web search is on for a chat; off when never set or when storage is unavailable. */
export function loadSearch(chatId: string): boolean {
  try {
    return localStorage.getItem(storageKey(chatId)) === '1';
  } catch {
    return false;
  }
}

export function saveSearch(chatId: string, on: boolean): void {
  try {
    localStorage.setItem(storageKey(chatId), on ? '1' : '0');
  } catch {
    // storage unavailable (private window); the toggle just won't be remembered
  }
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export const sourceLabel = (s: Source): string => s.title.trim() || s.url;
