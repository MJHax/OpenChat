import type { DB } from './db';
import { HttpError } from './http';
import type { OpenRouterClient } from './openrouter';
import type { CatalogModel, CatalogResponse } from '../../shared/types';

export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

export async function getCatalog(db: DB, openrouter: OpenRouterClient, refresh: boolean): Promise<CatalogResponse> {
  const cached = db.prepare('SELECT fetched_at, json FROM model_catalog_cache WHERE id = 1').get() as
    | { fetched_at: number; json: string }
    | undefined;
  if (cached && !refresh && Date.now() - cached.fetched_at < CATALOG_TTL_MS) {
    return { models: JSON.parse(cached.json), fetchedAt: cached.fetched_at, stale: false };
  }
  try {
    const models = (await openrouter.listModels()).sort((a, b) => a.name.localeCompare(b.name));
    const fetchedAt = Date.now();
    db.prepare(
      'INSERT INTO model_catalog_cache (id, fetched_at, json) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET fetched_at = excluded.fetched_at, json = excluded.json',
    ).run(fetchedAt, JSON.stringify(models));
    return { models, fetchedAt, stale: false };
  } catch (err) {
    if (cached) return { models: JSON.parse(cached.json) as CatalogModel[], fetchedAt: cached.fetched_at, stale: true };
    throw new HttpError(502, (err as Error).message);
  }
}
