import { hostOf } from '../../../shared/localModels';
import { isAbort, isTimeout, normalizeResults, SEARCH_TIMEOUT_MS, SearchError, type SearchOptions, type SearchResult, type SearchService } from './types';

const JSON_OFF =
  'SearXNG answered, but its JSON output is turned off. In SearXNG\'s settings.yml, under "search:", add json to "formats" so it reads "formats: [html, json]", then restart SearXNG.';

export function createSearxng(baseUrl: string, fetchImpl: typeof fetch = fetch, opts: SearchOptions = {}): SearchService {
  const timeoutMs = opts.timeoutMs ?? SEARCH_TIMEOUT_MS;
  const base = baseUrl.replace(/\/+$/, '');

  async function run(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
    const signals = [signal, AbortSignal.timeout(timeoutMs)].filter((s): s is AbortSignal => !!s);
    try {
      const res = await fetchImpl(`${base}/search?q=${encodeURIComponent(query)}&format=json`, {
        signal: AbortSignal.any(signals),
        headers: { accept: 'application/json' },
      });
      if (res.status === 403) throw new SearchError(JSON_OFF);
      if (!res.ok) throw new SearchError(`SearXNG couldn't search (HTTP ${res.status}).`);
      let body: any;
      try {
        body = await res.json();
      } catch (e) {
        if (isTimeout(e) || (signal?.aborted && isAbort(e))) throw e;
        throw new SearchError(`SearXNG couldn't search (HTTP ${res.status}).`);
      }
      return normalizeResults(body?.results);
    } catch (e) {
      if (e instanceof SearchError) throw e;
      if (signal?.aborted && isAbort(e)) throw e;
      if (isTimeout(e)) throw new SearchError("SearXNG didn't answer within 10 seconds.");
      throw new SearchError(`Can't reach SearXNG at ${hostOf(baseUrl)}. Is it running?`);
    }
  }

  return {
    name: 'SearXNG',
    search: run,
    async test() {
      await run('openchat');
    },
  };
}
