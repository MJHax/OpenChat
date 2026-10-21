import { describe, it, expect } from 'vitest';
import { makeApp } from './appHelpers';
import { recordUsage } from '../src/usage';
import { checkSpend, getLimits, limitStatuses, periodBounds, saveLimits } from '../src/limits';
import { HttpError } from '../src/http';
import { addMediaModel } from '../src/mediaLibrary';
import type { VideoModel } from '../../shared/videoModels';
import type { SpendingLimits } from '../../shared/types';

const NY = 'America/New_York';
const at = (iso: string) => Date.parse(iso);
const bounds = (period: 'daily' | 'weekly' | 'monthly', now: string, tz: string) => {
  const b = periodBounds(period, at(now), tz);
  return { start: new Date(b.start).toISOString(), resetsAt: new Date(b.resetsAt).toISOString() };
};

describe('periodBounds', () => {
  it('uses the local calendar day, the week from Monday and the month from the 1st', () => {
    // Sunday 18 October 2026, 23:30 in New York (EDT, UTC-4).
    const now = '2026-10-19T03:30:00Z';
    expect(bounds('daily', now, NY)).toEqual({ start: '2026-10-18T04:00:00.000Z', resetsAt: '2026-10-19T04:00:00.000Z' });
    expect(bounds('weekly', now, NY)).toEqual({ start: '2026-10-12T04:00:00.000Z', resetsAt: '2026-10-19T04:00:00.000Z' });
    expect(bounds('monthly', now, NY)).toEqual({ start: '2026-10-01T04:00:00.000Z', resetsAt: '2026-11-01T04:00:00.000Z' });
  });

  it('starts a new week on Monday itself', () => {
    expect(bounds('weekly', '2026-10-19T10:00:00Z', 'UTC')).toEqual({ start: '2026-10-19T00:00:00.000Z', resetsAt: '2026-10-26T00:00:00.000Z' });
  });

  it('handles the end of daylight saving time', () => {
    // Monday 2 November 2026, 07:00 EST; clocks went back on Sunday 1 November.
    const now = '2026-11-02T12:00:00Z';
    expect(bounds('daily', now, NY)).toEqual({ start: '2026-11-02T05:00:00.000Z', resetsAt: '2026-11-03T05:00:00.000Z' });
    expect(bounds('weekly', now, NY)).toEqual({ start: '2026-11-02T05:00:00.000Z', resetsAt: '2026-11-09T05:00:00.000Z' });
    expect(bounds('monthly', now, NY)).toEqual({ start: '2026-11-01T04:00:00.000Z', resetsAt: '2026-12-01T05:00:00.000Z' });
    // The 25-hour Sunday itself.
    expect(bounds('daily', '2026-11-01T20:00:00Z', NY)).toEqual({ start: '2026-11-01T04:00:00.000Z', resetsAt: '2026-11-02T05:00:00.000Z' });
  });

  it('rolls over from December into January', () => {
    const now = '2026-12-31T20:00:00Z'; // a Thursday
    expect(bounds('monthly', now, 'UTC')).toEqual({ start: '2026-12-01T00:00:00.000Z', resetsAt: '2027-01-01T00:00:00.000Z' });
    expect(bounds('weekly', now, 'UTC')).toEqual({ start: '2026-12-28T00:00:00.000Z', resetsAt: '2027-01-04T00:00:00.000Z' });
  });
});

const LIMITS: SpendingLimits = {
  daily: { enabled: true, amount: 1 },
  weekly: { enabled: false, amount: 5 },
  monthly: { enabled: true, amount: 20 },
  timeZone: 'UTC',
};

function spend(db: ReturnType<typeof makeApp>['db'], cost: number, createdAt: number) {
  recordUsage(db, {
    purpose: 'reply', chatId: null, messageId: null, runId: null, kind: 'send', compare: false, modelId: 'm/x',
    usage: { promptTokens: 1, completionTokens: 1, cost, webSearches: null, cachedTokens: null, cacheWriteTokens: null, reasoningTokens: null, loadMs: null, generationMs: null },
    webSearch: false, webSearches: null, attachments: 0, firstTokenMs: null, durationMs: null, status: 'complete', createdAt,
  });
}

const errorOf = (fn: () => void): HttpError => {
  try {
    fn();
  } catch (e) {
    return e as HttpError;
  }
  throw new Error('expected a limit error');
};

describe('limits', () => {
  it('are all off by default', () => {
    const { db } = makeApp();
    expect(getLimits(db)).toEqual({ daily: { enabled: false, amount: null }, weekly: { enabled: false, amount: null }, monthly: { enabled: false, amount: null }, timeZone: 'UTC' });
    expect(limitStatuses(db)).toEqual([]);
    expect(() => checkSpend(db)).not.toThrow();
  });

  it('count chat and media spend since each period started', () => {
    const { db } = makeApp();
    saveLimits(db, LIMITS);
    const now = at('2026-10-17T15:00:00Z');
    spend(db, 0.3, at('2026-10-17T01:00:00Z')); // today
    spend(db, 2, at('2026-10-10T12:00:00Z')); // this month, not today
    spend(db, 9, at('2026-09-30T23:00:00Z')); // last month
    db.prepare("INSERT INTO media_events (created_at, kind, model_id, settings, cost, status) VALUES (?, 'image', 'i/m', '{}', 0.2, 'complete')")
      .run(at('2026-10-17T10:00:00Z'));
    const statuses = limitStatuses(db, now);
    expect(statuses.map((s) => [s.period, s.amount, +s.spent.toFixed(4)])).toEqual([['daily', 1, 0.5], ['monthly', 20, 2.5]]);
    expect(statuses[0].resetsAt).toBe(at('2026-10-18T00:00:00Z'));
  });

  it('counts the estimated price of clips still rendering', () => {
    const { db } = makeApp();
    const veo: VideoModel = {
      id: 'g/veo', name: 'Veo', description: '', created: null, durations: [4], resolutions: ['720p'], aspects: ['16:9'], sizes: [],
      frames: { first: true, last: true }, sound: false, skus: { duration_seconds_without_audio_720p: '0.25' },
    };
    db.prepare("INSERT INTO media_catalog_cache (kind, fetched_at, json) VALUES ('video', ?, ?)").run(Date.now(), JSON.stringify([veo]));
    addMediaModel(db, 'video', veo);
    db.prepare(
      `INSERT INTO video_jobs (job_id, thread_id, message_id, model_id, settings, polling_url, started_at, next_poll_at)
       VALUES ('j', 't', 'm', 'g/veo', ?, 'u', 1, 1)`,
    ).run(JSON.stringify({ duration: 4, resolution: '720p', aspect: '16:9', sound: false }));
    saveLimits(db, LIMITS);
    expect(limitStatuses(db)[0].spent).toBeCloseTo(1);
    expect(errorOf(() => checkSpend(db)).message).toMatch(/^Daily spending limit reached/);
  });

  it('block a request once a limit is reached, naming it and when it resets', () => {
    const { db } = makeApp();
    saveLimits(db, { ...LIMITS, timeZone: NY });
    const now = at('2026-10-17T15:00:00Z'); // Saturday 11:00 in New York
    spend(db, 0.99, now - 60_000);
    expect(() => checkSpend(db, { now })).not.toThrow();
    spend(db, 0.01, now - 30_000);
    const err = errorOf(() => checkSpend(db, { now }));
    expect(err.status).toBe(402);
    expect(err.message).toBe('Daily spending limit reached ($1.00). It resets Sunday, October 18 at 12:00 AM.');
  });

  it('refuse a priced request that would go over what is left', () => {
    const { db } = makeApp();
    saveLimits(db, LIMITS);
    const now = at('2026-10-17T15:00:00Z');
    spend(db, 0.4, now - 60_000);
    expect(() => checkSpend(db, { now, estimate: 0.6 })).not.toThrow();
    const err = errorOf(() => checkSpend(db, { now, estimate: 0.75 }));
    expect(err.message).toBe('This costs about $0.75, more than the $0.60 left of your daily spending limit ($1.00). It resets Sunday, October 18 at 12:00 AM.');
  });

  it('are validated when saved', () => {
    const { db } = makeApp();
    expect(() => saveLimits(db, { ...LIMITS, daily: { enabled: true, amount: 0 } })).toThrow(/greater than \$0/);
    expect(() => saveLimits(db, { ...LIMITS, daily: { enabled: true, amount: null } })).toThrow(/greater than \$0/);
    expect(() => saveLimits(db, { ...LIMITS, timeZone: 'Mars/Base' })).toThrow(/time zone/);
    expect(() => saveLimits(db, { ...LIMITS, weekly: { enabled: false, amount: null } })).not.toThrow();
  });

  it('round-trip through the settings API', async () => {
    const { call } = makeApp();
    const res = await call('PUT', '/api/settings', { spendingLimits: LIMITS });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { spendingLimits: SpendingLimits }).spendingLimits).toEqual(LIMITS);
    expect((await call('PUT', '/api/settings', { spendingLimits: { ...LIMITS, monthly: { enabled: true, amount: -3 } } })).status).toBe(400);
    const status = (await (await call('GET', '/api/settings/limits')).json()) as { period: string }[];
    expect(status.map((s) => s.period)).toEqual(['daily', 'monthly']);
  });
});
