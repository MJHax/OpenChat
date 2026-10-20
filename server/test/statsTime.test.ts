import { describe, it, expect } from 'vitest';
import { bucketKeys, dayKey, heatmapKeys, hourKey, isValidZone, monthKey, rangeWindow, startOfLocalDay, streaks } from '../src/statsTime';

const NY = 'America/New_York';
const DAY = 86_400_000;

describe('zone keys', () => {
  it('names the local day, month and hour', () => {
    const t = Date.UTC(2026, 9, 16, 3, 0); // 23:00 on Oct 15 in New York
    expect(dayKey(t, NY)).toBe('2026-10-15');
    expect(monthKey(t, NY)).toBe('2026-10');
    expect(hourKey(t, NY)).toBe('2026-10-15T23');
    expect(dayKey(t, 'UTC')).toBe('2026-10-16');
  });

  it('validates zones', () => {
    expect(isValidZone(NY)).toBe(true);
    expect(isValidZone('UTC')).toBe(true);
    expect(isValidZone('Mars/Base')).toBe(false);
    expect(isValidZone('')).toBe(false);
  });
});

describe('startOfLocalDay across DST (clocks fall back in New York on 2026-11-01)', () => {
  it('finds local midnight on the day clocks change and the day after', () => {
    expect(startOfLocalDay(Date.UTC(2026, 10, 1, 20, 0), NY)).toBe(Date.UTC(2026, 10, 1, 4, 0)); // 00:00 EDT
    expect(startOfLocalDay(Date.UTC(2026, 10, 2, 17, 0), NY)).toBe(Date.UTC(2026, 10, 2, 5, 0)); // 00:00 EST
  });

  it('keeps a late-evening reply on its local day', () => {
    expect(dayKey(Date.UTC(2026, 10, 2, 4, 30), NY)).toBe('2026-11-01'); // 23:30 EST on Nov 1
  });
});

describe('rangeWindow', () => {
  const now = Date.UTC(2026, 9, 16, 18, 0); // 14:00 in New York

  it('today starts at local midnight; its previous period is yesterday up to the same time', () => {
    const w = rangeWindow('today', now, NY);
    expect(w.start).toBe(Date.UTC(2026, 9, 16, 4, 0));
    expect(w.previous).toEqual({ start: Date.UTC(2026, 9, 15, 4, 0), end: Date.UTC(2026, 9, 15, 18, 0) });
    expect(w.days).toBe(1);
  });

  it('week, month and year cover whole local days, today included, so they match the chart', () => {
    // 2026-10-16 14:00 New York: the week is Oct 10 00:00 → now; the previous week is Oct 3 00:00 → Oct 10 00:00.
    expect(rangeWindow('week', now, NY)).toEqual({
      start: Date.UTC(2026, 9, 10, 4, 0), previous: { start: Date.UTC(2026, 9, 3, 4, 0), end: Date.UTC(2026, 9, 10, 4, 0) }, days: 7,
    });
    expect(rangeWindow('month', now, NY).start).toBe(Date.UTC(2026, 8, 17, 4, 0));
    expect(rangeWindow('year', now, NY)).toMatchObject({ start: Date.UTC(2025, 9, 17, 4, 0), days: 365 });
  });

  it('a week spanning the DST change still starts at local midnight', () => {
    const afterFallBack = Date.UTC(2026, 10, 3, 17, 0); // Nov 3 12:00 EST
    expect(rangeWindow('week', afterFallBack, NY).start).toBe(Date.UTC(2026, 9, 28, 4, 0)); // Oct 28 00:00 EDT
  });

  it('all time has no start and no previous period', () => {
    expect(rangeWindow('all', now, NY)).toEqual({ start: null, previous: null, days: null });
  });
});

describe('bucketKeys', () => {
  const now = Date.UTC(2026, 9, 16, 18, 0);

  it('week and month are local days ending today', () => {
    const week = bucketKeys('week', now, NY, null);
    expect(week).toHaveLength(7);
    expect(week.at(-1)!.key).toBe('2026-10-16');
    expect(week[0].key).toBe('2026-10-10');
    expect(week.at(-1)!.label).toBe('Oct 16');
    expect(bucketKeys('month', now, NY, null)).toHaveLength(30);
  });

  it('today is 24 hours', () => {
    const today = bucketKeys('today', now, NY, null);
    expect(today).toHaveLength(24);
    expect(today[0]).toEqual({ key: '2026-10-16T00', label: '00:00' });
    expect(today[14].key).toBe('2026-10-16T14');
  });

  it('year is months from the start month to now', () => {
    const year = bucketKeys('year', now, NY, null);
    expect(year[0].key).toBe('2025-10');
    expect(year.at(-1)).toEqual({ key: '2026-10', label: 'Oct' });
  });

  it('all time is months from the first event, or nothing without events', () => {
    expect(bucketKeys('all', now, NY, null)).toEqual([]);
    expect(bucketKeys('all', now, NY, Date.UTC(2026, 7, 20)).map((b) => b.key)).toEqual(['2026-08', '2026-09', '2026-10']);
  });
});

describe('heatmapKeys', () => {
  const now = Date.UTC(2026, 9, 16, 18, 0); // 14:00 on Oct 16 in New York

  it('is the hours of today for Today', () => {
    const keys = heatmapKeys('today', now, NY, null);
    expect(keys).toHaveLength(24);
    expect(keys[0]).toBe('2026-10-16T00');
    expect(keys.at(-1)).toBe('2026-10-16T23');
  });

  it('is the local days of the window for Week, Month and Year, ending today', () => {
    for (const [range, n] of [['week', 7], ['month', 30], ['year', 365]] as const) {
      const keys = heatmapKeys(range, now, NY, null);
      expect(keys).toHaveLength(n);
      expect(keys[0]).toBe(dayKey(rangeWindow(range, now, NY).start!, NY));
      expect(keys.at(-1)).toBe('2026-10-16');
      expect(new Set(keys).size).toBe(n);
    }
  });

  it('runs from the first local day with activity for All time, and is empty with none', () => {
    expect(heatmapKeys('all', now, NY, Date.UTC(2026, 9, 12, 2, 0))).toEqual(['2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16']);
    expect(heatmapKeys('all', now, NY, null)).toEqual([]);
  });
});

describe('streaks', () => {
  const now = Date.UTC(2026, 9, 16, 18, 0);
  const key = (daysAgo: number) => dayKey(now - daysAgo * DAY, NY);

  it('counts the run ending today and the longest run', () => {
    expect(streaks(new Set([key(0), key(1), key(3)]), now, NY)).toEqual({ current: 2, longest: 2 });
    expect(streaks(new Set([key(0), key(5), key(6), key(7)]), now, NY)).toEqual({ current: 1, longest: 3 });
  });

  it('keeps the current streak alive through yesterday when nothing happened yet today', () => {
    expect(streaks(new Set([key(1), key(2)]), now, NY).current).toBe(2);
    expect(streaks(new Set([key(2), key(3)]), now, NY).current).toBe(0);
  });

  it('is zero with no activity', () => {
    expect(streaks(new Set(), now, NY)).toEqual({ current: 0, longest: 0 });
  });
});
