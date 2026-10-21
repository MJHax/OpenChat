import { describe, it, expect } from 'vitest';
import { makeApp, readEvents } from './appHelpers';
import type { OpenRouterClient, StreamEvent } from '../src/openrouter';
import { addModel } from '../src/library';
import { withCatalogDefaults, type ChatStats, type ChatSummary, type StatsResponse } from '../../shared/types';

const streamChat: OpenRouterClient['streamChat'] = async function* (): AsyncGenerator<StreamEvent> {
  yield { type: 'delta', text: 'Hello' };
  yield { type: 'usage', usage: { promptTokens: 10, completionTokens: 5, cost: 0.004, webSearches: null, cachedTokens: null, cacheWriteTokens: null, reasoningTokens: null, loadMs: null, generationMs: null } };
};
const complete: OpenRouterClient['complete'] = async ({ onUsage }) => {
  onUsage?.({ promptTokens: 20, completionTokens: 3, cost: 0.001, webSearches: null, cachedTokens: null, cacheWriteTokens: null, reasoningTokens: null, loadMs: null, generationMs: null });
  return 'Greeting';
};

async function chatWithReply() {
  const ctx = makeApp({ streamChat, complete });
  addModel(ctx.db, withCatalogDefaults({ id: 'm/x', name: 'Model X' }));
  const chatId = ((await (await ctx.call('POST', '/api/chats')).json()) as ChatSummary).id;
  await readEvents(await ctx.call('POST', `/api/chats/${chatId}/messages`, { content: 'Hi', modelId: 'm/x' }));
  return { ...ctx, chatId };
}

describe('GET /api/stats', () => {
  it('returns the page numbers for a range and zone', async () => {
    const { call, chatId } = await chatWithReply();
    const res = await call('GET', '/api/stats?range=all&tz=UTC');
    expect(res.status).toBe(200);
    const stats = (await res.json()) as StatsResponse;
    expect(stats.range).toBe('all');
    expect(stats.tiles.replies).toBe(1);
    expect(stats.tiles.cost).toBeCloseTo(0.005, 6);
    expect(stats.models[0]).toMatchObject({ id: 'm/x', name: 'Model X', replies: 1 });
    expect(stats.biggestByCost[0]).toMatchObject({ id: chatId, title: 'Greeting' });
  });

  it('rejects an unknown range, an invalid zone and a missing zone', async () => {
    const { call } = makeApp();
    const bad = async (q: string) => {
      const res = await call('GET', `/api/stats?${q}`);
      return [res.status, ((await res.json()) as { error: string }).error];
    };
    expect(await bad('range=decade&tz=UTC')).toEqual([400, 'Unknown range.']);
    expect(await bad('range=week&tz=Mars/Base')).toEqual([400, 'Unknown time zone.']);
    expect(await bad('range=week')).toEqual([400, 'Unknown time zone.']);
  });
});

describe('GET /api/chats/:id/stats', () => {
  it('sums the chat including its title call', async () => {
    const { call, chatId } = await chatWithReply();
    const stats = (await (await call('GET', `/api/chats/${chatId}/stats`)).json()) as ChatStats;
    expect(stats).toMatchObject({ replies: 1, models: 1, promptTokens: 30, completionTokens: 8 });
    expect(stats.cost).toBeCloseTo(0.005, 6);
  });

  it('is 404 for an unknown or deleted chat', async () => {
    const { call, chatId } = await chatWithReply();
    expect((await call('GET', '/api/chats/nope/stats')).status).toBe(404);
    await call('DELETE', `/api/chats/${chatId}`);
    expect((await call('GET', `/api/chats/${chatId}/stats`)).status).toBe(404);
  });

  it('makes the chat total include the title call', async () => {
    const { call, chatId } = await chatWithReply();
    const [summary] = (await (await call('GET', '/api/chats')).json()) as ChatSummary[];
    expect(summary.id).toBe(chatId);
    expect(summary.totalCost).toBeCloseTo(0.005, 6);
  });
});
