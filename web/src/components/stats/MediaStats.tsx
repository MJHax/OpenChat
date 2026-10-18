import { useState } from 'react';
import type { MediaStatsResponse } from '../../../../shared/types';
import { compactNumber, formatSeconds } from '../../lib/stats';
import { money } from '../../lib/imagePrice';
import { Heatmap } from './Heatmap';
import { Segmented } from './Segmented';

function Tile({ label, value, sub }: { label: string; value: string; sub?: string | null }) {
  return (
    <div className="stat-tile">
      <div className="stat-label">{label}</div>
      <div className="stat-value" title={value}>{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

const usd = (n: number | null | undefined) => (n == null ? '—' : money(n));

/** The Images (or Video) view of the Stats page. */
export function MediaStats({ stats: s, noun }: { stats: MediaStatsResponse; noun: 'image' | 'clip' }) {
  const [metric, setMetric] = useState<'count' | 'cost'>('count');
  const t = s.tiles;
  const plural = `${noun}s`;
  const max = Math.max(0, ...s.buckets.map((b) => (metric === 'count' ? b.count : b.cost)));
  return (
    <>
      <div className="stat-tiles">
        <Tile label={plural[0].toUpperCase() + plural.slice(1)} value={t.count.toLocaleString('en-US')} sub={t.failures ? `${t.failures} failed (not charged)` : null} />
        <Tile label="Spent" value={usd(t.spend)} sub="including titles" />
        <Tile label={`Avg per ${noun}`} value={usd(t.avgCost)} />
        <Tile label="Avg time" value={formatSeconds(t.avgDurationMs)} />
        <Tile label="Tokens" value={compactNumber(t.promptTokens + t.completionTokens)}
          sub={t.tokenModels ? `${compactNumber(t.promptTokens)} in · ${compactNumber(t.completionTokens)} out · from models that report tokens` : 'none of these models report tokens'} />
        {t.seconds !== undefined && <Tile label="Seconds" value={String(t.seconds)} sub={t.avgCostPerSecond != null ? `${usd(t.avgCostPerSecond)} / s` : null} />}
      </div>
      <Heatmap days={s.heatmap} />
      <div className="panel">
        <div className="panel-head">
          <h3>{metric === 'count' ? plural[0].toUpperCase() + plural.slice(1) : 'Spend'} over time</h3>
          <Segmented label="Chart metric" options={[{ id: 'count', label: plural }, { id: 'cost', label: 'Cost' }]} value={metric} onChange={setMetric} />
        </div>
        <div className="media-chart">
          {s.buckets.map((b) => {
            const v = metric === 'count' ? b.count : b.cost;
            return (
              <div key={b.key} className="media-bar" title={`${b.label}: ${metric === 'count' ? v : usd(v)}`}>
                <b style={{ height: `${max ? (v / max) * 100 : 0}%` }} />
                <span>{b.label}</span>
              </div>
            );
          })}
        </div>
      </div>
      {s.modes && (
        <div className="panel">
          <h3 className="panel-head">New and edited</h3>
          <p className="small">{s.modes.new} new · {s.modes.editGenerated} edits of generated images · {s.modes.editUpload} edits of your photos</p>
        </div>
      )}
      <div className="panel">
        <h3 className="panel-head">By model</h3>
        <table className="media-models">
          <thead><tr><th>Model</th><th>{plural}</th><th>Spent</th><th>Avg</th><th>Avg time</th><th>Tokens in / out</th><th>Failed</th></tr></thead>
          <tbody>
            {s.models.map((m) => (
              <tr key={m.id}>
                <td>{m.name}</td><td>{m.count}</td><td>{usd(m.spend)}</td><td>{usd(m.avgCost)}</td><td>{formatSeconds(m.avgDurationMs)}</td>
                <td>{m.promptTokens === null ? '—' : `${compactNumber(m.promptTokens)} / ${compactNumber(m.completionTokens ?? 0)}`}</td><td>{m.failures}</td>
              </tr>
            ))}
            {s.models.length === 0 && <tr><td colSpan={7} className="muted">Nothing in this range.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
