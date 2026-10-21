import { Hono } from 'hono';
import type { Deps } from '../app';
import { HttpError, readJson } from '../http';
import { getServer } from '../localServers';
import { localClientFor } from '../providers';
import { resolveApiKey } from '../settings';
import { parseLocalModelId } from '../../../shared/localModels';
import { toLocalModel } from './localServers';
import { getCatalog } from '../catalog';
import { withCatalogDefaults } from '../../../shared/types';
import { addLocalModel, addModel, setContextWindow, setLocalCaps, listLibrary, removeModel, renameModel, requireLibraryModel, setDefaultModel } from '../library';

const requireId = (id: unknown): string => {
  const value = typeof id === 'string' ? id.trim() : '';
  if (!value) throw new HttpError(400, 'Model id is required.');
  return value;
};

export function modelRoutes({ db, openrouter, env }: Deps): Hono {
  const r = new Hono();

  r.get('/', (c) => c.json(listLibrary(db)));

  r.get('/catalog', async (c) => c.json(await getCatalog(db, openrouter, c.req.query('refresh') === '1')));

  r.post('/', async (c) => {
    const id = requireId((await readJson<{ id?: string }>(c)).id);
    const local = parseLocalModelId(id);
    if (local) {
      const server = getServer(db, local.serverId);
      if (!server) throw new HttpError(404, "That server isn't in your list.");
      const listed = await localClientFor(server).listModels().catch((e: Error) => {
        throw new HttpError(502, e.message);
      });
      const found = listed.find((m) => m.name === local.name);
      if (!found) throw new HttpError(404, `That model isn't on ${server.name} any more.`);
      addLocalModel(db, toLocalModel(server.id, found));
      return c.json(listLibrary(db), 201);
    }
    if (!resolveApiKey(db, env).key) throw new HttpError(400, 'Add an OpenRouter key in Settings to use OpenRouter models.');
    const catalog = await getCatalog(db, openrouter, false).catch(() => null);
    const meta = catalog?.models.find((m) => m.id === id) ?? withCatalogDefaults({ id });
    addModel(db, meta);
    return c.json(listLibrary(db), 201);
  });

  r.patch('/', async (c) => {
    const body = await readJson<{ id?: string; displayName?: string; isDefault?: boolean; contextWindow?: number; supportsTools?: boolean; supportsImages?: boolean }>(c);
    const id = requireId(body.id);
    requireLibraryModel(db, id);
    if (body.contextWindow !== undefined) setContextWindow(db, id, body.contextWindow);
    if (body.supportsTools !== undefined || body.supportsImages !== undefined) {
      setLocalCaps(db, id, { supportsTools: body.supportsTools, supportsImages: body.supportsImages });
    }
    const name = body.displayName?.trim();
    if (name) renameModel(db, id, name);
    if (body.isDefault) setDefaultModel(db, id);
    return c.json(listLibrary(db));
  });

  r.delete('/', (c) => {
    removeModel(db, requireId(c.req.query('id')));
    return c.json(listLibrary(db));
  });

  return r;
}
