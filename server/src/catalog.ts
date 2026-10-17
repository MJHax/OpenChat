import type { DB } from './db';
import { HttpError } from './http';
import type { OpenRouterClient } from './openrouter';
import { CATEGORIES, withCatalogDefaults } from '../../shared/types';
import type { CatalogModel, CatalogResponse } from '../../shared/types';

export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
/** A refresh where some category lists failed (e.g. rate limits) is retried soon rather than kept for a day. */
export const PARTIAL_TTL_MS = 5 * 60 * 1000;

type Rankings = CatalogResponse['rankings'];
interface Cached { models: CatalogModel[]; rankings: Rankings; fetchedAt: number; legacy: boolean; partial: boolean }

/** Rows written before rankings existed hold a bare model array; they're flagged legacy so they get refetched. */
function readCache(db: DB): Cached | undefined {
  const row = db.prepare('SELECT fetched_at, json FROM model_catalog_cache WHERE id = 1').get() as
    | { fetched_at: number; json: string }
    | undefined;
  if (!row) return undefined;
  const parsed = JSON.parse(row.json);
  if (Array.isArray(parsed)) return { models: parsed.map(withCatalogDefaults), rankings: {}, fetchedAt: row.fetched_at, legacy: true, partial: true };
  return { models: parsed.models, rankings: parsed.rankings ?? {}, fetchedAt: row.fetched_at, legacy: false, partial: parsed.partial === true };
}

/**
 * Input modalities per model id from the cached catalog, however old; empty when nothing is cached.
 * A legacy cache predates modalities (its ['text'] is only a default), so it counts as knowing nothing.
 */
export function cachedCapabilities(db: DB): Map<string, { inputModalities: string[]; supportsTools: boolean }> {
  const cached = readCache(db);
  if (!cached || cached.legacy) return new Map();
  return new Map(cached.models.map((m) => [m.id, { inputModalities: m.inputModalities, supportsTools: m.supportsTools }]));
}

/** Per-token prompt and cache-read prices from the cached catalog, however old; empty when nothing (or a legacy cache) is cached. */
export function cachedPrices(db: DB): Map<string, { prompt: number | null; cacheRead: number | null }> {
  const cached = readCache(db);
  if (!cached || cached.legacy) return new Map();
  return new Map(cached.models.map((m) => [m.id, { prompt: m.promptPrice, cacheRead: m.cacheReadPrice ?? null }]));
}

async function fetchRankings(openrouter: OpenRouterClient): Promise<Rankings> {
  const results = await Promise.allSettled(CATEGORIES.map((c) => openrouter.listCategory(c.id)));
  const rankings: Rankings = {};
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') rankings[CATEGORIES[i].id] = r.value;
  });
  return rankings;
}

export async function getCatalog(db: DB, openrouter: OpenRouterClient, refresh: boolean): Promise<CatalogResponse> {
  const cached = readCache(db);
  const ttl = cached?.partial ? PARTIAL_TTL_MS : CATALOG_TTL_MS;
  if (cached && !cached.legacy && !refresh && Date.now() - cached.fetchedAt < ttl) {
    return { models: cached.models, rankings: cached.rankings, fetchedAt: cached.fetchedAt, stale: false };
  }
  try {
    // Promise.all rejects as soon as listModels does, so a failure falls back without waiting on the category lists.
    const [list, rankings] = await Promise.all([openrouter.listModels(), fetchRankings(openrouter)]);
    const models = list.sort((a, b) => a.name.localeCompare(b.name));
    const fetchedAt = Date.now();
    const partial = Object.keys(rankings).length < CATEGORIES.length;
    db.prepare(
      'INSERT INTO model_catalog_cache (id, fetched_at, json) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET fetched_at = excluded.fetched_at, json = excluded.json',
    ).run(fetchedAt, JSON.stringify({ models, rankings, partial }));
    return { models, rankings, fetchedAt, stale: false };
  } catch (err) {
    if (cached) return { models: cached.models, rankings: cached.rankings, fetchedAt: cached.fetchedAt, stale: true };
    throw new HttpError(502, (err as Error).message);
  }
}
