import { useEffect, useState } from 'react';
import type { StatsRange, StatsResponse } from '../../../shared/types';
import { api } from '../api';
import { loadRange, RANGES, saveRange, trackingNote } from '../lib/stats';
import { Segmented } from '../components/stats/Segmented';
import { StatTiles } from '../components/stats/StatTiles';
import { Heatmap } from '../components/stats/Heatmap';
import { UsageChart } from '../components/stats/UsageChart';
import { ModelRows } from '../components/stats/ModelRows';
import { FeaturePanels } from '../components/stats/FeaturePanels';

const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function Stats() {
  const [range, setRange] = useState<StatsRange>(loadRange);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setError(null);
    api.stats(range, zone())
      .then((s) => current && setStats(s))
      .catch((e: Error) => current && setError(e.message));
    return () => { current = false; };
  }, [range]);

  function pick(r: StatsRange) {
    saveRange(r);
    setRange(r);
  }

  return (
    <div className="page">
      <div className="page-inner stats-page">
        <div className="stats-head">
          <h1>Stats</h1>
          <Segmented label="Time range" options={RANGES} value={range} onChange={pick} />
        </div>
        {error && <p className="error-text">{error}</p>}
        {!stats ? (
          !error && <p className="muted">Loading…</p>
        ) : (
          <>
            <StatTiles tiles={stats.tiles} range={stats.range} />
            <Heatmap days={stats.heatmap} />
            <UsageChart buckets={stats.buckets} />
            <ModelRows models={stats.models} />
            <FeaturePanels features={stats.features} byCost={stats.biggestByCost} byLength={stats.biggestByLength} />
            <p className="muted small">{trackingNote(stats.trackingSince)}</p>
          </>
        )}
      </div>
    </div>
  );
}
