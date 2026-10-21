import { useState } from 'react';
import type { ModelStats } from '../../../../shared/types';
import { formatCost } from '../../lib/format';
import { compactNumber, formatPercent, formatSeconds } from '../../lib/stats';
import { ChevronDown, ChevronRight } from 'lucide-react';

const money = (usd: number | null) => (usd === null ? '—' : usd === 0 ? '$0.00' : formatCost(usd));

function Detail({ label, value }: { label: string; value: string }) {
  return <div><span className="stat-label">{label}</span>{value}</div>;
}

function ModelRow({ m, top }: { m: ModelStats; top: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="stat-model">
      <button type="button" className="stat-model-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="stat-model-name" title={m.id}>{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />} {m.name}</span>
        <span className="share-bar"><b style={{ width: `${top ? (m.replies / top) * 100 : 0}%` }} /></span>
        <span className="muted small">{m.replies} repl{m.replies === 1 ? 'y' : 'ies'} · {money(m.cost)}</span>
      </button>
      {open && (
        <div className="stat-model-body">
          <Detail label="Tokens" value={compactNumber(m.tokens)} />
          <Detail label="Cache hit" value={formatPercent(m.cacheHitRate)} />
          <Detail label="First token" value={formatSeconds(m.avgFirstTokenMs)} />
          <Detail label="Output speed" value={m.outputTokensPerSec === null ? '—' : `${Math.round(m.outputTokensPerSec)} tok/s`} />
          {m.local && <Detail label="Load time" value={formatSeconds(m.avgLoadMs)} />}
          <Detail label="Avg cost/reply" value={money(m.avgCostPerReply)} />
          <Detail label="Reasoning tokens" value={m.reasoningTokens === null ? '—' : compactNumber(m.reasoningTokens)} />
          <Detail label="Errors / stopped" value={`${formatPercent(m.errorRate)} / ${formatPercent(m.stoppedRate)}`} />
          <Detail label="Searches" value={String(m.webSearches)} />
        </div>
      )}
    </div>
  );
}

export function ModelRows({ models }: { models: ModelStats[] }) {
  const top = models[0]?.replies ?? 0;
  return (
    <section>
      <h3 className="section-title">By model</h3>
      {models.length === 0 ? <p className="muted small">No usage in this range</p> : models.map((m) => <ModelRow key={m.id} m={m} top={top} />)}
    </section>
  );
}
