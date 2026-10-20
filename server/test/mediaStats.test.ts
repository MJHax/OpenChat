import { describe, it, expect } from 'vitest';
import { computeMediaStats, computeMediaThreadStats, type MediaEventRow } from '../src/mediaStats';
import { makeApp } from './appHelpers';
import type { UsageRow } from '../src/usage';
import type { MediaStatsResponse, MediaThreadStats, StatsRange, StatsResponse } from '../../shared/types';

const NOW = Date.UTC(2026, 9, 17, 12);
const HOUR = 3_600_000;

const ev = (over: Partial<MediaEventRow> = {}): MediaEventRow => ({
  createdAt: NOW - HOUR, kind: 'image', threadId: 't1', messageId: 'm1', modelId: 'g/banana', mode: 'new',
  settings: { aspect: '1:1', size: '1K', quality: null, transparent: false }, promptTokens: null, completionTokens: null, cost: 0.04,
  costEstimated: false, seconds: null, durationMs: 10_000, status: 'complete', ...over,
});

const titleRow = (cost: number, threadKind: UsageRow['threadKind']): UsageRow => ({
  id: 1, createdAt: NOW - HOUR, purpose: 'title', chatId: 't1', messageId: null, runId: null, kind: null, compare: false, modelId: 'm/x',
  promptTokens: 30, completionTokens: 4, cachedTokens: null, cacheWriteTokens: null, reasoningTokens: null, cost, cacheSavings: null,
  webSearch: false, webSearches: null, attachments: 0, firstTokenMs: null, durationMs: null, status: 'complete', backfilled: false, threadKind,
});

const stats = (events: MediaEventRow[], titleRows: UsageRow[] = [], range: StatsRange = 'all') =>
  computeMediaStats({ events, titleRows, range, now: NOW, tz: 'UTC', modelNames: new Map([['g/banana', 'Banana']]), kind: 'image' });

describe('computeMediaStats', () => {
  it('fits the heatmap to the range: hours for Today, the window days otherwise', () => {
    const events = [ev(), ev({ createdAt: NOW - 10 * 24 * HOUR })];
    expect(stats(events, [], 'today').heatmap).toHaveLength(24);
    expect(stats(events, [], 'today').heatmap.reduce((n, d) => n + d.replies, 0)).toBe(1);
    const week = stats(events, [], 'week').heatmap;
    expect(week).toHaveLength(7);
    expect(week.reduce((n, d) => n + d.replies, 0)).toBe(1);
    expect(stats(events, [], 'month').heatmap.reduce((n, d) => n + d.replies, 0)).toBe(2);
  });

  it('fills the tiles', () => {
    const s = stats([ev({ cost: 0.04, durationMs: 10_000 }), ev({ cost: 0.06, durationMs: 20_000 }), ev({ cost: 0, status: 'error', durationMs: 3_000 })]);
    expect(s.tiles).toMatchObject({ count: 2, spend: 0.1, failures: 1, avgDurationMs: 15_000 });
    expect(s.tiles.avgCost).toBeCloseTo(0.05);
  });

  it('sums tokens only from models that report them', () => {
    const s = stats([ev({ promptTokens: 20, completionTokens: 1290 }), ev({ modelId: 'f/flux' }), ev({ modelId: 'o/gpt', promptTokens: 5, completionTokens: 100 })]);
    expect(s.tiles).toMatchObject({ promptTokens: 25, completionTokens: 1390, tokenModels: 2 });
  });

  it('splits new images from edits', () => {
    const s = stats([ev(), ev({ mode: 'edit_generated' }), ev({ mode: 'edit_generated' }), ev({ mode: 'edit_upload' }), ev({ mode: 'edit_upload', status: 'error', cost: 0 })]);
    expect(s.modes).toEqual({ new: 1, editGenerated: 2, editUpload: 1 });
  });

  it('has a row per model', () => {
    const s = stats([ev(), ev({ cost: 0.06 }), ev({ status: 'error', cost: 0 }), ev({ modelId: 'f/flux', cost: 0.1 })]);
    expect(s.models.map((m) => [m.name, m.count, m.failures])).toEqual([['Banana', 2, 1], ['f/flux', 1, 0]]);
    expect(s.models[0].spend).toBeCloseTo(0.1);
  });

  it("counts image-thread titles in spend, not other threads' titles", () => {
    const s = stats([ev({ cost: 0.04 })], [titleRow(0.001, 'image'), titleRow(0.5, 'chat')]);
    expect(s.tiles.spend).toBeCloseTo(0.041);
  });

  it('follows the range', () => {
    const s = stats([ev({ createdAt: NOW - 3 * 86_400_000 }), ev({ createdAt: NOW - HOUR })], [], 'today');
    expect(s.tiles.count).toBe(1);
    expect(s.buckets.reduce((n, b) => n + b.count, 0)).toBe(1);
  });

  it('adds up seconds for video', () => {
    const s = computeMediaStats({
      events: [ev({ kind: 'video', seconds: 5, cost: 0.42 }), ev({ kind: 'video', seconds: 4, cost: 0.12 })], titleRows: [], range: 'all',
      now: NOW, tz: 'UTC', modelNames: new Map(), kind: 'video',
    });
    expect(s.tiles).toMatchObject({ seconds: 9 });
    expect(s.tiles.avgCostPerSecond).toBeCloseTo(0.06);
    expect(s.modes).toBeNull();
  });
});

describe('computeMediaThreadStats', () => {
  it('summarises one thread', () => {
    expect(computeMediaThreadStats([ev({ cost: 0.04 }), ev({ cost: 0.06, durationMs: 20_000 }), ev({ status: 'error', cost: 0 })], [titleRow(0.001, 'image')]))
      .toMatchObject({ count: 2, failures: 1, avgDurationMs: 15_000 });
  });
});

describe('stats routes by view', () => {
  function seed() {
    const ctx = makeApp();
    const { db } = ctx;
    db.prepare("INSERT INTO chats (id, title, created_at, updated_at, kind) VALUES ('img', 'Fox', 1, 1, 'image')").run();
    db.prepare("INSERT INTO media_events (created_at, kind, thread_id, model_id, mode, settings, cost, duration_ms, status) VALUES (?, 'image', 'img', 'g/banana', 'new', '{}', 0.04, 9000, 'complete')").run(Date.now() - 1000);
    db.prepare("INSERT INTO usage_events (created_at, purpose, chat_id, model_id, cost, status, thread_kind) VALUES (?, 'title', 'img', 'm/x', 0.001, 'complete', 'image')").run(Date.now() - 1000);
    db.prepare("INSERT INTO usage_events (created_at, purpose, chat_id, model_id, cost, status) VALUES (?, 'reply', 'c', 'm/x', 0.01, 'complete')").run(Date.now() - 1000);
    return ctx;
  }

  it('has a video view with seconds and cost per second, counting video-thread titles', async () => {
    const { call, db } = seed();
    db.prepare("INSERT INTO chats (id, title, created_at, updated_at, kind) VALUES ('vid', 'Cats', 1, 1, 'video')").run();
    const add = (seconds: number, cost: number) => db.prepare(
      "INSERT INTO media_events (created_at, kind, thread_id, model_id, mode, settings, cost, seconds, duration_ms, status) VALUES (?, 'video', 'vid', 'g/veo', 'new', '{}', ?, ?, 30000, 'complete')",
    ).run(Date.now() - 1000, cost, seconds);
    add(5, 0.42);
    add(4, 0.12);
    db.prepare("INSERT INTO usage_events (created_at, purpose, chat_id, model_id, cost, status, thread_kind) VALUES (?, 'title', 'vid', 'm/x', 0.002, 'complete', 'video')").run(Date.now() - 1000);
    const v = (await (await call('GET', '/api/stats?view=video&range=all&tz=UTC')).json()) as MediaStatsResponse;
    expect(v.tiles).toMatchObject({ count: 2, seconds: 9 });
    expect(v.tiles.spend).toBeCloseTo(0.542);
    expect(v.tiles.avgCostPerSecond).toBeCloseTo(0.06);
    expect(v.modes).toBeNull();
  });

  it('keeps image costs out of the chats view, with the overall total on both', async () => {
    const { call } = seed();
    const chats = (await (await call('GET', '/api/stats?range=all&tz=UTC')).json()) as StatsResponse;
    expect(chats.tiles.cost).toBeCloseTo(0.01);
    expect(chats.allSpend).toBeCloseTo(0.051);
    const images = (await (await call('GET', '/api/stats?view=images&range=all&tz=UTC')).json()) as MediaStatsResponse;
    expect(images.tiles).toMatchObject({ count: 1 });
    expect(images.tiles.spend).toBeCloseTo(0.041);
    expect(images.allSpend).toBeCloseTo(0.051);
    expect((await call('GET', '/api/stats?view=bogus&range=all&tz=UTC')).status).toBe(400);
  });

  it('gives an image thread its own popover numbers', async () => {
    const { call } = seed();
    const t = (await (await call('GET', '/api/chats/img/stats')).json()) as MediaThreadStats;
    expect(t).toMatchObject({ count: 1, failures: 0 });
    expect(t.spend).toBeCloseTo(0.041);
  });
});
