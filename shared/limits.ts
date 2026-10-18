import type { LimitPeriod, SpendingLimits } from './types';

export const LIMIT_PERIODS: LimitPeriod[] = ['daily', 'weekly', 'monthly'];

/** Names for the calendar periods, so nobody expects them to match the Stats page's rolling Week and Month. */
export const LIMIT_LABELS: Record<LimitPeriod, string> = { daily: 'Today', weekly: 'This week (since Monday)', monthly: 'This month' };

export const DEFAULT_LIMITS: SpendingLimits = {
  daily: { enabled: false, amount: null },
  weekly: { enabled: false, amount: null },
  monthly: { enabled: false, amount: null },
  timeZone: 'UTC',
};

/** Where limit errors link to: Settings › General, scrolled to the limits. */
export const SPENDING_LIMITS_HREF = '#/settings/general/limits';

/** Matches the server's limit errors, so any error box can add a link to the limits. */
export const LIMIT_ERROR = /spending limit/i;

/** Share of a limit at which a notice appears near the composer. */
export const WARN_AT = 0.8;
