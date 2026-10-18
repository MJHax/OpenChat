import { useEffect, useState } from 'react';
import type { LimitStatus } from '../../../shared/types';
import { LIMIT_LABELS, SPENDING_LIMITS_HREF } from '../../../shared/limits';
import { usd } from '../../../shared/videoModels';
import { api } from '../api';
import { dismissNotice, noticeFor } from '../lib/limits';

const resetTime = (ts: number) =>
  new Date(ts).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** A small notice once spending reaches 80% of a limit; dismissed until that limit's period resets. */
export function SpendNotice({ refreshKey }: { refreshKey: unknown }) {
  const [statuses, setStatuses] = useState<LimitStatus[]>([]);
  const [, setDismissed] = useState(0);

  useEffect(() => {
    let current = true;
    api.limits().then((s) => current && setStatuses(s)).catch(() => {});
    return () => { current = false; };
  }, [refreshKey]);

  const s = noticeFor(statuses);
  if (!s) return null;
  const over = s.spent >= s.amount;
  return (
    <div className="spend-notice" role="status">
      <span>
        {LIMIT_LABELS[s.period]}: {usd(s.spent)} of your {usd(s.amount)} limit{over ? ' — reached' : ` (${Math.floor((s.spent / s.amount) * 100)}%)`}.
        {' '}Resets {resetTime(s.resetsAt)}. <a href={SPENDING_LIMITS_HREF}>Limits</a>
      </span>
      <button className="icon" aria-label="Dismiss until the limit resets" onClick={() => { dismissNotice(s); setDismissed((n) => n + 1); }}>✕</button>
    </div>
  );
}
