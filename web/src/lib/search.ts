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

// Measured 2026-10-16: Exa (used by the tool and the plugin) about $0.007 per search, model makers' own search about $0.01.
export const SEARCH_TOOLTIP = "Let the model search the web. Each search costs about $0.007–$0.01 on top of the model's price, even with free models.";
export const SEARCH_NOTE =
  "Searches are run by OpenRouter's search partners (Exa, or the model maker's own search), so your search queries are sent to them. " +
  "Each search costs about $0.007–$0.01 on top of the model's price, even with free models. Models that can't use tools search on every reply.";
