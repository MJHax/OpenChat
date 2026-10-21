import { describe, expect, it, vi } from 'vitest';
import { withLoadingStatus } from '../src/providers/loadingStatus';
import type { StreamEvent } from '../src/openrouter';
import type { LoadState } from '../src/providers/types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TIMINGS = { loadingAfterMs: 20, waitingAfterMs: 60 };

/** An inner stream whose first event arrives after `firstMs`. */
async function* scripted(firstMs: number, onReturn?: () => void): AsyncGenerator<StreamEvent> {
  try {
    await sleep(firstMs);
    yield { type: 'delta', text: 'a' };
    yield { type: 'delta', text: 'b' };
  } finally {
    onReturn?.();
  }
}
const collect = async (gen: AsyncGenerator<StreamEvent>) => {
  const out: string[] = [];
  for await (const e of gen) out.push(e.type === 'status' ? e.status : e.type === 'delta' ? e.text : e.type);
  return out;
};
const state = (loaded: boolean): LoadState => ({ loaded, contextWindow: null });

describe('withLoadingStatus', () => {
  it('says loading when the server reports the model is not loaded, and not waiting too', async () => {
    const loadState = vi.fn(async () => state(false));
    expect(await collect(withLoadingStatus(scripted(150), loadState, TIMINGS))).toEqual(['loading', 'a', 'b']);
    expect(loadState).toHaveBeenCalledTimes(1);
  });

  it('says waiting when the load state is unknown', async () => {
    expect(await collect(withLoadingStatus(scripted(150), async () => null, TIMINGS))).toEqual(['waiting', 'a', 'b']);
  });

  it('says waiting at the later timer when the model is already loaded', async () => {
    expect(await collect(withLoadingStatus(scripted(150), async () => state(true), TIMINGS))).toEqual(['waiting', 'a', 'b']);
  });

  it('says waiting when loadState fails', async () => {
    const failing = async (): Promise<LoadState | null> => {
      throw new Error('boom');
    };
    expect(await collect(withLoadingStatus(scripted(150), failing, TIMINGS))).toEqual(['waiting', 'a', 'b']);
  });

  it('says nothing when the first event comes quickly, and never asks the server', async () => {
    const loadState = vi.fn(async () => state(false));
    expect(await collect(withLoadingStatus(scripted(5), loadState, TIMINGS))).toEqual(['a', 'b']);
    await sleep(100);
    expect(loadState).not.toHaveBeenCalled();
  });

  it('ignores a loadState that answers after the first event', async () => {
    const slow = async () => {
      await sleep(80);
      return state(false);
    };
    expect(await collect(withLoadingStatus(scripted(50), slow, TIMINGS))).toEqual(['a', 'b']);
    await sleep(120);
  });

  it('ends the inner stream when the consumer returns', async () => {
    const onReturn = vi.fn();
    const gen = withLoadingStatus(scripted(150, onReturn), async () => state(false), TIMINGS);
    expect((await gen.next()).value).toEqual({ type: 'status', status: 'loading' });
    await gen.return(undefined);
    await sleep(200);
    expect(onReturn).toHaveBeenCalled();
  });

  it('ends the inner stream when the consumer stops after the first event', async () => {
    const onReturn = vi.fn();
    const gen = withLoadingStatus(scripted(5, onReturn), async () => null, TIMINGS);
    await gen.next();
    await gen.return(undefined);
    expect(onReturn).toHaveBeenCalled();
  });

  it('passes an inner error through', async () => {
    async function* broken(): AsyncGenerator<StreamEvent> {
      await sleep(30);
      throw new Error('lost');
    }
    await expect(collect(withLoadingStatus(broken(), async () => state(false), TIMINGS))).rejects.toThrow('lost');
  });
});
