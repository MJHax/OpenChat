import { createReadStream, existsSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import type { Deps } from '../app';
import { HttpError, readJson } from '../http';
import { clipPath, startVideoGeneration, type VideoRequest } from '../videoJobs';

/** POST /api/chats/:id/videos starts a clip (202); the server-side poller finishes it. */
export function videoGenerationRoutes(deps: Deps): Hono {
  const r = new Hono();
  r.post('/:id/videos', async (c) => c.json(await startVideoGeneration(deps, c.req.param('id'), await readJson<VideoRequest>(c)), 202));
  return r;
}

/** GET /api/videos/:messageId serves a finished clip, with byte ranges so the player can seek. */
export function videoFileRoutes({ mediaDir }: Deps): Hono {
  const r = new Hono();
  r.get('/:messageId', (c) => {
    const id = c.req.param('messageId');
    if (!/^[\w-]+$/.test(id)) throw new HttpError(404, 'Video not found.');
    const file = clipPath(mediaDir, id);
    if (!existsSync(file)) throw new HttpError(404, 'Video not found.');
    const size = statSync(file).size;
    const headers: Record<string, string> = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=31536000, immutable' };
    const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header('range') ?? '');
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start >= size || start > end) return c.body(null, 416, { 'Content-Range': `bytes */${size}` });
      const body = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream;
      return c.body(body, 206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) });
    }
    return c.body(Readable.toWeb(createReadStream(file)) as ReadableStream, 200, { ...headers, 'Content-Length': String(size) });
  });
  return r;
}
