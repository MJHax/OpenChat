import { useRef, useState } from 'react';
import type { LibraryModel, PathMessage } from '../../../shared/types';
import { formatCost, formatTokens } from '../lib/format';
import { Markdown } from './Markdown';
import { RememberBox } from './RememberBox';
import { SiblingNav } from './SiblingNav';

interface Props {
  message: PathMessage;
  modelName: string;
  models: LibraryModel[];
  disabled: boolean;
  /** When on, Regenerate re-runs the comparison instead of offering a model list. */
  compareMode: boolean;
  onSelectSibling(id: string): void;
  /** null = regenerate with the compare models. */
  onRegenerate(modelId: string | null): void;
  onEdit(text: string): void;
  onCompareVersions(): void;
}

export function MessageItem({ message, modelName, models, disabled, compareMode, onSelectSibling, onRegenerate, onEdit, onCompareVersions }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [copied, setCopied] = useState(false);
  const [remembering, setRemembering] = useState<string | null>(null);
  const [rememberedNote, setRememberedNote] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const selectionRef = useRef('');

  // Captured on mousedown, before the click can move focus: text highlighted inside this message, if any.
  const captureSelection = () => {
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? '';
    selectionRef.current = text && sel?.anchorNode && bodyRef.current?.contains(sel.anchorNode) ? text : '';
  };
  const rememberButton = (
    <button className="link" onMouseDown={captureSelection} onClick={() => setRemembering(selectionRef.current || message.content)}>
      {rememberedNote ? 'Saved to memory' : 'Remember'}
    </button>
  );
  const rememberBox = remembering !== null && (
    <RememberBox
      text={remembering}
      onClose={(saved) => {
        setRemembering(null);
        if (saved) {
          setRememberedNote(true);
          setTimeout(() => setRememberedNote(false), 2000);
        }
      }}
    />
  );

  const copy = async () => {
    await navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const nav = message.siblingIds.length > 1 && (
    <SiblingNav ids={message.siblingIds} index={message.siblingIndex} disabled={disabled} onSelect={onSelectSibling} />
  );

  if (message.role === 'user') {
    return (
      <div className="msg user">
        {editing ? (
          <div className="edit-box">
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={Math.min(12, draft.split('\n').length + 1)} autoFocus />
            <div className="row">
              <button onClick={() => { setEditing(false); setDraft(message.content); }}>Cancel</button>
              <button className="primary" disabled={!draft.trim() || disabled} onClick={() => { setEditing(false); onEdit(draft.trim()); }}>
                Save & send
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="bubble" ref={bodyRef}>{message.content}</div>
            <div className="msg-meta">
              {nav}
              <button className="link" disabled={disabled} onClick={() => { setDraft(message.content); setEditing(true); }}>Edit</button>
              <button className="link" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
              {rememberButton}
            </div>
            {rememberBox}
          </>
        )}
      </div>
    );
  }

  const tokens = (message.promptTokens ?? 0) + (message.completionTokens ?? 0);
  const regenerateChoices = [...models].sort((a, b) => Number(b.id === message.modelId) - Number(a.id === message.modelId));

  return (
    <div className="msg assistant">
      <div className="msg-body" ref={bodyRef}><Markdown text={message.content} /></div>
      {message.status === 'stopped' && <div className="muted small">Response stopped</div>}
      <div className="msg-meta">
        {nav}
        <span className="model-tag">{modelName}</span>
        {tokens > 0 && <span>{formatTokens(tokens)} tok</span>}
        {message.cost !== null && <span>· {formatCost(message.cost)}</span>}
        <button className="link" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
        {rememberButton}
        {compareMode ? (
          <button className="link" disabled={disabled} onClick={() => onRegenerate(null)}>↻ Compare again</button>
        ) : (
          <select
            className="regen"
            value=""
            disabled={disabled || models.length === 0}
            onChange={(e) => e.target.value && onRegenerate(e.target.value)}
            aria-label="Regenerate with model"
          >
            <option value="">↻ Regenerate</option>
            {regenerateChoices.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
          </select>
        )}
        {message.siblingIds.length > 1 && (
          <button className="link" disabled={disabled} onClick={onCompareVersions}>Compare versions</button>
        )}
      </div>
      {rememberBox}
    </div>
  );
}
