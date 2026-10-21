import type { DB } from './db';
import { newId, now } from './db';
import { HttpError } from './http';
import { removeModel } from './library';
import { normalizeBaseUrl } from '../../shared/localModels';
import type { LocalServerType } from '../../shared/localModels';
import type { LocalServer } from '../../shared/types';

interface ServerRow {
  id: string;
  type: LocalServerType;
  name: string;
  base_url: string;
  auto: number;
  enabled: number;
  removed_at: number | null;
}

const toServer = (r: ServerRow): LocalServer => ({
  id: r.id,
  type: r.type,
  name: r.name,
  baseUrl: r.base_url,
  auto: r.auto === 1,
  enabled: r.enabled === 1,
});

export function listServers(db: DB): LocalServer[] {
  const rows = db.prepare('SELECT * FROM local_servers WHERE removed_at IS NULL ORDER BY created_at').all() as ServerRow[];
  return rows.map(toServer);
}

export function getServer(db: DB, id: string): LocalServer | null {
  const row = db.prepare('SELECT * FROM local_servers WHERE id = ? AND removed_at IS NULL').get(id) as ServerRow | undefined;
  return row ? toServer(row) : null;
}

export function findServer(
  db: DB,
  type: LocalServerType,
  baseUrl: string,
  o: { includeRemoved?: boolean } = {},
): (LocalServer & { removed: boolean }) | null {
  const url = normalizeBaseUrl(baseUrl);
  const row = db
    .prepare(`SELECT * FROM local_servers WHERE type = ? AND base_url = ? ${o.includeRemoved ? '' : 'AND removed_at IS NULL'} ORDER BY removed_at IS NOT NULL, created_at LIMIT 1`)
    .get(type, url) as ServerRow | undefined;
  return row ? { ...toServer(row), removed: row.removed_at !== null } : null;
}

function normalizeOrThrow(baseUrl: string): string {
  try {
    return normalizeBaseUrl(baseUrl);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
}

export function addServer(db: DB, s: { type: LocalServerType; name: string; baseUrl: string; auto: boolean }): LocalServer {
  const baseUrl = normalizeOrThrow(s.baseUrl);
  const existing = findServer(db, s.type, baseUrl, { includeRemoved: true });
  if (existing && !existing.removed) throw new HttpError(409, 'That server is already in your list.');
  if (existing) {
    db.prepare('UPDATE local_servers SET removed_at = NULL, name = ?, enabled = 1 WHERE id = ?').run(s.name, existing.id);
    return getServer(db, existing.id)!;
  }
  const id = newId().replace(/-/g, '').slice(0, 8);
  db.prepare('INSERT INTO local_servers (id, type, name, base_url, auto, enabled, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)').run(
    id, s.type, s.name, baseUrl, s.auto ? 1 : 0, now(),
  );
  return getServer(db, id)!;
}

export function updateServer(db: DB, id: string, patch: { name?: string; baseUrl?: string; enabled?: boolean }): LocalServer {
  const current = getServer(db, id);
  if (!current) throw new HttpError(404, 'Server not found.');
  const baseUrl = patch.baseUrl === undefined ? current.baseUrl : normalizeOrThrow(patch.baseUrl);
  if (baseUrl !== current.baseUrl) {
    const clash = findServer(db, current.type, baseUrl);
    if (clash && clash.id !== id) throw new HttpError(409, 'That server is already in your list.');
  }
  db.prepare('UPDATE local_servers SET name = ?, base_url = ?, enabled = ? WHERE id = ?').run(
    patch.name ?? current.name, baseUrl, (patch.enabled ?? current.enabled) ? 1 : 0, id,
  );
  return getServer(db, id)!;
}

/** Hides the server and drops its models; chat history keeps the ids, and the row is kept so re-adding restores the id. */
export function removeServer(db: DB, id: string): void {
  db.transaction(() => {
    db.prepare('UPDATE local_servers SET removed_at = ? WHERE id = ?').run(now(), id);
    const prefix = `local:${id}:`;
    const ids = db.prepare('SELECT id FROM models WHERE substr(id, 1, ?) = ?').all(prefix.length, prefix) as { id: string }[];
    for (const m of ids) removeModel(db, m.id);
  })();
}
