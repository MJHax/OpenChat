import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Deps } from '../app';
import { HttpError } from '../http';
import { cleanFilename, cleanupPending, deletePending, detectKind, getAttachmentData, getAttachmentRow, insertPending } from '../attachments';
import { ATTACHMENT_LIMITS, MB, UNSUPPORTED_TYPE, emptyFileMessage, tooLargeMessage } from '../../../shared/attachments';

export function attachmentRoutes({ db }: Deps): Hono {
  const r = new Hono();

  r.post(
    '/',
    // Above the largest per-kind limit (PDF, 20 MB) plus multipart overhead; the exact limit is checked per kind below.
    bodyLimit({ maxSize: 21 * MB, onError: (c) => c.json({ error: 'That file is too large. The limit is 20 MB.' }, 413) }),
    async (c) => {
      const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
      const file = body.file;
      if (!(file instanceof File)) throw new HttpError(400, 'Attach a file.');
      const filename = cleanFilename(file.name);
      const raw = new Uint8Array(await file.arrayBuffer());
      if (raw.length === 0) throw new HttpError(400, emptyFileMessage(filename));
      const detected = detectKind(raw);
      if (!detected) throw new HttpError(400, UNSUPPORTED_TYPE);
      if (raw.length > ATTACHMENT_LIMITS[detected.kind]) throw new HttpError(413, tooLargeMessage(filename, detected.kind));
      cleanupPending(db);
      return c.json(insertPending(db, { filename, kind: detected.kind, mime: detected.mime, data: detected.bytes }), 201);
    },
  );

  r.get('/:id', (c) => {
    const id = c.req.param('id');
    const row = getAttachmentRow(db, id);
    const data = row && getAttachmentData(db, id);
    if (!row || !data) throw new HttpError(404, 'Attachment not found.');
    return c.body(new Uint8Array(data), 200, {
      'Content-Type': row.kind === 'text' ? 'text/plain; charset=utf-8' : row.mime,
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
      'Cache-Control': 'private, max-age=31536000, immutable',
    });
  });

  r.delete('/:id', (c) => {
    const result = deletePending(db, c.req.param('id'));
    if (result === 'missing') throw new HttpError(404, 'Attachment not found.');
    if (result === 'sent') throw new HttpError(409, 'This file is already part of a message.');
    return c.json({ ok: true });
  });

  return r;
}
