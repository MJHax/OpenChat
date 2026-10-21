import type { ReactNode } from 'react';
import { Brain, Image as ImageIcon, Wrench } from 'lucide-react';
import type { LocalModel } from '../../../shared/types';
import { formatContext } from '../lib/format';
import { formatSize } from '../lib/localModels';
import { TiltCard } from './TiltCard';

export interface LocalModelCardProps {
  model: LocalModel;
  serverName: string;
  added: boolean;
  busy: boolean;
  onAdd(): void;
  onRemove(): void;
}

/** A model a local server has installed; free to use, and it never leaves the computer. */
export function LocalModelCard({ model: m, serverName, added, busy, onAdd, onRemove }: LocalModelCardProps) {
  type Cap = { id: string; label: string; icon: ReactNode };
  const caps = ([
    m.supportsReasoning && { id: 'reasoning', label: 'Reasoning', icon: <Brain size={13} /> },
    m.supportsTools && { id: 'tools', label: 'Tools', icon: <Wrench size={13} /> },
    m.inputModalities.includes('image') && { id: 'vision', label: 'Vision', icon: <ImageIcon size={13} /> },
  ] as (Cap | false)[]).filter((c): c is Cap => !!c);
  const stats = [formatSize(m.sizeBytes), m.contextLength !== null && `${formatContext(m.contextLength)} ctx`].filter(Boolean);
  return (
    <TiltCard as="li" max={10} className="model-card">
      <div className="model-card-head">
        <span className="model-card-name" title={m.name}>{m.name}</span>
        <span className="badge">{serverName}</span>
      </div>
      <div className="model-card-stats">
        <span>Free · local</span>
        {stats.map((s) => <span key={String(s)}>{s}</span>)}
        {caps.map((c) => <span key={c.id} className="local-cap" title={c.label} aria-label={c.label}>{c.icon}</span>)}
      </div>
      <div className="model-card-actions">
        <button className="primary" disabled={added || busy} onClick={onAdd}>{added ? 'Added' : 'Add'}</button>
        {added && <button className="link accent" disabled={busy} onClick={onRemove}>Remove</button>}
      </div>
    </TiltCard>
  );
}
