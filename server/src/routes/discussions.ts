import { Hono } from 'hono';
import type { Deps } from '../app';
import { readJson } from '../http';
import { createDiscussion, getDiscussionDetail } from '../discussion/store';
import type { NewDiscussion } from '../../../shared/types';

export function discussionRoutes(deps: Deps): Hono {
  const { db } = deps;
  const r = new Hono();

  r.post('/', async (c) => c.json(createDiscussion(db, await readJson<NewDiscussion>(c)), 201));

  r.get('/:id', (c) => c.json(getDiscussionDetail(db, c.req.param('id'))));

  return r;
}
