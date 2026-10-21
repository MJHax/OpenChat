import type { ContextOverflow } from '../../../shared/types';
import { overflowTitle } from '../lib/overflow';

interface ContextOverflowDialogProps {
  overflow: ContextOverflow[];
  /** Summarize and continue; when `retry` is set the summary itself overflowed, so this reads "Summarize anyway". */
  onSummarize(): void;
  /** Absent once the summary itself has overflowed. */
  onSendAnyway?(): void;
  onCancel(): void;
  retry?: boolean;
  busy?: boolean;
}

export function ContextOverflowDialog({ overflow, onSummarize, onSendAnyway, onCancel, retry = false, busy = false }: ContextOverflowDialogProps) {
  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}>
      <div className="modal card" role="dialog" aria-modal="true" aria-labelledby="overflow-title">
        <h3 id="overflow-title">{overflowTitle(overflow)}</h3>
        <div className="row">
          <button onClick={onCancel} disabled={busy}>Cancel</button>
          {onSendAnyway && <button onClick={onSendAnyway} disabled={busy}>Send anyway</button>}
          <button className="primary" onClick={onSummarize} disabled={busy} autoFocus>
            {retry ? 'Summarize anyway' : 'Summarize and continue'}
          </button>
        </div>
      </div>
    </div>
  );
}
