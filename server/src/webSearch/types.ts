import { ProviderError } from '../providers/types';

export interface SearchResult {
  title: string;
  url: string;
  text: string;
}

export interface SearchService {
  name: 'SearXNG' | 'Tavily';
  search(query: string, signal?: AbortSignal): Promise<SearchResult[]>;
  test(): Promise<void>;
}

/** A search service that is unreachable, slow, or refused a request. The message is safe to show the user. */
export class SearchError extends ProviderError {
  constructor(message: string) {
    super(message, 502);
    this.name = 'SearchError';
  }
}

export const MAX_RESULTS = 5;
export const MAX_RESULT_TEXT = 800;
export const SEARCH_TIMEOUT_MS = 10_000;

export interface SearchOptions {
  /** Test-only override of the 10 second request timeout. */
  timeoutMs?: number;
}

export const isAbort = (e: unknown) => (e as { name?: string } | null)?.name === 'AbortError';
export const isTimeout = (e: unknown) => (e as { name?: string } | null)?.name === 'TimeoutError';

/** Up to 5 results with an http(s) address, text cut to 800 characters. */
export function normalizeResults(raw: unknown): SearchResult[] {
  if (!Array.isArray(raw)) return [];
  const out: SearchResult[] = [];
  for (const r of raw) {
    const url = typeof r?.url === 'string' ? r.url.trim() : '';
    if (!/^https?:\/\//i.test(url)) continue;
    let text = typeof r?.content === 'string' ? r.content : '';
    if (text.length > MAX_RESULT_TEXT) text = text.slice(0, MAX_RESULT_TEXT - 1) + '…';
    out.push({ title: typeof r?.title === 'string' ? r.title : '', url, text });
    if (out.length === MAX_RESULTS) break;
  }
  return out;
}
