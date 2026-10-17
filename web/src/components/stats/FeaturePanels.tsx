import { useState } from 'react';
import type { BigChat, FeatureStats } from '../../../../shared/types';
import { formatCost } from '../../lib/format';
import { Segmented } from './Segmented';

type Order = 'cost' | 'length';
const ORDERS: { id: Order; label: string }[] = [{ id: 'cost', label: 'Cost' }, { id: 'length', label: 'Length' }];

function Line({ label, value }: { label: string; value: string }) {
  return <div className="stat-line"><span>{label}</span><span className="muted">{value}</span></div>;
}

export function FeaturePanels({ features: f, byCost, byLength }: { features: FeatureStats; byCost: BigChat[]; byLength: BigChat[] }) {
  const [order, setOrder] = useState<Order>('cost');
  const chats = order === 'cost' ? byCost : byLength;
  return (
    <div className="stat-two">
      <section className="panel">
        <h3 className="panel-head">Features used</h3>
        <Line label="Compare mode" value={`${f.compareRuns} time${f.compareRuns === 1 ? '' : 's'}`} />
        <Line label="Web search" value={`${f.webSearchReplies} repl${f.webSearchReplies === 1 ? 'y' : 'ies'}`} />
        <Line label="Attachments" value={`${f.attachments} file${f.attachments === 1 ? '' : 's'}`} />
        <Line label="Regenerated / edited" value={String(f.regeneratedOrEdited)} />
        <Line label="Input : output tokens" value={f.inputOutputRatio === null ? '—' : `${f.inputOutputRatio.toFixed(1)} : 1`} />
      </section>
      <section className="panel">
        <div className="panel-head">
          <h3>Biggest chats</h3>
          <Segmented label="Order chats by" options={ORDERS} value={order} onChange={setOrder} />
        </div>
        {chats.length === 0 ? (
          <p className="muted small">No usage in this range</p>
        ) : (
          chats.map((c) => (
            <div key={c.id} className="stat-line">
              <a href={`#/chat/${c.id}`} title={c.title}>{c.title}</a>
              <span className="muted">{order === 'cost' ? formatCost(c.cost) || '$0' : `${c.replies} repl${c.replies === 1 ? 'y' : 'ies'}`}</span>
            </div>
          ))
        )}
      </section>
    </div>
  );
}
