import { useState } from 'react';
import type { DiscussionSummary, LibraryModel } from '../../../../shared/types';
import { api } from '../../api';
import { cheapestModel } from '../../lib/discussion';
import { usePopover } from '../usePopover';
import { ErrorText } from '../ErrorText';

/** Summarize: a small picker, defaulting to the cheapest model in the library. */
export function SummaryButton({ discussionId, models, disabled, onSummary }: {
  discussionId: string; models: LibraryModel[]; disabled: boolean; onSummary(s: DiscussionSummary): void;
}) {
  const { open, setOpen, root } = usePopover();
  const [modelId, setModelId] = useState(() => cheapestModel(models)?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      onSummary(await api.summarizeDiscussion(discussionId, modelId));
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stats-pop" ref={root}>
      <button type="button" className="link" disabled={disabled} aria-expanded={open} onClick={() => setOpen(!open)}>Summarize</button>
      {open && (
        <div className="stats-pop-panel" role="dialog" aria-label="Summarize">
          <h4>Summarize this discussion</h4>
          <div className="summary-pick">
            <select aria-label="Model" value={modelId} onChange={(e) => setModelId(e.target.value)}>
              {models.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
            </select>
            <button className="primary" disabled={busy || !modelId} onClick={() => void run()}>{busy ? 'Writing…' : 'Summarize'}</button>
          </div>
          {error && <p className="error-text small"><ErrorText message={error} /></p>}
        </div>
      )}
    </div>
  );
}
