import { Hono } from 'hono';
import { createWriteStream, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { Deps } from '../app';
import { HttpError, readJson } from '../http';
import { cleanUp, DELETE_TARGETS, deleteData, storageUsage } from '../dataStore';
import { exportEntries } from '../exportData';
import { toWebStream, zipStream } from '../zip';
import { restoreBackup } from '../restore';
import { detectLocalServers } from '../localDetect';
import type { DeleteTarget } from '../../../shared/types';

/** Settings › Data: storage use, clean up, export, import, and the delete actions. */
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

  // The body is the export zip itself, streamed to disk: a backup can be far larger than memory should hold.
  r.post('/import', async (c) => {
    if (c.req.query('confirm') !== 'REPLACE') throw new HttpError(400, 'Type REPLACE to confirm.');
    const body = c.req.raw.body;
    if (!body) throw new HttpError(400, 'Choose a backup file to import.');
    const dir = mkdtempSync(join(tmpdir(), 'openchat-import-'));
    try {
      const file = join(dir, 'backup.zip');
      await pipeline(Readable.fromWeb(body as WebReadableStream<Uint8Array>), createWriteStream(file));
      await restoreBackup(deps, file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // The backup may come from a machine where Ollama or LM Studio was at another address.
    void detectLocalServers(deps.db, { candidates: deps.localCandidates }).catch(() => {});
    return c.json({ ok: true });
  });

  r.post('/delete', async (c) => {
    const body = await readJson<{ target?: unknown; confirm?: unknown }>(c);
    if (!DELETE_TARGETS.includes(body.target as DeleteTarget)) throw new HttpError(400, 'Unknown delete target.');
    if (body.confirm !== 'DELETE') throw new HttpError(400, 'Type DELETE to confirm.');
    return c.json({ ok: true, ...deleteData(deps, body.target as DeleteTarget) });
  });

  return r;
}
