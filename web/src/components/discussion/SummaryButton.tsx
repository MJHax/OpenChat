import { useState } from 'react';
import type { DiscussionSummary, LibraryModel } from '../../../../shared/types';
import { api } from '../../api';
import { cheapestModel } from '../../lib/discussion';
import { usePopover } from '../usePopover';
import { ErrorText } from '../ErrorText';
import { FileText } from 'lucide-react';

/** Summarize: a small picker, defaulting to the cheapest model in the library. */
export function SummaryButton({ discussionId, models, disabled, onSummary }: {
  discussionId: string; models: LibraryModel[]; disabled: boolean; onSummary(s: DiscussionSummary): void;
}) {
  const { open, setOpen, root } = usePopover();
  const [picked, setModelId] = useState(() => cheapestModel(models)?.id ?? '');
  // Picked before the library loaded (or removed since): fall back to the cheapest model.
  const modelId = models.some((m) => m.id === picked) ? picked : cheapestModel(models)?.id ?? '';
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
      <button type="button" className="chip ghost" disabled={disabled} aria-expanded={open} onClick={() => setOpen(!open)}><FileText size={13} />Summarize</button>
      {open && (
        <div className="stats-pop-panel popover down right" role="dialog" aria-label="Summarize">
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
