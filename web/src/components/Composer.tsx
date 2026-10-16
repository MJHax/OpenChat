import { useEffect, useRef, useState } from 'react';
import type { Attachment, LibraryModel } from '../../../shared/types';
import { sendBlockReason, skippedImagesNotice } from '../lib/attachments';
import { MAX_COMPARE, toggleModel, type CompareState } from '../lib/compare';
import { AttachmentChips } from './AttachmentChips';
import { AttachButton, useFileDrop } from './AttachButton';
import { useAttachmentDraft } from './useAttachmentDraft';

interface Props {
  /** Why sending is blocked right now, or null if it isn't. */
  disabledReason: string | null;
  streaming: boolean;
  models: LibraryModel[];
  modelId: string;
  onModelChange(id: string): void;
  compare: CompareState;
  onCompareChange(next: CompareState): void;
  /** The model(s) the next send goes to, for the image checks. */
  replyModels: LibraryModel[];
  /** The chat's messages so far, to warn when earlier images will be skipped. */
  path: { attachments: Attachment[] }[];
  onSend(text: string, attachments: Attachment[]): void;
  onStop(): void;
}

export function Composer({
  disabledReason, streaming, models, modelId, onModelChange, compare, onCompareChange, replyModels, path, onSend, onStop,
}: Props) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const draft = useAttachmentDraft();
  const drop = useFileDrop(draft.add);
  const blockReason = sendBlockReason(draft.kinds, replyModels);
  const notice = blockReason ?? skippedImagesNotice(path, replyModels);
  const canSend = (!!text.trim() || draft.ready.length > 0) && !draft.uploading && !blockReason && !disabledReason;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  const submit = () => {
    if (!canSend || streaming) return;
    onSend(text.trim(), draft.ready);
    setText('');
    draft.clear();
  };

  return (
    <div className="composer">
      <div className={`composer-box${drop.dragging ? ' dragging' : ''}`} {...drop.handlers}>
        <AttachmentChips items={draft.items} onRemove={draft.remove} />
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder="Message…"
          onChange={(e) => setText(e.target.value)}
          onPaste={drop.onPaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="composer-bar">
          <div className="composer-models">
            <AttachButton onFiles={draft.add} />
            <button
              className="toggle"
              aria-pressed={compare.enabled}
              disabled={models.length < 2 && !compare.enabled}
              title="Send each message to several models and pick a reply"
              onClick={() => onCompareChange({ ...compare, enabled: !compare.enabled })}
            >
              Compare
            </button>
            {compare.enabled ? (
              <div className="compare-picker">
                {models.map((m) => {
                  const on = compare.modelIds.includes(m.id);
                  return (
                    <label key={m.id} className={`chip${on ? ' on' : ''}`}>
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={!on && compare.modelIds.length >= MAX_COMPARE}
                        onChange={() => onCompareChange(toggleModel(compare, m.id))}
                      />
                      {m.displayName}
                    </label>
                  );
                })}
              </div>
            ) : (
              <select value={modelId} onChange={(e) => onModelChange(e.target.value)} disabled={models.length === 0} aria-label="Model">
                {models.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
              </select>
            )}
          </div>
          {streaming ? (
            <button className="primary" onClick={onStop}>Stop</button>
          ) : (
            <button className="primary" onClick={submit} disabled={!canSend}>Send</button>
          )}
        </div>
        {disabledReason && !streaming && <div className="composer-hint">{disabledReason}</div>}
        {!disabledReason && notice && <div className="composer-hint">{notice}</div>}
      </div>
    </div>
  );
}
