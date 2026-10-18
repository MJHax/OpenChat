import { useEffect, useState } from 'react';
import type { LimitPeriod, LimitStatus, SettingsUpdate, SpendingLimits } from '../../../../shared/types';
import { LIMIT_LABELS, LIMIT_PERIODS } from '../../../../shared/limits';
import { usd } from '../../../../shared/videoModels';
import { api } from '../../api';

const NAMES: Record<LimitPeriod, string> = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };

type Draft = Record<LimitPeriod, { enabled: boolean; amount: string }>;

const toDraft = (l: SpendingLimits): Draft =>
  Object.fromEntries(LIMIT_PERIODS.map((p) => [p, { enabled: l[p].enabled, amount: l[p].amount === null ? '' : String(l[p].amount) }])) as Draft;

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const resetTime = (ts: number) => new Date(ts).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function SpendingLimitsSection({ limits, update }: { limits: SpendingLimits; update(patch: SettingsUpdate): Promise<boolean> }) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(limits));
  const [statuses, setStatuses] = useState<LimitStatus[]>([]);
  const [note, setNote] = useState('');

  const refresh = () => api.limits().then(setStatuses).catch(() => {});
  useEffect(() => { void refresh(); }, []);

  const set = (p: LimitPeriod, patch: Partial<Draft[LimitPeriod]>) => setDraft((d) => ({ ...d, [p]: { ...d[p], ...patch } }));

  async function save() {
    const amount = (s: string) => (s.trim() === '' ? null : Number(s));
    const next: SpendingLimits = {
      daily: { enabled: draft.daily.enabled, amount: amount(draft.daily.amount) },
      weekly: { enabled: draft.weekly.enabled, amount: amount(draft.weekly.amount) },
      monthly: { enabled: draft.monthly.enabled, amount: amount(draft.monthly.amount) },
      timeZone: browserZone(),
    };
    if (await update({ spendingLimits: next })) {
      setNote('Saved.');
      setTimeout(() => setNote(''), 2000);
      void refresh();
    }
  }

  return (
    <>
      <h2 id="limits">Spending limits</h2>
      <div className="card">
        <div className="muted small">
          Stop new requests once OpenChat has spent this much: chat replies, comparisons, titles, memory suggestions, images and
          videos. Anything already running finishes. Periods follow the calendar in your time zone ({browserZone()}): the day from
          midnight, the week from Monday, the month from the 1st, so they won't match the Stats page's rolling Week and Month.
        </div>
        {LIMIT_PERIODS.map((p) => {
          const s = statuses.find((x) => x.period === p);
          return (
            <div key={p} className="limit-row">
              <label className="limit-toggle">
                <input type="checkbox" checked={draft[p].enabled} onChange={(e) => set(p, { enabled: e.target.checked })} />
                {NAMES[p]}
              </label>
              <span className="limit-amount">
                $<input type="number" min="0.01" step="0.01" inputMode="decimal" value={draft[p].amount} placeholder="0.00"
                  aria-label={`${NAMES[p]} limit in US dollars`} onChange={(e) => set(p, { amount: e.target.value })} />
              </span>
              <span className="muted small">
                {s ? `${LIMIT_LABELS[p]}: ${usd(s.spent)} spent · resets ${resetTime(s.resetsAt)}` : LIMIT_LABELS[p]}
              </span>
            </div>
          );
        })}
        <div className="row">
          {note && <span className="muted small">{note}</span>}
          <button className="primary" onClick={save}>Save limits</button>
        </div>
      </div>
    </>
  );
}
