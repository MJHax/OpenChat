import type { StatsRange } from '../../shared/types';

const DAY_MS = 86_400_000;
const ROLLING_DAYS: Record<Exclude<StatsRange, 'all' | 'today'>, number> = { week: 7, month: 30, year: 365 };

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Local wall-clock fields of `ts` in `tz`. */
function local(ts: number, tz: string) {
  const p = Object.fromEntries(formatter(tz).formatToParts(ts).map((x) => [x.type, x.value]));
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour), mi: Number(p.minute), s: Number(p.second) };
}

/** Milliseconds `tz` is ahead of UTC at `ts`. */
function offset(ts: number, tz: string): number {
  const l = local(ts, tz);
  return Date.UTC(l.y, l.mo - 1, l.d, l.h, l.mi, l.s) - Math.floor(ts / 1000) * 1000;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function isValidZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function dayKey(ts: number, tz: string): string {
  const l = local(ts, tz);
  return `${l.y}-${pad(l.mo)}-${pad(l.d)}`;
}

export function monthKey(ts: number, tz: string): string {
  return dayKey(ts, tz).slice(0, 7);
}

export function hourKey(ts: number, tz: string): string {
  return `${dayKey(ts, tz)}T${pad(local(ts, tz).h)}`;
}

/** The instant of local midnight on the local day containing `ts`. The offset is re-read at midnight, so DST days work. */
export function startOfLocalDay(ts: number, tz: string): number {
  const l = local(ts, tz);
  const midnightUtc = Date.UTC(l.y, l.mo - 1, l.d);
  return midnightUtc - offset(midnightUtc - offset(ts, tz), tz);
}

// Calendar arithmetic on 'YYYY-MM-DD' keys: steps whole days with no clock involved, so DST can't skip or repeat one.
const keyDate = (key: string) => new Date(`${key}T00:00:00Z`);
const toKey = (d: Date) => d.toISOString().slice(0, 10);
function addDays(key: string, n: number): string {
  const d = keyDate(key);
  d.setUTCDate(d.getUTCDate() + n);
  return toKey(d);
}
function addMonths(month: string, n: number): string {
  const d = new Date(`${month}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return toKey(d).slice(0, 7);
}

const label = (key: string, opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' }).format(keyDate(key.length === 7 ? `${key}-01` : key));

export function rangeWindow(range: StatsRange, now: number, tz: string):
  { start: number | null; previous: { start: number; end: number } | null; days: number | null } {
  if (range === 'all') return { start: null, previous: null, days: null };
  if (range === 'today') {
    const start = startOfLocalDay(now, tz);
    const prevStart = startOfLocalDay(start - 1, tz);
    return { start, previous: { start: prevStart, end: prevStart + (now - start) }, days: 1 };
  }
  const days = ROLLING_DAYS[range];
  const start = now - days * DAY_MS;
  return { start, previous: { start: start - days * DAY_MS, end: start }, days };
}

function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) out.push(m);
  return out;
}

/** The chart's buckets for a range: months for All time and Year, local days for Month and Week, hours for Today. */
export function bucketKeys(range: StatsRange, now: number, tz: string, firstEventAt: number | null): { key: string; label: string }[] {
  const today = dayKey(now, tz);
  const months = (from: string) => monthsBetween(from, today.slice(0, 7)).map((key) => ({ key, label: label(key, { month: 'short' }) }));
  if (range === 'all') return firstEventAt === null ? [] : months(monthKey(firstEventAt, tz));
  if (range === 'year') return months(monthKey(rangeWindow('year', now, tz).start!, tz));
  if (range === 'today') return Array.from({ length: 24 }, (_, h) => ({ key: `${today}T${pad(h)}`, label: `${pad(h)}:00` }));
  const n = ROLLING_DAYS[range];
  return Array.from({ length: n }, (_, i) => {
    const key = addDays(today, i - n + 1);
    return { key, label: label(key, { month: 'short', day: 'numeric' }) };
  });
}

/** Local days from the Sunday on or before a year ago, through today. */
export function heatmapDays(now: number, tz: string): string[] {
  const today = dayKey(now, tz);
  const yearAgo = addDays(today, -364);
  let day = addDays(yearAgo, -keyDate(yearAgo).getUTCDay());
  const out: string[] = [];
  for (; day <= today; day = addDays(day, 1)) out.push(day);
  return out;
}

/** Consecutive active local days: the run ending today (or yesterday, if nothing yet today) and the longest run. */
export function streaks(activeDays: Set<string>, now: number, tz: string): { current: number; longest: number } {
  const today = dayKey(now, tz);
  let day = activeDays.has(today) ? today : addDays(today, -1);
  let current = 0;
  while (activeDays.has(day)) {
    current++;
    day = addDays(day, -1);
  }
  let longest = 0;
  let run = 0;
  let prev: string | null = null;
  for (const d of [...activeDays].sort()) {
    run = prev !== null && addDays(prev, 1) === d ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = d;
  }
  return { current, longest };
}
