import type { SourceTotals, StatsResponse } from '../../../../shared/types';
import { formatSeconds, formatSpeed, sourceLine } from '../../lib/stats';

function SourceRow({ name, totals, top }: { name: string; totals: SourceTotals; top: number }) {
  return (
    <div className="stat-model">
      <div className="stat-model-head">
        <span className="stat-model-name">{name}</span>
        <span className="share-bar"><b style={{ width: `${top ? (totals.replies / top) * 100 : 0}%` }} /></span>
        <span className="muted small">{sourceLine(totals)}</span>
      </div>
    </div>
  );
}

export function LocalStats({ stats }: { stats: StatsResponse }) {
  const { local, openrouter } = stats.sources;
  if (local.replies === 0) return null;
  const top = Math.max(local.replies, openrouter.replies);
  const models = stats.models.filter((m) => m.local);
  return (
    <>
      <section>
        <h3 className="section-title">Local vs OpenRouter</h3>
        <SourceRow name="Local" totals={local} top={top} />
        <SourceRow name="OpenRouter" totals={openrouter} top={top} />
      </section>
      <section>
        <h3 className="section-title">Local model speed</h3>
        <table className="media-models">
          <thead><tr><th>Model</th><th>Speed</th><th>First token</th><th>Cold load</th></tr></thead>
          <tbody>
            {models.map((m) => (
              <tr key={m.id}>
                <td>{m.name}</td><td>{formatSpeed(m.outputTokensPerSec)}</td><td>{formatSeconds(m.avgFirstTokenMs)}</td><td>{formatSeconds(m.avgLoadMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
