export interface ContextNoteProps {
  /** The text shown or being edited. */
  draft: string;
  from: { id: string; title: string | null } | null;
  /** True until the chat's first message is sent. */
  editable: boolean;
  onChange(text: string): void;
}

/** A continued chat's summary of the chat it came from, sent to the model ahead of the messages. */
export function ContextNote({ draft, from, editable, onChange }: ContextNoteProps) {
  return (
    <section className="context-note-card" aria-label="Context from the previous chat">
      <div className="context-note-head">
        <span>Context from the previous chat</span>
        {from && (from.title !== null
          ? <a href={`#/chat/${encodeURIComponent(from.id)}`}>{from.title}</a>
          : <span className="muted">(deleted)</span>)}
      </div>
      {editable ? (
        <>
          <textarea value={draft} onChange={(e) => onChange(e.target.value)} rows={Math.min(14, Math.max(4, draft.split('\n').length + 2))}
            aria-label="Summary note" />
          <p className="muted small">Edit it before your first message if anything is off. It is sent with every message in this chat.</p>
        </>
      ) : (
        <div className="context-note-body">{draft}</div>
      )}
    </section>
  );
}
