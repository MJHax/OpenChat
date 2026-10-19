import { Hono } from 'hono';
import type { Deps } from '../app';
import { HttpError, readJson } from '../http';
import { addMediaModel, getMediaCatalog, listMediaLibrary, removeMediaModel, requireMediaKind, requireMediaModel, setDefaultMediaModel } from '../mediaLibrary';

/** Image and video models: the user's lists (?kind=image|video) and OpenRouter's catalogs. */
export function mediaModelRoutes({ db, openrouter }: Deps): Hono {
  const r = new Hono();

  r.get('/', (c) => c.json(listMediaLibrary(db, requireMediaKind(c.req.query('kind')))));

  r.get('/catalog', async (c) =>
    c.json(await getMediaCatalog(db, openrouter, requireMediaKind(c.req.query('kind')), c.req.query('refresh') === '1')));

  r.post('/', async (c) => {
    const body = await readJson<{ id?: string; kind?: string }>(c);
    const kind = requireMediaKind(body.kind);
    const catalog = await getMediaCatalog(db, openrouter, kind, false);
    const model = catalog.models.find((m) => m.id === body.id);
    if (!model) throw new HttpError(400, 'That model is not in the catalog.');
    addMediaModel(db, kind, model);
    return c.json(listMediaLibrary(db, kind), 201);
  });

  r.patch('/', async (c) => {
    const body = await readJson<{ id?: string; kind?: string; isDefault?: boolean }>(c);
    const kind = requireMediaKind(body.kind);
    requireMediaModel(db, kind, body.id ?? '');
    if (body.isDefault) setDefaultMediaModel(db, kind, body.id!);
    return c.json(listMediaLibrary(db, kind));
  });

  r.delete('/', (c) => {
    const kind = requireMediaKind(c.req.query('kind'));
    removeMediaModel(db, kind, c.req.query('id') ?? '');
    return c.json(listMediaLibrary(db, kind));
  });

  return r;
}
