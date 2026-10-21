import { describe, it, expect } from 'vitest';
import { computeChatStats, computeStats, type StatsInput } from '../src/stats';
import type { UsageRow } from '../src/usage';
import type { StatsRange } from '../../shared/types';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 16, 18, 0);
let nextId = 1;

/** A counted, complete, non-backfilled reply an hour ago unless overridden. */
function row(over: Partial<UsageRow> = {}): UsageRow {
  const id = nextId++;
  return {
    id, createdAt: NOW - 3_600_000, purpose: 'reply', chatId: 'c1', messageId: `m${id}`, runId: `r${id}`, kind: 'send', compare: false,
    modelId: 'a/one', promptTokens: 100, completionTokens: 20, cachedTokens: null, cacheWriteTokens: null, reasoningTokens: null,
    cost: 0.01, cacheSavings: null, webSearch: false, webSearches: null, attachments: 0, firstTokenMs: null, durationMs: null, loadMs: null, generationMs: null,
    status: 'complete', backfilled: false, threadKind: 'chat', ...over,
  };
}

function stats(rows: UsageRow[], range: StatsRange = 'all', over: Partial<StatsInput> = {}) {
  return computeStats({
    rows, range, now: NOW, tz: 'UTC', chatTitles: new Map([['c1', 'One'], ['c2', 'Two']]), modelNames: new Map([['a/one', 'Model One']]), ...over,
  });
}

/** Every number anywhere in the value. */
function numbers(value: unknown): number[] {
  if (typeof value === 'number') return [value];
  if (value && typeof value === 'object') return Object.values(value).flatMap(numbers);
  return [];
}

describe('tiles', () => {
  it('sums cost with background calls, counts only replies that produced text, and keeps deleted chats', () => {
    const s = stats([
      row(),
      row({ purpose: 'title', messageId: null, runId: null, kind: null, cost: 0.002 }),
      row({ messageId: null, status: 'error', cost: null }),
      row({ chatId: 'gone' }),
      row({ createdAt: NOW - 10 * DAY, cost: 0.5 }),
    ], 'week');
    expect(s.tiles.cost).toBeCloseTo(0.022);
    expect(s.tiles.replies).toBe(2);
    expect(s.tiles.chats).toBe(2);
    expect(s.tiles.previousCost).toBeCloseTo(0.5);
    expect(s.tiles.rangeDays).toBe(7);
  });

  it('has no previous period for all time', () => {
    expect(stats([row()]).tiles.previousCost).toBeNull();
  });

  it('computes the cache hit rate only over rows that report cache data', () => {
    const s = stats([row({ promptTokens: 100, cachedTokens: 50, cacheSavings: 0.001 }), row({ promptTokens: 100, cachedTokens: null })]);
    expect(s.tiles.cacheHitRate).toBeCloseTo(0.5);
    expect(s.tiles.cacheSavings).toBeCloseTo(0.001);
    expect(stats([row()]).tiles.cacheSavings).toBeNull();
  });

  it('reports output speed and first-token time', () => {
    const s = stats([row({ completionTokens: 100, firstTokenMs: 500, durationMs: 2500 })]);
    expect(s.tiles.outputTokensPerSec).toBeCloseTo(50);
    expect(s.tiles.avgFirstTokenMs).toBe(500);
  });

  it('adds up searches and what searching replies cost', () => {
    const s = stats([row({ webSearch: true, webSearches: 2, cost: 0.02 }), row({ cost: 0.01 })]);
    expect(s.tiles.webSearches).toBe(2);
    expect(s.tiles.webSearchCost).toBeCloseTo(0.02);
  });

  it('never counts more active days than the range has, and the chart holds every reply the tiles count', () => {
    const afternoon = Date.UTC(2026, 9, 16, 15, 0);
    // Now is 15:02; one reply a day at 15:03 for the past 7 days plus one today, so a rolling 168 h window would touch 8 days.
    const daily = [row({ createdAt: afternoon }), ...Array.from({ length: 7 }, (_, i) => row({ createdAt: afternoon - (i + 1) * DAY + 180_000 }))];
    const s = stats(daily, 'week', { now: afternoon + 120_000 });
    expect(s.tiles.activeDays).toBe(7);
    expect(s.tiles.replies).toBe(7);
    expect(s.buckets.reduce((n, b) => n + b.replies, 0)).toBe(s.tiles.replies);
  });

  it('counts active days in range and lifetime streaks', () => {
    const s = stats([row(), row({ createdAt: NOW - DAY }), row({ createdAt: NOW - 20 * DAY })], 'week');
    expect(s.tiles.activeDays).toBe(2);
    expect(s.tiles.currentStreak).toBe(2);
    expect(s.tiles.longestStreak).toBe(2);
  });

  it('names the top model and its share of replies', () => {
    const s = stats([row(), row(), row({ modelId: 'b/two' })]);
    expect(s.tiles.topModel).toEqual({ id: 'a/one', name: 'Model One', share: 2 / 3 });
    expect(stats([]).tiles.topModel).toBeNull();
  });
});

describe('models', () => {
  it('sorts by replies and puts background-only models last, with null per-reply figures', () => {
    const s = stats([
      row({ modelId: 'b/two' }), row({ modelId: 'b/two' }), row(),
      row({ modelId: 't/title', purpose: 'title', messageId: null, runId: null, kind: null, promptTokens: 0, cachedTokens: 0 }),
    ]);
    expect(s.models.map((m) => m.id)).toEqual(['b/two', 'a/one', 't/title']);
    expect(s.models[1].name).toBe('Model One');
    expect(s.models[2]).toMatchObject({ name: 't/title', replies: 0, avgCostPerReply: null, errorRate: null, cacheHitRate: null });
  });

  it('never produces NaN or Infinity', () => {
    const s = stats([
      row({ promptTokens: 0, cachedTokens: 0, completionTokens: 0, firstTokenMs: 100, durationMs: 100 }),
      row({ purpose: 'memory', chatId: null, messageId: null, runId: null, kind: null, modelId: 'm/mem', cost: null, promptTokens: null }),
    ], 'today');
    expect(numbers(s).every(Number.isFinite)).toBe(true);
  });

  it('rates errors and stops over non-backfilled reply calls only', () => {
    const s = stats([
      row(), row(), row({ status: 'error', messageId: null }), row({ status: 'stopped' }),
      row({ backfilled: true, status: 'stopped' }), row({ backfilled: true }),
    ]);
    expect(s.models[0].errorRate).toBeCloseTo(0.25);
    expect(s.models[0].stoppedRate).toBeCloseTo(0.25);
  });
});

describe('heatmap and buckets', () => {
  it('covers only the selected range, so activity outside it does not set the scale', () => {
    const rows = [row({ createdAt: NOW - DAY }), row({ createdAt: NOW - 20 * DAY }), row({ createdAt: NOW - 20 * DAY })];
    const week = stats(rows, 'week');
    expect(week.heatmap.map((d) => d.day)).toEqual(['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16']);
    expect(week.heatmap.find((d) => d.day === '2026-10-15')).toEqual({ day: '2026-10-15', replies: 1, cost: 0.01 });
    expect(stats(rows, 'month').heatmap).toHaveLength(30);
    expect(stats(rows, 'month').heatmap.find((d) => d.day === '2026-09-26')?.replies).toBe(2);
    expect(stats(rows, 'year').heatmap).toHaveLength(365);
    expect(stats(rows, 'all').heatmap[0].day).toBe('2026-09-26');
  });

  it('is hourly for Today', () => {
    const s = stats([row(), row({ createdAt: NOW - DAY })], 'today');
    expect(s.heatmap).toHaveLength(24);
    expect(s.heatmap.find((d) => d.day === '2026-10-16T17')).toEqual({ day: '2026-10-16T17', replies: 1, cost: 0.01 });
    expect(s.heatmap.reduce((n, d) => n + d.replies, 0)).toBe(1);
  });

  it('splits each bucket into replies and background calls', () => {
    const s = stats([row(), row({ purpose: 'title', messageId: null, kind: null, cost: 0.002, promptTokens: 50, completionTokens: 5 })], 'today');
    const b = s.buckets.find((x) => x.key === '2026-10-16T17')!;
    expect(b).toMatchObject({ replyCost: 0.01, backgroundCost: 0.002, replyTokens: 120, backgroundTokens: 55, replies: 1, backgroundCalls: 1 });
  });
});

describe('biggest chats', () => {
  it('ranks existing chats by cost and by length, skipping deleted ones, at most five', () => {
    const s = stats([
      row({ chatId: 'c1', cost: 0.1 }), row({ chatId: 'c2', cost: 0.05 }), row({ chatId: 'c2', cost: 0.01 }), row({ chatId: 'gone', cost: 9 }),
    ]);
    expect(s.biggestByCost.map((c) => [c.id, c.title])).toEqual([['c1', 'One'], ['c2', 'Two']]);
    expect(s.biggestByLength.map((c) => c.id)).toEqual(['c2', 'c1']);
    const many = new Map(Array.from({ length: 8 }, (_, i) => [`k${i}`, `K${i}`] as [string, string]));
    expect(stats([...many.keys()].map((id) => row({ chatId: id })), 'all', { chatTitles: many }).biggestByCost).toHaveLength(5);
  });
});

describe('features', () => {
  it('counts comparison runs, files once per run, and regenerate/edit runs, ignoring backfilled rows', () => {
    const s = stats([
      row({ runId: 'cmp', compare: true, attachments: 2 }), row({ runId: 'cmp', compare: true, attachments: 2 }), row({ runId: 'cmp', compare: true, attachments: 2 }),
      row({ kind: 'regenerate' }), row({ kind: 'edit', attachments: 1 }), row({ webSearch: true }),
      row({ backfilled: true, kind: null, webSearch: true }),
    ]);
    expect(s.features).toMatchObject({ compareRuns: 1, attachments: 3, regeneratedOrEdited: 2, webSearchReplies: 1 });
  });

  it('gives the input to output ratio', () => {
    expect(stats([row({ promptTokens: 380, completionTokens: 100 })]).features.inputOutputRatio).toBeCloseTo(3.8);
  });
});

describe('trackingSince', () => {
  it('is the first non-backfilled call', () => {
    expect(stats([row({ backfilled: true, createdAt: 1 }), row({ createdAt: 500 })]).trackingSince).toBe(500);
    expect(stats([row({ backfilled: true })]).trackingSince).toBeNull();
  });
});

describe('computeChatStats', () => {
  it('is all zeros for no rows', () => {
    expect(computeChatStats([])).toEqual({
      cost: 0, promptTokens: 0, completionTokens: 0, cacheHitRate: null, cacheSavings: null, replies: 0, models: 0, webSearches: 0, avgPromptTokens: null,
    });
  });

  it('sums the chat including its title call', () => {
    const s = computeChatStats([
      row({ promptTokens: 100 }), row({ modelId: 'b/two', promptTokens: 300, webSearches: 2, cachedTokens: 150 }),
      row({ purpose: 'title', messageId: null, kind: null, cost: 0.001, promptTokens: 40, completionTokens: 4 }),
    ]);
    expect(s).toMatchObject({ replies: 2, models: 2, webSearches: 2, avgPromptTokens: 200, promptTokens: 440, completionTokens: 44 });
    expect(s.cost).toBeCloseTo(0.021);
    expect(s.cacheHitRate).toBeCloseTo(0.5);
  });
});
