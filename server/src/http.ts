import type { Context } from 'hono';

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

/** RFC 5987 value-chars: encodeURIComponent leaves `'()*` alone, but they are not allowed unencoded. */
export const rfc5987 = (value: string) => encodeURIComponent(value).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** Only real JSON requests: a "simple" text/plain POST can be sent cross-origin without the browser asking first. */
export async function readJson<T>(c: Context): Promise<T> {
  if (!/^application\/json\b/i.test(c.req.header('content-type') ?? '')) throw new HttpError(415, 'Request body must be JSON.');
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new HttpError(400, 'Request body must be JSON.');
  }
}
