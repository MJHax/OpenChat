import type { ChatStats, HeatDay, StatsRange } from '../../../shared/types';

export const RANGES: { id: StatsRange; label: string }[] = [
  { id: 'all', label: 'All time' },
  { id: 'year', label: 'Year' },
  { id: 'month', label: 'Month' },
  { id: 'week', label: 'Week' },
  { id: 'today', label: 'Today' },
];

const RANGE_KEY = 'openchat.stats.range';

export function loadRange(): StatsRange {
  try {
    const saved = localStorage.getItem(RANGE_KEY);
    return RANGES.some((r) => r.id === saved) ? (saved as StatsRange) : 'all';
  } catch {
    return 'all';
  }
}

export function saveRange(range: StatsRange): void {
  try {
    localStorage.setItem(RANGE_KEY, range);
  } catch {
    // Storage unavailable (private window, blocked); the choice just isn't remembered.
  }
}

/** 950 → '950', 1,500 → '1.5k', 184,000 → '184k', 12,400,000 → '12.4M'. */
export function compactNumber(n: number): string {
  const short = (v: number, unit: string) => `${v >= 100 ? Math.round(v) : Number(v.toFixed(1))}${unit}`;
  if (n >= 1_000_000) return short(n / 1_000_000, 'M');
  if (n >= 1_000) return short(n / 1_000, 'k');
  return String(Math.round(n));
}

export const formatPercent = (rate: number | null): string => (rate === null ? '—' : `${Math.round(rate * 100)}%`);

export const formatSeconds = (ms: number | null): string => (ms === null ? '—' : `${(ms / 1000).toFixed(1)}s`);

/** '▲ 12%' / '▼ 12%' against the previous period; null when there's nothing to compare with. */
export function formatChange(current: number, previous: number | null): string | null {
  if (!previous) return null;
  const change = (current - previous) / previous;
  return `${change >= 0 ? '▲' : '▼'} ${Math.round(Math.abs(change) * 100)}%`;
}

/** 0 for an empty day, else 1–4 by share of the busiest day. */
export function heatLevel(replies: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (replies <= 0 || max <= 0) return 0;
  return Math.min(4, Math.ceil((4 * replies) / max)) as 1 | 2 | 3 | 4;
}

/** Weeks of seven days (Sunday first). The server starts the list on a Sunday; the last week is padded with null. */
export function heatColumns(days: HeatDay[]): (HeatDay | null)[][] {
  const cols: (HeatDay | null)[][] = [];
  for (let i = 0; i < days.length; i += 7) {
    const week: (HeatDay | null)[] = days.slice(i, i + 7);
    while (week.length < 7) week.push(null);
    cols.push(week);
  }
  return cols;
}

export const emptyChatStats = (): ChatStats => ({
  cost: 0, promptTokens: 0, completionTokens: 0, cacheHitRate: null, cacheSavings: null, replies: 0, models: 0, webSearches: 0, avgPromptTokens: null,
});
