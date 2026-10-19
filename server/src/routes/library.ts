import { Hono } from 'hono';
import type { Deps } from '../app';
import { HttpError, rfc5987 } from '../http';
import { chatFileText, libraryItems } from '../fileLibrary';

/** GET /api/library lists every uploaded and generated file; /files/:messageId/:name serves a file a reply wrote. */
export function libraryRoutes({ db, mediaDir }: Deps): Hono {
  const r = new Hono();
  r.get('/', (c) => c.json(libraryItems(db, mediaDir)));
  r.get('/files/:messageId/:name', (c) => {
    const name = c.req.param('name');
    const text = chatFileText(db, c.req.param('messageId'), name);
    if (text === undefined) throw new HttpError(404, 'That file is no longer available.');
    return c.body(text, 200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `inline; filename*=UTF-8''${rfc5987(name)}`,
    });
  });
  return r;
}
