import { Hono } from 'hono';
import type { Deps } from '../app';
import { HttpError, readJson } from '../http';
import { detectLocalServers, modelAvailability, probeServers, serverStatuses } from '../localDetect';
import { addServer, findServer, getServer, removeServer, updateServer } from '../localServers';
import { localClientFor } from '../providers';
import type { LocalModelInfo } from '../providers/types';
import { SERVER_TYPE_NAMES, localModelId, normalizeBaseUrl } from '../../../shared/localModels';
import type { LocalServerType } from '../../../shared/localModels';
import type { LocalCatalog, LocalModel } from '../../../shared/types';

const TYPES: LocalServerType[] = ['ollama', 'lmstudio', 'openai'];
const NOT_LISTED = "That server isn't in your list.";

function cleanAddress(baseUrl: unknown): string {
  try {
    return normalizeBaseUrl(typeof baseUrl === 'string' ? baseUrl : '');
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
}

function cleanName(name: unknown): string {
  const text = typeof name === 'string' ? name.trim() : '';
  if (!text) throw new HttpError(400, 'Name is required.');
  return text;
}

/** "an Ollama server", "an LM Studio server", "an OpenAI-compatible server". */
const KIND_PHRASE: Record<LocalServerType, string> = {
  ollama: 'an Ollama server',
  lmstudio: 'an LM Studio server',
  openai: 'an OpenAI-compatible server',
};

/** A server is only saved at an address that answers. */
async function checkConnection(type: LocalServerType, name: string, baseUrl: string): Promise<void> {
  try {
    await localClientFor({ id: '', type, name: name || SERVER_TYPE_NAMES[type], baseUrl, auto: false, enabled: true }).listModels();
  } catch (e) {
    // Status 0 is "nobody answered"; any other status means something answered, but not like this kind of server.
    const status = (e as { status?: number }).status ?? 0;
    throw new HttpError(400, status > 0 ? `Couldn't connect: ${baseUrl} doesn't look like ${KIND_PHRASE[type]}.` : `Couldn't connect: ${(e as Error).message}`);
  }
}

/** A model as the library and the picker show it. */
export function toLocalModel(serverId: string, m: LocalModelInfo): LocalModel {
  return {
    id: localModelId(serverId, m.name),
    serverId,
    name: m.name,
    sizeBytes: m.sizeBytes,
    contextLength: m.contextLength,
    inputModalities: m.inputModalities,
    supportsTools: m.supportsTools,
    supportsReasoning: m.supportsReasoning,
    capsKnown: m.capsKnown,
  };
}

export function localServerRoutes(deps: Deps): Hono {
  const { db } = deps;
  const r = new Hono();
  // Read per request so tests can point detection at fake servers.
  const detect = (force: boolean) => detectLocalServers(db, { force, candidates: deps.localCandidates });

  r.get('/', async (c) => {
    await detect(false);
    return c.json(await serverStatuses(db));
  });

  r.post('/detect', async (c) => {
    await detect(true);
    return c.json(await serverStatuses(db));
  });

  r.get('/models', async (c) => {
    await detect(false);
    const probes = await probeServers(db);
    const update = db.prepare('UPDATE models SET context_length = ?, input_modalities = ?, supports_tools = ?, supports_reasoning = ?, '
      + 'context_window = CASE WHEN ? IS NOT NULL AND context_window > ? THEN ? ELSE context_window END WHERE id = ?');
    const models: LocalModel[] = [];
    for (const { status, models: found } of probes) {
      if (!status.online) continue;
      for (const m of found) {
        const model = toLocalModel(status.id, m);
        const id = model.id;
        models.push(model);
        // OpenAI-compatible servers report nothing, so their capabilities are the user's; a listing whose capability
        // lookup failed must not overwrite what is known.
        if (status.type !== 'openai' && m.capsKnown) {
          update.run(m.contextLength, JSON.stringify(m.inputModalities), m.supportsTools ? 1 : 0, m.supportsReasoning ? 1 : 0, m.contextLength, m.contextLength, m.contextLength, id);
        }
      }
    }
    const catalog: LocalCatalog = { servers: probes.map((p) => p.status), models };
    return c.json(catalog);
  });

  r.get('/availability', async (c) => c.json(await modelAvailability(db)));

  r.post('/', async (c) => {
    const body = await readJson<{ type?: unknown; name?: unknown; baseUrl?: unknown }>(c);
    if (typeof body.type !== 'string' || !TYPES.includes(body.type as LocalServerType)) {
      throw new HttpError(400, 'type must be ollama, lmstudio or openai.');
    }
    const type = body.type as LocalServerType;
    const name = cleanName(body.name);
    const baseUrl = cleanAddress(body.baseUrl);
    if (findServer(db, type, baseUrl)) throw new HttpError(409, 'That server is already in your list.');
    await checkConnection(type, name, baseUrl);
    addServer(db, { type, name, baseUrl, auto: false });
    return c.json(await serverStatuses(db), 201);
  });

  r.patch('/:id', async (c) => {
    const id = c.req.param('id');
    const current = getServer(db, id);
    if (!current) throw new HttpError(404, NOT_LISTED);
    const body = await readJson<{ name?: unknown; baseUrl?: unknown; enabled?: unknown }>(c);
    const patch: { name?: string; baseUrl?: string; enabled?: boolean } = {};
    if (body.name !== undefined) patch.name = cleanName(body.name);
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled must be true or false.');
      patch.enabled = body.enabled;
    }
    if (body.baseUrl !== undefined) {
      patch.baseUrl = cleanAddress(body.baseUrl);
      if (patch.baseUrl !== current.baseUrl) {
        const clash = findServer(db, current.type, patch.baseUrl);
        if (clash && clash.id !== id) throw new HttpError(409, 'That server is already in your list.');
        await checkConnection(current.type, patch.name ?? current.name, patch.baseUrl);
      }
    }
    updateServer(db, id, patch);
    return c.json(await serverStatuses(db));
  });

  r.delete('/:id', async (c) => {
    const id = c.req.param('id');
    if (!getServer(db, id)) throw new HttpError(404, NOT_LISTED);
    removeServer(db, id);
    return c.json(await serverStatuses(db));
  });

  return r;
}
