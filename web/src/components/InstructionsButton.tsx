import { useEffect, useState } from 'react';
import { usePopover } from './usePopover';

export interface InstructionsButtonProps {
  /** This chat's saved instructions ('' when none). */
  value: string;
  onSave(text: string): Promise<void>;
}

/** The chat header's per-chat instructions editor. */
export function InstructionsButton({ value, onSave }: InstructionsButtonProps) {
  const { open, setOpen, root } = usePopover();
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setDraft(value);
      setError(null);
    }
  }, [open, value]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(draft.trim());
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="stats-pop" ref={root}>
      <button type="button" className="link stats-pop-button" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}
        title={value ? 'This chat has its own instructions' : undefined}>
        Instructions{value && <i className="instructions-dot" aria-label="(set)" />} ▾
      </button>
      {open && (
        <div className="stats-pop-panel instructions-panel" role="dialog" aria-label="Instructions for this chat">
          <h4>Instructions for this chat</h4>
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={6} autoFocus
            placeholder="e.g. Answer in French. Keep code examples in TypeScript." />
          <p className="muted small">Added after your global custom instructions, which still apply.</p>
          {error && <p className="error-text small">{error}</p>}
          <div className="row">
            <span className="spacer" />
            <button onClick={() => setOpen(false)}>Cancel</button>
            <button className="primary" disabled={saving || draft.trim() === value} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      )}
    </div>
  );
}
