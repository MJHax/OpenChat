import type { DB } from './db';
import { HttpError } from './http';
import { cachedMediaModel } from './mediaLibrary';
import { dayKey, isValidZone, startOfLocalDay } from './statsTime';
import { DEFAULT_LIMITS, LIMIT_PERIODS } from '../../shared/limits';
import { usd, videoPrice, type VideoModel, type VideoSettings } from '../../shared/videoModels';
import type { LimitPeriod, LimitSetting, LimitStatus, SpendingLimits } from '../../shared/types';

const KEY = 'spending_limits';
const DAY = 86_400_000;
// Half a day past local midnight is always inside that local day, even across a daylight-saving change.
const NOON = DAY / 2;

const NAMES: Record<LimitPeriod, string> = { daily: 'daily', weekly: 'weekly', monthly: 'monthly' };

function localDate(ts: number, tz: string): { y: number; m: number; d: number } {
  const [y, m, d] = dayKey(ts, tz).split('-').map(Number);
  return { y, m, d };
}

/** The local midnight `days` calendar days from the local day that starts at `midnight`. */
const shiftDays = (midnight: number, days: number, tz: string) => startOfLocalDay(midnight + days * DAY + NOON, tz);

/** When the calendar period containing `now` started, and when the next one starts, in `tz`. */
export function periodBounds(period: LimitPeriod, now: number, tz: string): { start: number; resetsAt: number } {
  const today = startOfLocalDay(now, tz);
  const { y, m, d } = localDate(now, tz);
  if (period === 'daily') return { start: today, resetsAt: shiftDays(today, 1, tz) };
  if (period === 'weekly') {
    const sinceMonday = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
    const start = shiftDays(today, -sinceMonday, tz);
    return { start, resetsAt: shiftDays(start, 7, tz) };
  }
  const start = shiftDays(today, 1 - d, tz);
  const inNextMonth = shiftDays(start, 32, tz);
  return { start, resetsAt: shiftDays(inNextMonth, 1 - localDate(inNextMonth, tz).d, tz) };
}

export function getLimits(db: DB): SpendingLimits {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY) as { value: string } | undefined;
  if (!row) return DEFAULT_LIMITS;
  try {
    return { ...DEFAULT_LIMITS, ...(JSON.parse(row.value) as Partial<SpendingLimits>) };
  } catch {
    return DEFAULT_LIMITS;
  }
}

function cleanSetting(value: unknown, period: LimitPeriod): LimitSetting {
  const v = (value ?? {}) as Partial<LimitSetting>;
  const enabled = v.enabled === true;
  const amount = typeof v.amount === 'number' && Number.isFinite(v.amount) && v.amount > 0 ? v.amount : null;
  if (v.amount !== null && v.amount !== undefined && amount === null) throw new HttpError(400, `The ${NAMES[period]} limit must be greater than $0.`);
  if (enabled && amount === null) throw new HttpError(400, `The ${NAMES[period]} limit must be greater than $0.`);
  return { enabled, amount };
}

export function saveLimits(db: DB, value: unknown): void {
  const v = (value ?? {}) as Partial<SpendingLimits>;
  if (typeof v.timeZone !== 'string' || !isValidZone(v.timeZone)) throw new HttpError(400, 'Spending limits need a valid time zone.');
  const limits: SpendingLimits = {
    daily: cleanSetting(v.daily, 'daily'),
    weekly: cleanSetting(v.weekly, 'weekly'),
    monthly: cleanSetting(v.monthly, 'monthly'),
    timeZone: v.timeZone,
  };
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(KEY, JSON.stringify(limits));
}

/** The estimated price of every clip still rendering: it isn't logged until it finishes, but it is already committed. */
function renderingEstimate(db: DB): number {
  const jobs = db.prepare('SELECT model_id, settings, photos FROM video_jobs WHERE finished_at IS NULL').all() as { model_id: string; settings: string; photos: number }[];
  return jobs.reduce((total, j) => {
    const model = cachedMediaModel(db, 'video', j.model_id) as VideoModel | null;
    return total + (model ? videoPrice(model, JSON.parse(j.settings) as VideoSettings, j.photos).cost ?? 0 : 0);
  }, 0);
}

/** Everything OpenChat spent since `since`: the same calls the Stats page counts. Local models cost nothing and never count. */
function spentSince(db: DB, since: number): number {
  return (db.prepare(
    `SELECT (SELECT COALESCE(SUM(cost), 0) FROM usage_events WHERE created_at >= ? AND COALESCE(model_id, '') NOT LIKE 'local:%')
       + (SELECT COALESCE(SUM(cost), 0) FROM media_events WHERE created_at >= ?) AS total`,
  ).get(since, since) as { total: number }).total;
}

/** The enabled limits, in daily → weekly → monthly order, with what has been spent in each current period. */
export function limitStatuses(db: DB, now = Date.now()): LimitStatus[] {
  const limits = getLimits(db);
  const enabled = LIMIT_PERIODS.filter((p) => limits[p].enabled && limits[p].amount !== null);
  if (!enabled.length) return [];
  const rendering = renderingEstimate(db);
  return enabled.map((period) => {
    const { start, resetsAt } = periodBounds(period, now, limits.timeZone);
    return { period, amount: limits[period].amount!, spent: spentSince(db, start) + rendering, start, resetsAt };
  });
}

function resetText(ts: number, tz: string): string {
  const date = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' }).format(ts);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(ts);
  return `${date} at ${time}`;
}

export interface LimitBlock {
  status: LimitStatus;
  /** The full error: which limit, and when it resets. */
  message: string;
  /** "Daily spending limit reached" — for places that only have room for a few words. */
  short: string;
}

/**
 * The limit that stops a new request, or null. With an `estimate`, the request is also stopped when its price would go
 * over what is left. Work already running never comes through here, so a limit never interrupts it.
 */
export function spendBlock(db: DB, opts: { estimate?: number | null; now?: number } = {}): LimitBlock | null {
  const tz = getLimits(db).timeZone;
  for (const s of limitStatuses(db, opts.now)) {
    const name = NAMES[s.period];
    const resets = `It resets ${resetText(s.resetsAt, tz)}.`;
    const short = `${name[0].toUpperCase()}${name.slice(1)} spending limit reached`;
    if (s.spent >= s.amount) return { status: s, short, message: `${short} (${usd(s.amount)}). ${resets}` };
    const estimate = opts.estimate ?? null;
    if (estimate !== null && s.spent + estimate > s.amount) {
      const message = `This costs about ${usd(estimate)}, more than the ${usd(s.amount - s.spent)} left of your ${name} spending limit (${usd(s.amount)}). ${resets}`;
      return { status: s, short, message };
    }
  }
  return null;
}

/** Throws the limit error (402) when a new paid request must not start. */
export function checkSpend(db: DB, opts: { estimate?: number | null; now?: number } = {}): void {
  const block = spendBlock(db, opts);
  if (block) throw new HttpError(402, block.message);
}
