import type { StatsRange, StatsTiles } from '../../../../shared/types';
import { formatCost } from '../../lib/format';
import { TiltCard } from '../TiltCard';
import { compactNumber, formatChange, formatPercent, formatSeconds } from '../../lib/stats';

const PERIOD: Record<StatsRange, string> = { all: '', year: 'previous 365 days', month: 'previous 30 days', week: 'previous 7 days', today: 'yesterday so far' };

const money = (usd: number) => (usd === 0 ? '$0.00' : formatCost(usd));

function Tile({ label, value, sub }: { label: string; value: string; sub?: string | null }) {
  return (
    <TiltCard className="stat-tile" max={10}>
      <div className="stat-label">{label}</div>
      <div className="stat-value" title={value}>{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </TiltCard>
  );
}

export function StatTiles({ tiles: t, range }: { tiles: StatsTiles; range: StatsRange }) {
  const change = formatChange(t.cost, t.previousCost);
  return (
    <div className="stat-tiles">
      <Tile label="Cost" value={money(t.cost)} sub={change && `${change} vs ${PERIOD[range]}`} />
      <Tile label="Tokens" value={compactNumber(t.promptTokens + t.completionTokens)} sub={`${compactNumber(t.promptTokens)} in · ${compactNumber(t.completionTokens)} out`} />
      <Tile label="Messages" value={t.replies.toLocaleString('en-US')} sub={`across ${t.chats} chat${t.chats === 1 ? '' : 's'}`} />
      <Tile label="Cache hit rate" value={formatPercent(t.cacheHitRate)} sub={t.cacheSavings !== null ? `saved ~${money(t.cacheSavings)}` : null} />
      <Tile label="Web searches" value={t.webSearches.toLocaleString('en-US')} sub={t.webSearches ? money(t.webSearchCost) : null} />
      <Tile label="Avg first token" value={formatSeconds(t.avgFirstTokenMs)}
        sub={t.outputTokensPerSec !== null ? `${Math.round(t.outputTokensPerSec)} tok/s output` : null} />
      <Tile label="Active days" value={t.rangeDays ? `${t.activeDays} / ${t.rangeDays}` : String(t.activeDays)}
        sub={`streak ${t.currentStreak} · longest ${t.longestStreak}`} />
      <Tile label="Top model" value={t.topModel?.name ?? '—'} sub={t.topModel && `${formatPercent(t.topModel.share)} of replies`} />
    </div>
  );
}
