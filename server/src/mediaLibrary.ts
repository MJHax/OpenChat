import type { DB } from './db';
import { now } from './db';
import { HttpError } from './http';
import { CATALOG_TTL_MS } from './catalog';
import type { OpenRouterClient } from './openrouter';
import type { MediaModel } from '../../shared/types';
import type { MediaCatalog, MediaKind, MediaLibraryModel } from '../../shared/types';

export const MEDIA_KINDS: MediaKind[] = ['image', 'video'];

export function requireMediaKind(kind: unknown): MediaKind {
  if (!MEDIA_KINDS.includes(kind as MediaKind)) throw new HttpError(400, 'kind must be image or video.');
  return kind as MediaKind;
}

function readCache(db: DB, kind: MediaKind): { models: MediaModel[]; fetchedAt: number } | undefined {
  const row = db.prepare('SELECT fetched_at, json FROM media_catalog_cache WHERE kind = ?').get(kind) as { fetched_at: number; json: string } | undefined;
  return row && { models: JSON.parse(row.json) as MediaModel[], fetchedAt: row.fetched_at };
}

const FETCHERS: Record<MediaKind, (o: OpenRouterClient) => Promise<MediaModel[]>> = {
  image: (o) => o.listImageModels(),
  video: (o) => o.listVideoModels(),
};

/** OpenRouter's image (or video) models, cached for a day; a failed refresh falls back to the cache, marked stale. */
export async function getMediaCatalog(db: DB, openrouter: OpenRouterClient, kind: MediaKind, refresh: boolean): Promise<MediaCatalog> {
  const cached = readCache(db, kind);
  if (cached && !refresh && Date.now() - cached.fetchedAt < CATALOG_TTL_MS) return { ...cached, stale: false };
  const fetch = FETCHERS[kind];
  try {
    const models = (await fetch(openrouter)).sort((a, b) => a.name.localeCompare(b.name));
    const fetchedAt = Date.now();
    db.prepare(
      'INSERT INTO media_catalog_cache (kind, fetched_at, json) VALUES (?, ?, ?) ON CONFLICT(kind) DO UPDATE SET fetched_at = excluded.fetched_at, json = excluded.json',
    ).run(kind, fetchedAt, JSON.stringify(models));
    return { models, fetchedAt, stale: false };
  } catch (err) {
    if (cached) return { ...cached, stale: true };
    throw new HttpError(502, (err as Error).message);
  }
}

/** A catalog model by id from the cache, however old; null when it isn't cached. */
export function cachedMediaModel(db: DB, kind: MediaKind, id: string): MediaModel | null {
  return readCache(db, kind)?.models.find((m) => m.id === id) ?? null;
}

/** The user's average cost per model, keyed "size|quality", from completed generations. */
function averages(db: DB, kind: MediaKind): Map<string, Record<string, number>> {
  const rows = db.prepare("SELECT model_id, settings, cost FROM media_events WHERE kind = ? AND status = 'complete' AND cost IS NOT NULL")
    .all(kind) as { model_id: string; settings: string; cost: number }[];
  const sums = new Map<string, Map<string, { total: number; n: number }>>();
  for (const r of rows) {
    const s = JSON.parse(r.settings) as { size?: string | null; quality?: string | null };
    const key = `${s.size ?? ''}|${s.quality ?? ''}`;
    const perModel = sums.get(r.model_id) ?? new Map();
    const acc = perModel.get(key) ?? { total: 0, n: 0 };
    perModel.set(key, { total: acc.total + r.cost, n: acc.n + 1 });
    sums.set(r.model_id, perModel);
  }
  return new Map([...sums].map(([id, m]) => [id, Object.fromEntries([...m].map(([k, v]) => [k, v.total / v.n]))]));
}

export function listMediaLibrary(db: DB, kind: MediaKind): MediaLibraryModel[] {
  const rows = db.prepare('SELECT id, display_name FROM media_models WHERE kind = ? ORDER BY added_at, id').all(kind) as { id: string; display_name: string }[];
  const catalog = readCache(db, kind)?.models ?? [];
  const avg = averages(db, kind);
  const render = new Map((db.prepare(
    "SELECT model_id, AVG(duration_ms) AS ms FROM media_events WHERE kind = ? AND status = 'complete' AND duration_ms IS NOT NULL GROUP BY model_id",
  ).all(kind) as { model_id: string; ms: number }[]).map((r) => [r.model_id, r.ms]));
  return rows.map((r) => ({
    id: r.id, displayName: r.display_name, kind, model: catalog.find((m) => m.id === r.id) ?? null, avgCost: avg.get(r.id) ?? {},
    avgRenderMs: render.get(r.id) ?? null,
  }));
}

export function addMediaModel(db: DB, kind: MediaKind, model: { id: string; name: string }): void {
  db.prepare('INSERT OR IGNORE INTO media_models (id, kind, display_name, added_at) VALUES (?, ?, ?, ?)').run(model.id, kind, model.name, now());
}

export function removeMediaModel(db: DB, kind: MediaKind, id: string): void {
  db.prepare('DELETE FROM media_models WHERE id = ? AND kind = ?').run(id, kind);
}
