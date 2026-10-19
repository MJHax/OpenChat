import { useEffect, useState } from 'react';
import { api } from '../../api';
import { formatCost } from '../../lib/format';

type Usage = { label: string; spent: number; limit: number | null };

/**
 * This month's spend against the monthly limit. Without a monthly limit there is no calendar-month total in the API,
 * so it shows the last 30 days from Stats instead.
 */
export function UsageCard({ refreshKey }: { refreshKey: unknown }) {
  const [usage, setUsage] = useState<Usage | null>(null);

  useEffect(() => {
    let current = true;
    api.limits()
      .then(async (statuses) => {
        const monthly = statuses.find((s) => s.period === 'monthly');
        if (monthly) return { label: 'This month', spent: monthly.spent, limit: monthly.amount };
        const stats = await api.stats('month', Intl.DateTimeFormat().resolvedOptions().timeZone);
        return { label: 'Last 30 days', spent: stats.allSpend, limit: null };
      })
      .then((u) => { if (current) setUsage(u); })
      .catch(() => { if (current) setUsage(null); });
    return () => { current = false; };
  }, [refreshKey]);

  if (!usage) return null;
  const share = usage.limit ? Math.min(1, usage.spent / usage.limit) : null;
  return (
    <a className="usage-card" href="#/stats">
      <span className="usage-row">
        <span>{usage.label}</span>
        <span className="mono">{formatCost(usage.spent)}{usage.limit !== null && ` / ${formatCost(usage.limit)}`}</span>
      </span>
      {share !== null && <span className="usage-bar"><i className="fill" style={{ width: `${share * 100}%` }} /></span>}
    </a>
  );
}
