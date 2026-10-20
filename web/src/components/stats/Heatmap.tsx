import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import type { HeatDay, StatsRange } from '../../../../shared/types';
import { formatCost } from '../../lib/format';
import { heatColumns, heatLevel } from '../../lib/stats';

const SPAN: Record<StatsRange, string> = { all: 'all time', year: 'last 12 months', month: 'last 30 days', week: 'last 7 days', today: 'today, by hour' };
const PLURAL = { reply: 'replies', image: 'images', clip: 'clips' } as const;

/** 'Mon, Oct 19, 2026', or 'Mon, Oct 19 · 14:00' for an hour cell. */
function cellLabel(key: string): string {
  const [day, hour] = key.split('T');
  const date = new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', {
    timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', ...(hour ? {} : { year: 'numeric' }),
  });
  return hour ? `${date} · ${hour}:00` : date;
}

export function Heatmap({ days, range, noun = 'reply' }: { days: HeatDay[]; range: StatsRange; noun?: keyof typeof PLURAL }) {
  // Scaled to the busiest cell in the range shown, so switching range rescales the shading.
  const max = Math.max(0, ...days.map((d) => d.replies));
  const columns = heatColumns(days);
  // A year of weeks needs small cells; a month gets bigger ones; a single row (hours, a week) shrinks to fit the width.
  const row = columns.every((c) => c.length === 1);
  const cell = columns.length > 24 ? 11 : 20;
  const scroller = useRef<HTMLDivElement>(null);
  // On narrow screens a long range scrolls sideways; start at the recent end.
  useEffect(() => {
    if (scroller.current) scroller.current.scrollLeft = scroller.current.scrollWidth;
  }, [days]);
  const count = (n: number) => `${n} ${n === 1 ? noun : PLURAL[noun]}`;
  return (
    <section className="panel">
      <h3 className="panel-head">Activity <span className="muted small">{SPAN[range]}</span></h3>
      {days.length === 0 ? (
        <p className="muted small">No activity yet</p>
      ) : (
        <div className={row ? 'heatmap row' : 'heatmap'} ref={scroller} role="img" aria-label={`${PLURAL[noun]} per ${range === 'today' ? 'hour' : 'day'}, ${SPAN[range]}`}
          style={{ '--heat-cell': `${cell}px` } as CSSProperties}>
          {columns.map((week, i) => (
            <div key={i} className="heat-week">
              {week.map((d, j) =>
                d ? (
                  <span key={j} className={`heat-cell l${heatLevel(d.replies, max)}`}
                    title={`${cellLabel(d.day)} · ${count(d.replies)}${d.cost ? ` · ${formatCost(d.cost)}` : ''}`} />
                ) : (
                  <span key={j} className="heat-cell pad" />
                ),
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
