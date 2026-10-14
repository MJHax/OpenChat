import { Hono } from 'hono';
import type { Deps } from '../app';
import { searchMessages } from '../search';

export function searchRoutes({ db }: Deps): Hono {
  const r = new Hono();
  r.get('/', (c) => c.json(searchMessages(db, c.req.query('q') ?? '')));
  return r;
}
