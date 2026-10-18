import { Hono } from 'hono';
import type { Deps } from '../app';
import { HttpError } from '../http';
import { chatTitles, computeStats, modelNames } from '../stats';
import { allSpend, computeMediaStats, loadMediaEvents } from '../mediaStats';
import { isValidZone } from '../statsTime';
import { loadUsageRows } from '../usage';
import type { MediaKind, StatsRange } from '../../../shared/types';

const RANGES: StatsRange[] = ['all', 'year', 'month', 'week', 'today'];
const VIEWS: Record<string, MediaKind | 'chats'> = { chats: 'chats', images: 'image', video: 'video' };

export function statsRoutes({ db }: Deps): Hono {
  const r = new Hono();

  r.get('/', (c) => {
    const range = c.req.query('range') as StatsRange;
    const tz = c.req.query('tz') ?? '';
    const view = VIEWS[c.req.query('view') ?? 'chats'];
    if (!RANGES.includes(range)) throw new HttpError(400, 'Unknown range.');
    if (!isValidZone(tz)) throw new HttpError(400, 'Unknown time zone.');
    if (!view) throw new HttpError(400, 'Unknown view.');
    const now = Date.now();
    const usage = loadUsageRows(db, null);
    const events = loadMediaEvents(db, null);
    const total = allSpend(usage, events, range, now, tz);
    if (view === 'chats') {
      // Discussions are conversations too: their replies count with chats.
      const rows = usage.filter((u) => u.threadKind === 'chat' || u.threadKind === 'discussion');
      return c.json({ ...computeStats({ rows, range, now, tz, chatTitles: chatTitles(db), modelNames: mediaAwareNames(db) }), allSpend: total });
    }
    return c.json({
      ...computeMediaStats({ events, titleRows: usage.filter((u) => u.purpose === 'title'), range, now, tz, modelNames: mediaAwareNames(db), kind: view }),
      allSpend: total,
    });
  });

  return r;
}

/** Chat model names, plus the names of image and video models in the user's lists. */
function mediaAwareNames(db: Deps['db']): Map<string, string> {
  const names = modelNames(db);
  const media = db.prepare('SELECT id, display_name FROM media_models').all() as { id: string; display_name: string }[];
  for (const m of media) if (!names.has(m.id)) names.set(m.id, m.display_name);
  return names;
}
