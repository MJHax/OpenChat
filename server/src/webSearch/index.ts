import type { DB } from '../db';
import { getSetting, type Env } from '../settings';
import { createSearxng } from './searxng';
import { createTavily } from './tavily';
import type { SearchService } from './types';

/** The search service saved in Settings, or null when none is chosen or its details are missing. */
export function webSearchService(db: DB, env: Env, fetchImpl?: typeof fetch): SearchService | null {
  const choice = getSetting(db, 'web_search_service');
  if (choice === 'searxng') {
    const url = getSetting(db, 'searxng_url');
    return url ? createSearxng(url, fetchImpl) : null;
  }
  if (choice === 'tavily') {
    const key = getSetting(db, 'tavily_api_key');
    return key ? createTavily(key, env.OPENCHAT_TAVILY_URL ?? 'https://api.tavily.com', fetchImpl) : null;
  }
  return null;
}
