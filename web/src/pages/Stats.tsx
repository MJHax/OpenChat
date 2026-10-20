import { useEffect, useState } from 'react';
import type { MediaStatsResponse, StatsRange, StatsResponse } from '../../../shared/types';
import { api } from '../api';
import { loadRange, RANGES, saveRange, trackingNote } from '../lib/stats';
import { money } from '../lib/imagePrice';
import { Segmented } from '../components/stats/Segmented';
import { StatTiles } from '../components/stats/StatTiles';
import { Heatmap } from '../components/stats/Heatmap';
import { UsageChart } from '../components/stats/UsageChart';
import { ModelRows } from '../components/stats/ModelRows';
import { FeaturePanels } from '../components/stats/FeaturePanels';
import { MediaStats } from '../components/stats/MediaStats';

const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

type View = 'chats' | 'images' | 'video';
const VIEWS: { id: View; label: string }[] = [{ id: 'chats', label: 'Chats' }, { id: 'images', label: 'Images' }, { id: 'video', label: 'Video' }];
const VIEW_KEY = 'openchat.stats.view';
const loadView = (): View => { try { const v = localStorage.getItem(VIEW_KEY); return v === 'images' || v === 'video' ? v : 'chats'; } catch { return 'chats'; } };
const saveView = (v: View) => { try { localStorage.setItem(VIEW_KEY, v); } catch { /* private mode */ } };

export function Stats() {
  const [range, setRange] = useState<StatsRange>(loadRange);
  const [view, setView] = useState<View>(loadView);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [media, setMedia] = useState<MediaStatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setError(null);
    const fail = (e: Error) => current && setError(e.message);
    if (view !== 'chats') setMedia(null); // don't show the other view's numbers while loading
    if (view === 'chats') api.stats(range, zone()).then((s) => current && setStats(s)).catch(fail);
    else api.mediaStats(view, range, zone()).then((s) => current && setMedia(s)).catch(fail);
    return () => { current = false; };
  }, [range, view]);

  function pick(r: StatsRange) {
    saveRange(r);
    setRange(r);
  }

  const shown = view === 'chats' ? stats : media;
  return (
    <div className="page">
      <div className="page-inner stats-page">
        <div className="stats-head">
          <h1>Stats</h1>
          <Segmented label="What to show" options={VIEWS} value={view} onChange={(v) => { saveView(v); setView(v); }} />
          <Segmented label="Time range" options={RANGES} value={range} onChange={pick} />
        </div>
        {error && <p className="error-text">{error}</p>}
        {!shown ? (
          !error && <p className="muted">Loading…</p>
        ) : view === 'chats' && stats ? (
          <>
            <StatTiles tiles={stats.tiles} range={stats.range} />
            <Heatmap days={stats.heatmap} range={stats.range} />
            <UsageChart buckets={stats.buckets} />
            <ModelRows models={stats.models} />
            <FeaturePanels features={stats.features} byCost={stats.biggestByCost} byLength={stats.biggestByLength} />
            <p className="muted small">{trackingNote(stats.trackingSince)}</p>
          </>
        ) : media ? (
          <MediaStats stats={media} noun={view === 'video' ? 'clip' : 'image'} />
        ) : null}
        {shown && <p className="muted small">All OpenChat spend in this range: {money(shown.allSpend)}</p>}
      </div>
    </div>
  );
}
