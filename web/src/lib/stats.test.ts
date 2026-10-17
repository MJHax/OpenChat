import { describe, it, expect, beforeEach } from 'vitest';
import { compactNumber, emptyChatStats, formatChange, formatPercent, formatSeconds, heatColumns, heatLevel, loadRange, RANGES, saveRange, trackingNote } from './stats';
import type { HeatDay } from '../../../shared/types';

describe('formatting', () => {
  it('shortens large numbers', () => {
    expect(compactNumber(950)).toBe('950');
    expect(compactNumber(184_000)).toBe('184k');
    expect(compactNumber(1_500)).toBe('1.5k');
    expect(compactNumber(12_400_000)).toBe('12.4M');
    expect(compactNumber(0)).toBe('0');
  });

  it('formats rates, seconds and changes', () => {
    expect(formatPercent(0.413)).toBe('41%');
    expect(formatPercent(null)).toBe('—');
    expect(formatSeconds(900)).toBe('0.9s');
    expect(formatSeconds(null)).toBe('—');
    expect(formatChange(112, 100)).toBe('▲ 12%');
    expect(formatChange(88, 100)).toBe('▼ 12%');
    expect(formatChange(5, 0)).toBeNull();
    expect(formatChange(5, null)).toBeNull();
  });
});

describe('heatmap layout', () => {
  it('shades by share of the busiest day', () => {
    expect(heatLevel(0, 10)).toBe(0);
    expect(heatLevel(1, 10)).toBe(1);
    expect(heatLevel(5, 10)).toBe(2);
    expect(heatLevel(10, 10)).toBe(4);
    expect(heatLevel(0, 0)).toBe(0);
  });

  it('lays days out in weeks of seven, padding after today', () => {
    const days: HeatDay[] = Array.from({ length: 8 }, (_, i) => ({ day: `2026-10-${String(4 + i).padStart(2, '0')}`, replies: i, cost: 0 }));
    const cols = heatColumns(days); // 2026-10-04 is a Sunday
    expect(cols).toHaveLength(2);
    expect(cols[0].map((d) => d?.day)).toEqual(['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10']);
    expect(cols[1][0]?.day).toBe('2026-10-11');
    expect(cols[1].slice(1)).toEqual([null, null, null, null, null, null]);
  });
});

describe('range memory', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
  });

  it('defaults to all time and remembers a choice', () => {
    expect(loadRange()).toBe('all');
    saveRange('week');
    expect(loadRange()).toBe('week');
  });

  it('ignores junk and missing storage', () => {
    localStorage.setItem('openchat.stats.range', 'decade');
    expect(loadRange()).toBe('all');
    delete (globalThis as { localStorage?: unknown }).localStorage;
    expect(loadRange()).toBe('all');
    expect(() => saveRange('week')).not.toThrow();
  });

  it('lists the five ranges in order', () => {
    expect(RANGES.map((r) => r.label)).toEqual(['All time', 'Year', 'Month', 'Week', 'Today']);
  });
});

describe('trackingNote', () => {
  it('names the start date, or says tracking starts with the next reply', () => {
    expect(trackingNote(Date.UTC(2026, 9, 16, 18))).toBe('Cache, speed, error and feature stats are tracked from Oct 16, 2026.');
    expect(trackingNote(null)).toBe('Cache, speed, error and feature stats are tracked from your next reply.');
  });
});

describe('emptyChatStats', () => {
  it('is zeros with no rates', () => {
    expect(emptyChatStats()).toEqual({
      cost: 0, promptTokens: 0, completionTokens: 0, cacheHitRate: null, cacheSavings: null, replies: 0, models: 0, webSearches: 0, avgPromptTokens: null,
    });
  });
});
