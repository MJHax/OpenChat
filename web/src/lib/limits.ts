import { WARN_AT } from '../../../shared/limits';
import type { LimitPeriod, LimitStatus } from '../../../shared/types';

const storageKey = (period: LimitPeriod) => `openchat.limits.dismissed.${period}`;

/** The start of the period whose notice was dismissed, or null. */
export function loadDismissed(period: LimitPeriod): number | null {
  try {
    const v = Number(localStorage.getItem(storageKey(period)));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

/** Hides this limit's notice until its period resets. */
export function dismissNotice(status: LimitStatus): void {
  try {
    localStorage.setItem(storageKey(status.period), String(status.start));
  } catch {
    // storage unavailable (private window); the notice just comes back on reload
  }
}

/** The limit to warn about: the fullest one at or past 80% whose notice wasn't dismissed in this period. */
export function noticeFor(statuses: LimitStatus[], dismissed: (period: LimitPeriod) => number | null = loadDismissed): LimitStatus | null {
  const due = statuses.filter((s) => s.spent >= s.amount * WARN_AT && dismissed(s.period) !== s.start);
  return due.reduce<LimitStatus | null>((a, s) => (a && a.spent / a.amount >= s.spent / s.amount ? a : s), null);
}
