import { useEffect, useRef } from 'react';
import type { HeatDay } from '../../../../shared/types';
import { formatCost } from '../../lib/format';
import { heatColumns, heatLevel } from '../../lib/stats';

const dayLabel = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

export function Heatmap({ days }: { days: HeatDay[] }) {
  const max = Math.max(0, ...days.map((d) => d.replies));
  const scroller = useRef<HTMLDivElement>(null);
  // On narrow screens the year scrolls sideways; start at the recent end.
  useEffect(() => {
    if (scroller.current) scroller.current.scrollLeft = scroller.current.scrollWidth;
  }, [days]);
  return (
    <section className="panel">
      <h3 className="panel-head">Activity <span className="muted small">always last 12 months</span></h3>
      <div className="heatmap" ref={scroller} role="img" aria-label="Replies per day over the last 12 months">
        {heatColumns(days).map((week, i) => (
          <div key={i} className="heat-week">
            {week.map((d, j) =>
              d ? (
                <span key={j} className={`heat-cell l${heatLevel(d.replies, max)}`}
                  title={`${dayLabel(d.day)} · ${d.replies} repl${d.replies === 1 ? 'y' : 'ies'}${d.cost ? ` · ${formatCost(d.cost)}` : ''}`} />
              ) : (
                <span key={j} className="heat-cell pad" />
              ),
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
