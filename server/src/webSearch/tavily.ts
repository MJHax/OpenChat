import { isAbort, isTimeout, MAX_RESULTS, normalizeResults, SEARCH_TIMEOUT_MS, SearchError, type SearchOptions, type SearchResult, type SearchService } from './types';

function statusError(status: number): SearchError {
  if (status === 401) return new SearchError("Tavily didn't accept this API key.");
  if (status === 429) return new SearchError('Tavily is limiting searches right now. Try again in a minute.');
  if (status === 432 || status === 433) return new SearchError("Your Tavily plan's search limit is used up.");
  return new SearchError(`Tavily couldn't search (HTTP ${status}).`);
}

export function createTavily(
  apiKey: string,
  baseUrl = 'https://api.tavily.com',
  fetchImpl: typeof fetch = fetch,
  opts: SearchOptions = {},
): SearchService {
  const timeoutMs = opts.timeoutMs ?? SEARCH_TIMEOUT_MS;
  const base = baseUrl.replace(/\/+$/, '');

  async function call(path: string, init: RequestInit, signal?: AbortSignal): Promise<any> {
    const signals = [signal, AbortSignal.timeout(timeoutMs)].filter((s): s is AbortSignal => !!s);
    try {
      const res = await fetchImpl(base + path, {
        ...init,
        signal: AbortSignal.any(signals),
        headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) throw statusError(res.status);
      try {
        return await res.json();
      } catch (e) {
        if (isTimeout(e) || (signal?.aborted && isAbort(e))) throw e;
        throw new SearchError(`Tavily couldn't search (HTTP ${res.status}).`);
      }
    } catch (e) {
      if (e instanceof SearchError) throw e;
      if (signal?.aborted && isAbort(e)) throw e;
      if (isTimeout(e)) throw new SearchError("Tavily didn't answer within 10 seconds.");
      throw new SearchError("Can't reach Tavily. Check your internet connection.");
    }
  }

  return {
    name: 'Tavily',
    async search(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
      const body = await call(
        '/search',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query, max_results: MAX_RESULTS, search_depth: 'basic' }),
        },
        signal,
      );
      return normalizeResults(body?.results);
    },
    async test() {
      // GET /usage checks the key without spending a search (docs.tavily.com/documentation/api-reference/endpoint/usage).
      await call('/usage', { method: 'GET' });
    },
  };
}
