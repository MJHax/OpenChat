import { hostOf } from '../../../shared/localModels';
import { LocalServerError } from './types';

const isAbort = (e: unknown) => (e as { name?: string } | null)?.name === 'AbortError';

async function errorDetail(res: Response): Promise<string> {
  try {
    const body = JSON.parse(await res.text());
    const err = body?.error;
    if (typeof err === 'string' && err) return err;
    if (typeof err?.message === 'string' && err.message) return err.message;
  } catch {
    // fall through to the status text
  }
  return res.statusText || `HTTP ${res.status}`;
}

/** The JSON body of a listing answer. The call's timeout is still armed while the body arrives, so a stall reads as unreachable. */
export async function readListing(res: Response, server: { name: string; baseUrl: string }): Promise<any> {
  try {
    return await res.json();
  } catch {
    throw new LocalServerError(`Can't reach ${server.name} at ${hostOf(server.baseUrl)}. Is it running?`, 0);
  }
}

/**
 * A response body that fails with a plain LocalServerError when the server goes away mid-reply. A read error caused by
 * the caller's own abort passes through unchanged.
 */
export function guardBody(
  body: ReadableStream<Uint8Array>,
  server: { name: string; baseUrl: string },
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (e) {
        if (signal?.aborted || isAbort(e)) controller.error(e);
        else controller.error(new LocalServerError(`Lost the connection to ${server.name} at ${hostOf(server.baseUrl)}.`, 0));
      }
    },
    cancel: (reason) => reader.cancel(reason),
  });
}

/** fetch for a local server: unreachable or slow servers and non-2xx answers become LocalServerError. */
export async function localFetch(
  server: { name: string; baseUrl: string },
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const { timeoutMs, signal, ...rest } = init;
  const signals = [signal, timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined].filter((s): s is AbortSignal => !!s);
  let res: Response;
  try {
    res = await fetchImpl(server.baseUrl.replace(/\/+$/, '') + path, {
      ...rest,
      signal: signals.length ? AbortSignal.any(signals) : undefined,
    });
  } catch (e) {
    if (signal?.aborted && isAbort(e)) throw e;
    throw new LocalServerError(`Can't reach ${server.name} at ${hostOf(server.baseUrl)}. Is it running?`, 0);
  }
  if (!res.ok) throw new LocalServerError(`${server.name} couldn't run this model: ${await errorDetail(res)}`, res.status);
  return res;
}
