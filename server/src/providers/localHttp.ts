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
