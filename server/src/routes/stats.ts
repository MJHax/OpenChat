import { Hono } from 'hono';
import type { Deps } from '../app';
import { HttpError } from '../http';
import { chatTitles, computeStats, modelNames } from '../stats';
import { isValidZone } from '../statsTime';
import { loadUsageRows } from '../usage';
import type { StatsRange } from '../../../shared/types';

const RANGES: StatsRange[] = ['all', 'year', 'month', 'week', 'today'];

export function statsRoutes({ db }: Deps): Hono {
  const r = new Hono();

  r.get('/', (c) => {
    const range = c.req.query('range') as StatsRange;
    const tz = c.req.query('tz') ?? '';
    if (!RANGES.includes(range)) throw new HttpError(400, 'Unknown range.');
    if (!isValidZone(tz)) throw new HttpError(400, 'Unknown time zone.');
    return c.json(computeStats({ rows: loadUsageRows(db, null), range, now: Date.now(), tz, chatTitles: chatTitles(db), modelNames: modelNames(db) }));
  });

  return r;
}
