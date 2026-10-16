import type { CatalogModel } from '../../../shared/types';
import { CAPABILITIES, capabilitiesOf, isNew, UNUSED_HINT } from '../lib/catalog';
import { formatContext, formatPricePerM } from '../lib/format';

export interface ModelCardProps {
  model: CatalogModel;
  added: boolean;
  busy: boolean;
  onAdd(): void;
  onRemove(): void;
  /** Shelf variant: no description. */
  compact?: boolean;
}

/** Free and long context already show in the price and context line, so they get no pill. */
const PILLS = CAPABILITIES.filter((c) => c.id !== 'free' && c.id !== 'longContext');

export function ModelCard({ model: m, added, busy, onAdd, onRemove, compact = false }: ModelCardProps) {
  const caps = capabilitiesOf(m);
  const pills = PILLS.filter((c) => caps.includes(c.id));
  return (
    <li className={`model-card${compact ? ' compact' : ''}`}>
      <div className="model-card-head">
        <span className="model-card-name" title={m.name}>{m.name}</span>
        {isNew(m) && <span className="badge">New</span>}
      </div>
      <code className="model-card-id" title={m.id}>{m.id}</code>
      <div className="model-card-stats">
        <span>{caps.includes('free') ? 'Free' : `${formatPricePerM(m.promptPrice)} in · ${formatPricePerM(m.completionPrice)} out`}</span>
        {m.contextLength !== null && <span>{formatContext(m.contextLength)} ctx</span>}
      </div>
      {pills.length > 0 && (
        <div className="pills">
          {pills.map((c) => (
            <span key={c.id} className={`pill${c.usedByOpenChat ? '' : ' unused'}`} title={c.usedByOpenChat ? undefined : UNUSED_HINT}>
              {c.label}
            </span>
          ))}
        </div>
      )}
      {!compact && m.description && <p className="model-card-desc" title={m.description}>{m.description}</p>}
      <div className="model-card-actions">
        <button className="primary" disabled={added || busy} onClick={onAdd}>
          {added ? 'Added' : 'Add'}
        </button>
        {added && (
          <button className="link danger" disabled={busy} onClick={onRemove}>
            Remove
          </button>
        )}
      </div>
    </li>
  );
}
