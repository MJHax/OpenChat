import type { CSSProperties } from 'react';
import type { Message } from '../../../shared/types';
import { formatCost, formatTokens } from '../lib/format';
import { timingParts } from '../lib/timing';
import { MessageBody } from './MessageBody';
import { Sources } from './Sources';
import { ThinkingIndicator } from './ThinkingIndicator';

export interface Column {
  key: string;
  modelName: string;
  text: string;
  reasoning: string;
  /** What the server is waiting on, if it said (e.g. a model loading). */
  status: string | null;
  startedAt: number;
  streaming: boolean;
  error: string | null;
  /** The saved reply, once there is one (complete or stopped). */
  message: Message | null;
  /** Whether this reply may search the web (for the thinking indicator). */
  webSearch?: boolean;
}

interface Props {
  title?: string;
  columns: Column[];
  onContinue?(messageId: string): void;
  onClose?(): void;
  /** A note shown in the head above the columns, e.g. that local models on one server take turns. */
  note?: string;
}

export function CompareColumns({ title, columns, onContinue, onClose, note }: Props) {
  return (
    <div className="compare">
      {(title || onClose || note) && (
        <div className="compare-head">
          <span className="muted small">{title}</span>
          {note && <span className="muted small">{note}</span>}
          {onClose && <button className="link" onClick={onClose}>Close</button>}
        </div>
      )}
      <div className="compare-columns" style={{ '--cols': columns.length } as CSSProperties}>
        {columns.map((col) => {
          const m = col.message;
          const tokens = (m?.promptTokens ?? 0) + (m?.completionTokens ?? 0);
          return (
            <div key={col.key} className="compare-col">
              <div className="compare-model">{col.modelName}</div>
              {col.streaming && !col.text && <ThinkingIndicator startedAt={col.startedAt} reasoning={col.reasoning} webSearch={col.webSearch} status={col.status ?? undefined} />}
              {col.text && <div className="msg-body"><MessageBody text={col.text} messageId={m?.id ?? null} streaming={col.streaming} /></div>}
              {col.error && <div className="error-text small">{col.error}</div>}
              {m?.status === 'stopped' && !col.error && <div className="muted small">Response stopped</div>}
              {m?.contextDropped && <div className="muted small">Earlier messages were dropped because the chat is longer than this model's memory.</div>}
              {m && (
                <div className="msg-meta">
                  {tokens > 0 && <span>{formatTokens(tokens)} tok</span>}
                  {timingParts(m.timing).map((part) => <span key={part}>· {part}</span>)}
                  {m.cost !== null && <span>· {formatCost(m.cost)}</span>}
                  {(m.webSearches ?? 0) > 0 && <span>· searched {m.webSearches}×</span>}
                </div>
              )}
              {m && <Sources sources={m.sources} />}
              {onContinue && m && (
                <button className="primary" onClick={() => onContinue(m.id)}>Continue with this one</button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
