import type { SearchServiceId, Source } from '../../../shared/types';

export const searchKey = (chatId: string) => `openchat.search.${chatId}`;

/** Whether web search is on for a chat; off when never set or when storage is unavailable. */
export function loadSearch(chatId: string): boolean {
  try {
    return localStorage.getItem(searchKey(chatId)) === '1';
  } catch {
    return false;
  }
}

export function saveSearch(chatId: string, on: boolean): void {
  try {
    localStorage.setItem(searchKey(chatId), on ? '1' : '0');
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

const SERVICE_NAMES: Record<SearchServiceId, string> = { none: 'none', searxng: 'SearXNG', tavily: 'Tavily' };

/** The composer's search toggle tooltip. */
export function searchTooltip(o: { on: boolean; allLocal: boolean; service: SearchServiceId; ready: boolean }): string {
  const state = `Web search: ${o.on ? 'on' : 'off'}.`;
  if (!o.allLocal) return `${state} ${SEARCH_TOOLTIP}`;
  if (!o.ready) return 'Set up web search in Settings';
  return `${state} Searches run through ${SERVICE_NAMES[o.service]}.`;
}
