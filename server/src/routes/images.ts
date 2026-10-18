import { Hono } from 'hono';
import type { Deps } from '../app';
import { readJson } from '../http';
import { startImageGeneration, type ImageRequest } from '../imageGen';

/** POST /api/chats/:id/images: starts an image and answers at once (202); the thread shows it when it lands. */
export function imageRoutes(deps: Deps): Hono {
  const r = new Hono();

  r.post('/:id/images', async (c) => {
    const body = await readJson<ImageRequest>(c);
    return c.json(await startImageGeneration(deps, c.req.param('id'), body), 202);
  });

  return r;
}
