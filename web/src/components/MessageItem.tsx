import { useEffect, useRef, useState } from 'react';
import type { Attachment, LibraryModel, PathMessage } from '../../../shared/types';
import { sendBlockReason } from '../lib/attachments';
import { formatCost, formatTokens } from '../lib/format';
import { timingParts } from '../lib/timing';
import { AttachButton, useFileDrop } from './AttachButton';
import { AttachmentChips } from './AttachmentChips';
import { toDraft, useAttachmentDraft } from './useAttachmentDraft';
import { MessageBody } from './MessageBody';
import { copyText } from '../../../shared/files';
import { RememberBox } from './RememberBox';
import { Sources } from './Sources';
import { SiblingNav } from './SiblingNav';
import { Bookmark, BookmarkCheck, Check, Columns2, Copy, GitBranch, Pencil, RotateCw } from 'lucide-react';

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
  /** Opens a new chat holding the conversation up to this reply. */
  onFork(): void;
}

export function MessageItem({
  message, modelName, models, disabled, compareMode, onSelectSibling, onRegenerate, replyModels, onEdit, restoredEdit, onCompareVersions, onFork,
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
    <button className="act" onMouseDown={captureSelection} onClick={() => setRemembering(selectionRef.current || message.content)}
      aria-label={rememberedNote ? 'Saved to memory' : 'Remember'} title={rememberedNote ? 'Saved to memory' : 'Remember (a selection, or the whole message)'}>
      {rememberedNote ? <BookmarkCheck size={14} /> : <Bookmark size={14} />}
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
    await navigator.clipboard.writeText(message.role === 'assistant' ? copyText(message.content) : message.content);
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
              <AttachButton onFiles={files.add} onAttachments={files.restore} />
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
              <span className="actions">
                <button className="act" disabled={disabled} aria-label="Edit" title="Edit"
                  onClick={() => { setDraft(message.content); files.reset(message.attachments); setEditing(true); }}><Pencil size={14} /></button>
                <button className="act" onClick={copy} aria-label={copied ? 'Copied' : 'Copy'} title={copied ? 'Copied' : 'Copy'}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>
                {rememberButton}
              </span>
            </div>
            {rememberBox}
          </>
        )}
      </div>
    );
  }

  // A reply with no message before it is a continued chat's seed: the previous chat's files, written by no model here.
  if (message.parentId === null) {
    return (
      <div className="msg assistant seed">
        <div className="msg-body"><MessageBody text={message.content} messageId={message.id} streaming={false} /></div>
      </div>
    );
  }

  const tokens = (message.promptTokens ?? 0) + (message.completionTokens ?? 0);
  const regenerateChoices = [...models].sort((a, b) => Number(b.id === message.modelId) - Number(a.id === message.modelId));

  return (
    <div className="msg assistant">
      <ModelMark name={modelName} />
      <div className="msg-col">
        <div className="msg-head">
          <span className="model-tag">{modelName}</span>
          {tokens > 0 && <span>· {formatTokens(tokens)} tok</span>}
          {timingParts(message.timing).map((part) => <span key={part}>· {part}</span>)}
          {message.cost !== null && <span>· {formatCost(message.cost)}</span>}
          {message.effort && <span>· {message.effort} effort</span>}
          {(message.webSearches ?? 0) > 0 && <span>· searched {message.webSearches}×</span>}
        </div>
        <div className="msg-body" ref={bodyRef}><MessageBody text={message.content} messageId={message.id} streaming={false} /></div>
        {message.status === 'stopped' && <div className="muted small">Response stopped</div>}
        {message.contextDropped && <div className="muted small">Earlier messages were dropped because the chat is longer than this model's memory.</div>}
        <Sources sources={message.sources} />
        <div className="msg-meta">
          {nav}
          <span className="actions">
            <button className="act" onClick={copy} aria-label={copied ? 'Copied' : 'Copy'} title={copied ? 'Copied' : 'Copy'}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>
            {compareMode ? (
              <button className="act wide" disabled={disabled} onClick={() => onRegenerate(null)} title="Compare again"><RotateCw size={14} /> Compare again</button>
            ) : (
              <label className="act regen-act" title="Regenerate">
                <RotateCw size={14} />
                <select
                  className="regen"
                  value=""
                  disabled={disabled || models.length === 0}
                  onChange={(e) => e.target.value && onRegenerate(e.target.value)}
                  aria-label="Regenerate with model"
                >
                  <option value="">Regenerate</option>
                  {regenerateChoices.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
                </select>
              </label>
            )}
            <button className="act" disabled={disabled} onClick={onFork} aria-label="Fork" title="Fork into a new chat from here"><GitBranch size={14} /></button>
            {rememberButton}
            {message.siblingIds.length > 1 && (
              <button className="act" disabled={disabled} onClick={onCompareVersions} aria-label="Compare versions" title="Compare versions"><Columns2 size={14} /></button>
            )}
          </span>
        </div>
        {rememberBox}
      </div>
    </div>
  );
}

/** The small accent tile beside a reply, with the model's first letter. */
export function ModelMark({ name }: { name: string }) {
  const letter = (name.split(':').pop() ?? name).trim().charAt(0).toUpperCase() || '·';
  return <span className="model-mark fill" aria-hidden>{letter}</span>;
}
