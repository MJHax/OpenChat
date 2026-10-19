import { useEffect, useState } from 'react';
import { Check, Columns2, MoreHorizontal, SlidersHorizontal } from 'lucide-react';
import type { CompareState } from '../lib/compare';
import { usePopover } from './usePopover';

export interface ChatMenuProps {
  /** This chat's instructions, or the draft ones for a chat not created yet ('' when none). */
  instructions: string;
  onSaveInstructions(text: string): Promise<void>;
  compare: CompareState;
  onCompareChange(next: CompareState): void;
  /** Compare needs at least two models. */
  canCompare: boolean;
}

/** The ⋯ menu in the chat header: per-chat instructions and compare mode. */
export function ChatMenu({ instructions, onSaveInstructions, compare, onCompareChange, canCompare }: ChatMenuProps) {
  const { open, setOpen, root } = usePopover();
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!open) setEditing(false); }, [open]);

  return (
    <div className="chip-pop" ref={root}>
      <button type="button" className="icon-btn menu-btn" aria-label="Chat options" title="Chat options" aria-expanded={open}
        onClick={() => setOpen(!open)}>
        <MoreHorizontal size={16} />
        {instructions && <i className="instructions-dot" aria-label="(instructions set)" />}
      </button>
      {open && (editing ? (
        <div className="popover down right instructions-panel" role="dialog" aria-label="Instructions for this chat">
          <InstructionsEditor value={instructions} onSave={onSaveInstructions} onDone={() => setOpen(false)} />
        </div>
      ) : (
        <div className="popover down right chat-menu" role="group" aria-label="Chat options">
          <button className="pop-item" onClick={() => setEditing(true)}>
            <SlidersHorizontal size={15} /><span>Chat instructions<small>{instructions ? 'Set for this chat' : 'Only for this chat'}</small></span>
          </button>
          <button className="pop-item" aria-pressed={compare.enabled} disabled={!canCompare && !compare.enabled}
            onClick={() => { onCompareChange({ ...compare, enabled: !compare.enabled }); setOpen(false); }}>
            <Columns2 size={15} /><span>Compare models<small>Send each message to several models</small></span>
            {compare.enabled && <Check size={15} className="check" />}
          </button>
        </div>
      ))}
    </div>
  );
}

function InstructionsEditor({ value, onSave, onDone }: { value: string; onSave(text: string): Promise<void>; onDone(): void }) {
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(draft.trim());
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <h4>Instructions for this chat</h4>
      <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={6} autoFocus
        placeholder="e.g. Answer in French. Keep code examples in TypeScript." />
      <p className="muted small">Added after your global custom instructions, which still apply.</p>
      {error && <p className="error-text small">{error}</p>}
      <div className="row">
        <span className="spacer" />
        <button onClick={onDone}>Cancel</button>
        <button className="primary" disabled={saving || draft.trim() === value} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </>
  );
}
