import { Hono } from 'hono';
import type { Deps } from '../app';
import { HttpError, readJson } from '../http';
import { getCatalog } from '../catalog';
import { addModel, listLibrary, removeModel, renameModel, requireLibraryModel, setDefaultModel } from '../library';

const requireId = (id: unknown): string => {
  const value = typeof id === 'string' ? id.trim() : '';
  if (!value) throw new HttpError(400, 'Model id is required.');
  return value;
};

export function modelRoutes({ db, openrouter }: Deps): Hono {
  const r = new Hono();

  r.get('/', (c) => c.json(listLibrary(db)));

  r.get('/catalog', async (c) => c.json(await getCatalog(db, openrouter, c.req.query('refresh') === '1')));

  r.post('/', async (c) => {
    const id = requireId((await readJson<{ id?: string }>(c)).id);
    const catalog = await getCatalog(db, openrouter, false).catch(() => null);
    const meta = catalog?.models.find((m) => m.id === id) ?? { id, name: id, contextLength: null, promptPrice: null, completionPrice: null };
    addModel(db, meta);
    return c.json(listLibrary(db), 201);
  });

  r.patch('/', async (c) => {
    const body = await readJson<{ id?: string; displayName?: string; isDefault?: boolean }>(c);
    const id = requireId(body.id);
    requireLibraryModel(db, id);
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
