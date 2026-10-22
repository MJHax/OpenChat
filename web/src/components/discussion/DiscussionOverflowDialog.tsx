import type { ContextOverflow } from '../../../../shared/types';
import { discussionOverflowBody, discussionOverflowTitle } from '../../lib/discussion';

interface DiscussionOverflowDialogProps {
  overflow: ContextOverflow[];
  /** The participant whose turn is next, from the server. */
  speaker: string;
  onStayPaused(): void;
  onEnd(): void;
  onSendAnyway(): void;
}

export function DiscussionOverflowDialog({ overflow, speaker, onStayPaused, onEnd, onSendAnyway }: DiscussionOverflowDialogProps) {
  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onStayPaused(); }}>
      <div className="modal card" role="dialog" aria-modal="true" aria-labelledby="discussion-overflow-title">
        <h3 id="discussion-overflow-title">{discussionOverflowTitle(overflow)}</h3>
        <p className="muted">{discussionOverflowBody(speaker)}</p>
        <div className="row">
          <button onClick={onStayPaused} autoFocus>Stay paused</button>
          <button onClick={onEnd}>End discussion</button>
          <button className="primary" onClick={onSendAnyway}>Send anyway</button>
        </div>
        <p className="muted small">Send anyway lets this turn and later ones go ahead while you watch. Their replies are marked where earlier messages were dropped.</p>
      </div>
    </div>
  );
}
