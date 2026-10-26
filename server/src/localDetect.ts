import type { DB } from './db';
import { addServer, findServer, listServers } from './localServers';
import { localClientFor } from './providers';
import type { LocalModelInfo } from './providers/types';
import { DETECT_CANDIDATES, SERVER_TYPE_NAMES, localModelId, parseLocalModelId } from '../../shared/localModels';
import type { LocalAvailability, LocalServerStatus } from '../../shared/types';

/** The detection addresses, on another machine when OPENCHAT_DETECT_HOST names one (in Docker, host.docker.internal). */
export function detectCandidates(host?: string): typeof DETECT_CANDIDATES {
  const name = host?.trim();
  if (!name) return DETECT_CANDIDATES;
  return DETECT_CANDIDATES.map((c) => ({ ...c, baseUrl: c.baseUrl.replace('localhost', name) }));
}

/**
 * Looks for servers already running on this machine and lists the ones that answer. A server the user removed is only
 * brought back when `force` is set (the "Detect again" button), so removing one sticks across restarts.
 */
export async function detectLocalServers(db: DB, o: { force?: boolean; candidates?: typeof DETECT_CANDIDATES } = {}): Promise<void> {
  await Promise.all(
    (o.candidates ?? DETECT_CANDIDATES).map(async (c) => {
      // Nothing to do for a listed server, or a removed one when not forced: skip the request.
      const existing = findServer(db, c.type, c.baseUrl, { includeRemoved: true });
      if (existing && (!existing.removed || !o.force)) return;
      try {
        await localClientFor({ id: '', type: c.type, name: '', baseUrl: c.baseUrl, auto: true, enabled: true }).listModels();
      } catch {
        return; // not running
      }
      try {
        addServer(db, { type: c.type, name: SERVER_TYPE_NAMES[c.type], baseUrl: c.baseUrl, auto: true });
      } catch {
        // listed meanwhile by someone else
      }
    }),
  );
}

export interface ServerProbe {
  status: LocalServerStatus;
  models: LocalModelInfo[];
}

/** Pings every listed server in parallel; a turned-off server is offline without a request. */
export async function probeServers(db: DB): Promise<ServerProbe[]> {
  return Promise.all(
    listServers(db).map(async (server): Promise<ServerProbe> => {
      if (!server.enabled) return { status: { ...server, online: false, modelCount: null, error: null }, models: [] };
      try {
        const models = await localClientFor(server).listModels();
        return { status: { ...server, online: true, modelCount: models.length, error: null }, models };
      } catch (e) {
        return { status: { ...server, online: false, modelCount: null, error: (e as Error).message }, models: [] };
      }
    }),
  );
}

/** Every local model in My models, by whether its server is turned off, silent, or answering without it. One probe, no detection. */
export async function modelAvailability(db: DB): Promise<Record<string, LocalAvailability>> {
  const probes = new Map((await probeServers(db)).map((p) => [p.status.id, p]));
  const out: Record<string, LocalAvailability> = {};
  for (const { id } of db.prepare("SELECT id FROM models WHERE id LIKE 'local:%'").all() as { id: string }[]) {
    const parsed = parseLocalModelId(id);
    const probe = parsed && probes.get(parsed.serverId);
    if (!parsed || !probe) continue;
    out[id] = !probe.status.enabled ? 'off' : !probe.status.online ? 'offline' : probe.models.some((m) => localModelId(parsed.serverId, m.name) === id) ? 'ready' : 'missing';
  }
  return out;
}

export async function serverStatuses(db: DB): Promise<LocalServerStatus[]> {
  return (await probeServers(db)).map((p) => p.status);
}
