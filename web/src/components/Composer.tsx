import { useEffect, useRef, useState } from 'react';
import { EFFORTS, type Attachment, type Effort, type LibraryModel } from '../../../shared/types';
import { sendBlockReason, skippedImagesNotice } from '../lib/attachments';
import type { CompareState } from '../lib/compare';
import { ArrowUp, Brain, Columns2, Globe, Square } from 'lucide-react';
import { ModelPicker } from './ModelPicker';
import { SEARCH_TOOLTIP } from '../lib/search';
import { EFFORT_TOOLTIP } from '../lib/effort';
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
  webSearch: boolean;
  onWebSearchChange(on: boolean): void;
  /** Reasoning effort; null leaves it to the model. */
  effort: Effort | null;
  onEffortChange(effort: Effort | null): void;
  /** The model(s) the next send goes to, for the image checks. */
  replyModels: LibraryModel[];
  /** The chat's messages so far, to warn when earlier images will be skipped. */
  path: { attachments: Attachment[] }[];
  /** Resolves false when the send was refused before the server took it; the draft is then put back. */
  onSend(text: string, attachments: Attachment[]): Promise<boolean>;
  onStop(): void;
  /** The one-click compare toggle; only before the first message (later it lives in the ⋯ menu). */
  showCompareToggle: boolean;
  /** Text and files to drop into the box; a new nonce applies it again. */
  prefill?: ComposerPrefill | null;
}

/** What a suggestion card or the Library drops into the composer; text is left alone when undefined. */
export interface ComposerPrefill { text?: string; attachments?: Attachment[]; files?: File[]; nonce: number }

export function Composer({
  disabledReason, streaming, models, modelId, onModelChange, compare, onCompareChange, webSearch, onWebSearchChange, effort, onEffortChange,
  replyModels, path,
  onSend, onStop, showCompareToggle, prefill,
}: Props) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  const draft = useAttachmentDraft();

  useEffect(() => {
    if (!prefill) return;
    if (prefill.attachments?.length) draft.restore(prefill.attachments);
    if (prefill.files?.length) draft.add(prefill.files);
    const text = prefill.text;
    if (text !== undefined) setText(text);
    const el = ref.current;
    if (el) {
      el.focus();
      if (text !== undefined) requestAnimationFrame(() => el.setSelectionRange(text.length, text.length));
    }
  }, [prefill?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps
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

  const submit = async () => {
    if (!canSend || streaming) return;
    const sentText = text.trim();
    const sent = draft.ready;
    setText('');
    draft.clear();
    if (await onSend(sentText, sent)) return;
    setText((current) => (current.trim() ? current : sentText));
    draft.restore(sent);
  };

  return (
    <div className="composer">
      <div className={`composer-box${drop.dragging ? ' dragging' : ''}`} {...drop.handlers}>
        <AttachmentChips items={draft.items} onRemove={draft.remove} />
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={compare.enabled ? 'Message several models…' : `Message ${models.find((m) => m.id === modelId)?.displayName ?? ''}…`.replace(' …', '…')}
          onChange={(e) => setText(e.target.value)}
          onPaste={drop.onPaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <div className="composer-bar">
          <div className="composer-models">
            <AttachButton onFiles={draft.add} onAttachments={draft.restore} />
            <button className="icon-btn" aria-pressed={webSearch} aria-label="Web search" title={`Web search: ${webSearch ? 'on' : 'off'}. ${SEARCH_TOOLTIP}`}
              onClick={() => onWebSearchChange(!webSearch)}>
              <Globe size={15} />
            </button>
            {showCompareToggle && (
              <button className="icon-btn" aria-pressed={compare.enabled} aria-label="Compare models" disabled={models.length < 2 && !compare.enabled}
                title="Compare: send each message to several models and pick a reply" onClick={() => onCompareChange({ ...compare, enabled: !compare.enabled })}>
                <Columns2 size={15} />
              </button>
            )}
            <ModelPicker models={models} modelId={modelId} onModelChange={onModelChange} compare={compare} onCompareChange={onCompareChange} />
            {replyModels.some((m) => m.supportsReasoning) && (
              <label className={`chip ghost effort-chip${effort ? ' on' : ''}`} title={EFFORT_TOOLTIP}>
                <Brain size={13} />
                <select value={effort ?? ''} aria-label="Reasoning effort" onChange={(e) => onEffortChange((e.target.value || null) as Effort | null)}>
                  <option value="">Default</option>
                  {EFFORTS.map((x) => <option key={x} value={x}>{`${x[0].toUpperCase()}${x.slice(1)}`}</option>)}
                </select>
              </label>
            )}
          </div>
          {streaming ? (
            <button className="send fill" onClick={onStop} aria-label="Stop" title="Stop"><Square size={13} fill="currentColor" /></button>
          ) : (
            <button className="send fill" onClick={() => { void submit(); }} disabled={!canSend} aria-label="Send" title="Send"><ArrowUp size={16} /></button>
          )}
        </div>
        {disabledReason && !streaming && <div className="composer-hint">{disabledReason}</div>}
        {!disabledReason && notice && <div className="composer-hint">{notice}</div>}
      </div>
    </div>
  );
}
