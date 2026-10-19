import { useState } from 'react';
import type { CatalogModel } from '../../../shared/types';
import { CAPABILITIES, capabilitiesOf, isNew, UNUSED_HINT } from '../lib/catalog';
import { formatContext, formatPricePerM } from '../lib/format';
import { TiltCard } from './TiltCard';
import { ProviderMark } from './ProviderMark';

export interface ModelCardProps {
  model: CatalogModel;
  added: boolean;
  busy: boolean;
  onAdd(): void;
  onRemove(): void;
  /** Shelf variant: no description until expanded. */
  compact?: boolean;
}

/** Free and long context already show in the price and context line, so they get no pill. */
const PILLS = CAPABILITIES.filter((c) => c.id !== 'free' && c.id !== 'longContext');

export function ModelCard({ model: m, added, busy, onAdd, onRemove, compact = false }: ModelCardProps) {
  const [open, setOpen] = useState(false);
  const caps = capabilitiesOf(m);
  const pills = PILLS.filter((c) => caps.includes(c.id));
  return (
    <TiltCard as="li" max={10} className={`model-card${compact ? ' compact' : ''}`}>
      <div className="model-card-head">
        <ProviderMark id={m.id} />
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
              {!c.usedByOpenChat && <span className="visually-hidden"> ({UNUSED_HINT})</span>}
            </span>
          ))}
        </div>
      )}
      {open ? (
        <div className="image-model-details">
          {m.description && <p className="small">{m.description}</p>}
          <a className="small" href={`https://openrouter.ai/${m.id}`} target="_blank" rel="noopener noreferrer">More on OpenRouter</a>
          {m.maxOutput !== null && <p className="small muted">Max output: {formatContext(m.maxOutput)} tokens</p>}
          {m.cacheReadPrice !== null && m.cacheReadPrice >= 0 && <p className="small muted">Cached input: {formatPricePerM(m.cacheReadPrice)}</p>}
          <p className="small muted">Accepts: {m.inputModalities.join(', ')}</p>
          {m.created !== null && <p className="small muted">Listed {new Date(m.created * 1000).toLocaleDateString()}</p>}
        </div>
      ) : (
        !compact && m.description && <p className="model-card-desc" title={m.description}>{m.description}</p>
      )}
      <div className="model-card-actions">
        <button className="primary" disabled={added || busy} onClick={onAdd}>
          {added ? 'Added' : 'Add'}
        </button>
        {added && (
          <button className="link danger" disabled={busy} onClick={onRemove}>
            Remove
          </button>
        )}
        <button className="link" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Less' : 'More'}</button>
      </div>
    </TiltCard>
  );
}
