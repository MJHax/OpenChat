import type { StreamEvent } from '../openrouter';
import type { LoadState } from './types';

type Raced =
  | { k: 'event'; r: IteratorResult<StreamEvent> }
  | { k: 'loading' }
  | { k: 'waiting' }
  | { k: 'load'; state: LoadState | null };

/**
 * Passes `events` through unchanged, adding a `status` event while no first event has arrived: `loading` once the server
 * confirms (after `loadingAfterMs`) that the model isn't in memory, else `waiting` after `waitingAfterMs`.
 */
export async function* withLoadingStatus(
  events: AsyncGenerator<StreamEvent>,
  loadState: () => Promise<LoadState | null>,
  o: { loadingAfterMs?: number; waitingAfterMs?: number } = {},
): AsyncGenerator<StreamEvent> {
  const timers: ReturnType<typeof setTimeout>[] = [];
  const after = (ms: number, k: 'loading' | 'waiting') =>
    new Promise<Raced>((resolve) => timers.push(setTimeout(() => resolve({ k }), ms)));
  let finished = false;
  // One next() stays outstanding across timer wake-ups; a second would skip or reorder events.
  let pending: Promise<Raced> | null = events
    .next()
    .then((r): Raced => ({ k: 'event', r }));
  try {
    let loadingTimer: Promise<Raced> | null = after(o.loadingAfterMs ?? 2_000, 'loading');
    let waitingTimer: Promise<Raced> | null = after(o.waitingAfterMs ?? 5_000, 'waiting');
    let load: Promise<Raced> | null = null;
    let first: IteratorResult<StreamEvent> | null = null;
    while (!first) {
      const candidates = [pending, loadingTimer, waitingTimer, load].filter((p): p is Promise<Raced> => p !== null);
      const got = await Promise.race(candidates);
      if (got.k === 'event') {
        pending = null;
        first = got.r;
      } else if (got.k === 'loading') {
        loadingTimer = null;
        // A loadState that fails or loses the race is harmless; its rejection is absorbed here.
        load = loadState().then((state): Raced => ({ k: 'load', state }), (): Raced => ({ k: 'load', state: null }));
      } else if (got.k === 'load') {
        load = null;
        if (got.state?.loaded === false) {
          waitingTimer = null;
          yield { type: 'status', status: 'loading' };
        }
      } else {
        waitingTimer = null;
        loadingTimer = null;
        load = null;
        yield { type: 'status', status: 'waiting' };
      }
    }
    for (let r = first; ; r = await events.next()) {
      if (r.done) {
        finished = true;
        return;
      }
      yield r.value;
    }
  } finally {
    timers.forEach(clearTimeout);
    if (!finished) {
      // Stopped while a next() may be outstanding: ask the inner stream to end without waiting on it.
      pending?.catch(() => {});
      const closing = events.return(undefined);
      if (pending) void closing.catch(() => {});
      else await closing;
    }
  }
}
