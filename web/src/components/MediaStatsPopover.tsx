import { useEffect, useState } from 'react';
import type { MediaThreadStats } from '../../../shared/types';
import { api } from '../api';
import { money } from '../lib/imagePrice';
import { usePopover } from './usePopover';
import { ChevronDown } from 'lucide-react';

function Row({ label, value }: { label: string; value: string }) {
  return <div className="stats-pop-row"><span className="muted">{label}</span><span>{value}</span></div>;
}

const seconds = (ms: number | null) => (ms === null ? '—' : `${Math.round(ms / 1000)}s`);

/** An image thread's header total; opens to images made, spend, averages and failures. */
export function MediaStatsPopover({ threadId, totalCost, refreshKey, noun = 'image' }: { threadId: string; totalCost: number; refreshKey: unknown; noun?: 'image' | 'clip' }) {
  const { open, setOpen, root } = usePopover();
  const [s, setStats] = useState<MediaThreadStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let current = true;
    setError(null);
    api.mediaThreadStats(threadId).then((x) => current && setStats(x)).catch((e: Error) => current && setError(e.message));
    return () => { current = false; };
  }, [open, threadId, refreshKey]);

  return (
    <div className="stats-pop" ref={root}>
      <button type="button" className="link stats-pop-button" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}>
        Total {money(totalCost)} <ChevronDown size={14} />
      </button>
      {open && (
        <div className="stats-pop-panel" role="dialog" aria-label="This thread's stats">
          <h4>This thread</h4>
          {error ? <p className="error-text small">{error}</p> : !s ? <p className="muted small">Loading…</p> : (
            <>
              <Row label={noun === 'clip' ? 'Clips' : 'Images'} value={String(s.count)} />
              <Row label="Spent" value={money(s.spend)} />
              <Row label={`Avg per ${noun}`} value={s.avgCost === null ? '—' : money(s.avgCost)} />
              <Row label="Avg time" value={seconds(s.avgDurationMs)} />
              <Row label="Failed (not charged)" value={String(s.failures)} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
