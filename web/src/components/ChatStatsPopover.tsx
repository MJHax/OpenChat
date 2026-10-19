import { useEffect, useState } from 'react';
import type { ChatStats } from '../../../shared/types';
import { api } from '../api';
import { formatCost } from '../lib/format';
import { compactNumber, emptyChatStats, formatPercent } from '../lib/stats';
import { usePopover } from './usePopover';
import { BarChart3 } from 'lucide-react';

export interface ChatStatsPopoverProps {
  /** null for a chat that hasn't been created yet: everything reads 0. */
  chatId: string | null;
  totalCost: number;
  /** Changes whenever the chat reloads (e.g. after a reply), so open stats refresh. */
  refreshKey: unknown;
}

const money = (usd: number | null) => (usd === null ? '—' : usd === 0 ? '$0.00' : formatCost(usd));

function Row({ label, value }: { label: string; value: string }) {
  return <div className="stats-pop-row"><span className="muted">{label}</span><span>{value}</span></div>;
}

export function ChatStatsPopover({ chatId, totalCost, refreshKey }: ChatStatsPopoverProps) {
  const { open, setOpen, root } = usePopover();
  const [stats, setStats] = useState<ChatStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (!chatId) {
      setStats(emptyChatStats());
      return;
    }
    let current = true;
    setError(null);
    api.chatStats(chatId)
      .then((s) => current && setStats(s))
      .catch((e: Error) => current && setError(e.message));
    return () => { current = false; };
  }, [open, chatId, refreshKey]);

  const s = stats;
  const hit = s?.cacheHitRate ?? null;
  return (
    <div className="stats-pop" ref={root}>
      <button type="button" className="chip ghost" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)} title="This chat's cost and stats">
        <BarChart3 size={13} />{money(totalCost)}
      </button>
      {open && (
        <div className="stats-pop-panel popover down right" role="dialog" aria-label="This chat's stats">
          <h4>This chat</h4>
          {error ? (
            <p className="error-text small">{error}</p>
          ) : !s ? (
            <p className="muted small">Loading…</p>
          ) : (
            <>
              <Row label="Cost" value={money(s.cost)} />
              <Row label="Tokens" value={`${compactNumber(s.promptTokens + s.completionTokens)} (${compactNumber(s.promptTokens)} in / ${compactNumber(s.completionTokens)} out)`} />
              <Row label="Cache" value={hit === null ? '—' : `${formatPercent(hit)} hit · ${formatPercent(1 - hit)} miss`} />
              {hit !== null && (
                <div className="cache-bar" aria-hidden="true">
                  <b style={{ width: `${hit * 100}%` }} />
                </div>
              )}
              <Row label="Saved by cache" value={money(s.cacheSavings)} />
              <Row label="Replies" value={`${s.replies}${s.replies ? ` (${s.models} model${s.models === 1 ? '' : 's'})` : ''}`} />
              <Row label="Web searches" value={String(s.webSearches)} />
              <Row label="Avg prompt size" value={s.avgPromptTokens === null ? '—' : compactNumber(s.avgPromptTokens)} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
