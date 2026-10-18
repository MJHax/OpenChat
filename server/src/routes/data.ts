import { Hono } from 'hono';
import type { Deps } from '../app';
import { HttpError, readJson } from '../http';
import { cleanUp, DELETE_TARGETS, deleteData, storageUsage } from '../dataStore';
import { exportEntries } from '../exportData';
import { toWebStream, zipStream } from '../zip';
import type { DeleteTarget } from '../../../shared/types';

/** Settings › Data: storage use, clean up, export, and the delete actions. */
export function dataRoutes(deps: Deps): Hono {
  const r = new Hono();

  r.get('/storage', (c) => c.json(storageUsage(deps)));

  r.post('/cleanup', (c) => {
    cleanUp(deps.db);
    return c.json(storageUsage(deps));
  });

  r.get('/export', (c) => {
    const day = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD, local
    return c.body(toWebStream(zipStream(exportEntries(deps))), 200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="openchat-export-${day}.zip"`,
      'Cache-Control': 'no-store',
    });
  });

  r.post('/delete', async (c) => {
    const body = await readJson<{ target?: unknown; confirm?: unknown }>(c);
    if (!DELETE_TARGETS.includes(body.target as DeleteTarget)) throw new HttpError(400, 'Unknown delete target.');
    if (body.confirm !== 'DELETE') throw new HttpError(400, 'Type DELETE to confirm.');
    return c.json({ ok: true, ...deleteData(deps, body.target as DeleteTarget) });
  });

  return r;
}
