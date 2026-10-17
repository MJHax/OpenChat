import { useState } from 'react';
import type { UsageBucket } from '../../../../shared/types';
import { formatCost } from '../../lib/format';
import { compactNumber } from '../../lib/stats';
import { Segmented } from './Segmented';

type Metric = 'cost' | 'tokens' | 'messages';
const METRICS: { id: Metric; label: string }[] = [{ id: 'cost', label: 'Cost' }, { id: 'tokens', label: 'Tokens' }, { id: 'messages', label: 'Messages' }];

const parts = (b: UsageBucket, m: Metric): [number, number] =>
  m === 'cost' ? [b.replyCost, b.backgroundCost] : m === 'tokens' ? [b.replyTokens, b.backgroundTokens] : [b.replies, b.backgroundCalls];

const show = (v: number, m: Metric) => (m === 'cost' ? formatCost(v) || '$0' : compactNumber(v));

export function UsageChart({ buckets }: { buckets: UsageBucket[] }) {
  const [metric, setMetric] = useState<Metric>('cost');
  const max = Math.max(0, ...buckets.map((b) => parts(b, metric)[0] + parts(b, metric)[1]));
  // Label about six evenly spaced buckets so dense ranges stay readable.
  const every = Math.max(1, Math.ceil(buckets.length / 6));
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>Usage over time</h3>
        <Segmented label="Chart metric" options={METRICS} value={metric} onChange={setMetric} />
      </div>
      {buckets.length === 0 || max === 0 ? (
        <p className="muted small">No usage in this range</p>
      ) : (
        <>
          <div className="chart">
            {buckets.map((b) => {
              const [reply, background] = parts(b, metric);
              return (
                <div key={b.key} className="chart-col" title={`${b.label}: ${show(reply + background, metric)} (${show(background, metric)} background)`}>
                  <span className="chart-bar background" style={{ height: `${(background / max) * 100}%` }} />
                  <span className="chart-bar reply" style={{ height: `${(reply / max) * 100}%` }} />
                </div>
              );
            })}
          </div>
          <div className="chart-labels">
            {buckets.map((b, i) => <span key={b.key}>{i % every === 0 ? b.label : ''}</span>)}
          </div>
          <div className="chart-legend small muted">
            <span><i className="swatch reply" />Chat replies</span>
            <span><i className="swatch background" />Background (titles, memory)</span>
          </div>
        </>
      )}
    </section>
  );
}
