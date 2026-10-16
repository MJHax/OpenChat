import { useEffect, useRef, useState } from 'react';
import type { Attachment, LibraryModel, PathMessage } from '../../../shared/types';
import { sendBlockReason } from '../lib/attachments';
import { formatCost, formatTokens } from '../lib/format';
import { AttachButton, useFileDrop } from './AttachButton';
import { AttachmentChips } from './AttachmentChips';
import { toDraft, useAttachmentDraft } from './useAttachmentDraft';
import { Markdown } from './Markdown';
import { RememberBox } from './RememberBox';
import { Sources } from './Sources';
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
  /** The model(s) an edit would be sent to, for the image check. */
  replyModels: LibraryModel[];
  onEdit(text: string, attachments: Attachment[]): void;
  /** An edit of this message the server refused before taking it: the edit box reopens with it. */
  restoredEdit?: { text: string; attachments: Attachment[] } | null;
  onCompareVersions(): void;
}

export function MessageItem({
  message, modelName, models, disabled, compareMode, onSelectSibling, onRegenerate, replyModels, onEdit, restoredEdit, onCompareVersions,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const files = useAttachmentDraft();
  useEffect(() => {
    if (!restoredEdit) return;
    setDraft(restoredEdit.text);
    files.restore(restoredEdit.attachments, message.attachments.map((a) => a.id));
    setEditing(true);
  }, [restoredEdit]);
  const drop = useFileDrop(files.add);
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
    // Only images added in this edit are checked; the message's own images are handled with a note if needed.
    const editBlock = sendBlockReason(files.items.filter((i) => !i.sent && i.status !== 'error').map((i) => i.kind), replyModels);
    const canSave = (!!draft.trim() || files.ready.length > 0) && !files.uploading && !editBlock && !disabled;
    return (
      <div className="msg user">
        {editing ? (
          <div className={`edit-box${drop.dragging ? ' dragging' : ''}`} {...drop.handlers}>
            <AttachmentChips items={files.items} onRemove={files.remove} />
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} onPaste={drop.onPaste} rows={Math.min(12, draft.split('\n').length + 1)} autoFocus />
            {editBlock && <div className="composer-hint">{editBlock}</div>}
            <div className="row">
              <AttachButton onFiles={files.add} />
              <span className="spacer" />
              <button onClick={() => { setEditing(false); setDraft(message.content); files.discard(); }}>Cancel</button>
              <button className="primary" disabled={!canSave} onClick={() => { setEditing(false); onEdit(draft.trim(), files.ready); files.clear(); }}>
                Save & send
              </button>
            </div>
          </div>
        ) : (
          <>
            <AttachmentChips items={message.attachments.map(toDraft)} inMessage />
            {message.content && <div className="bubble" ref={bodyRef}>{message.content}</div>}
            <div className="msg-meta">
              {nav}
              <button className="link" disabled={disabled} onClick={() => { setDraft(message.content); files.reset(message.attachments); setEditing(true); }}>Edit</button>
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
      <Sources sources={message.sources} />
      <div className="msg-meta">
        {nav}
        <span className="model-tag">{modelName}</span>
        {tokens > 0 && <span>{formatTokens(tokens)} tok</span>}
        {message.cost !== null && <span>· {formatCost(message.cost)}</span>}
        {(message.webSearches ?? 0) > 0 && <span>· searched {message.webSearches}×</span>}
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
