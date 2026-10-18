import { Hono } from 'hono';
import type { Deps } from '../app';
import { readJson } from '../http';
import { getSettingsView, resolveApiKey, updateSettings } from '../settings';
import { limitStatuses } from '../limits';
import type { SettingsUpdate } from '../../../shared/types';

export function settingsRoutes({ db, env, openrouter }: Deps): Hono {
  const r = new Hono();

  r.get('/', (c) => c.json(getSettingsView(db, env)));

  r.put('/', async (c) => {
    updateSettings(db, await readJson<SettingsUpdate>(c));
    return c.json(getSettingsView(db, env));
  });

  r.get('/limits', (c) => c.json(limitStatuses(db)));

  r.post('/test-key', async (c) => {
    const { key } = resolveApiKey(db, env);
    if (!key) return c.json({ ok: false, error: 'No API key set.' });
    try {
      await openrouter.checkKey(key);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message });
    }
  });

  return r;
}
