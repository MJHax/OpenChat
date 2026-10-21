import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { EFFORTS, type Attachment, type Effort, type LibraryModel, type SearchServiceId } from '../../../shared/types';
import { sendBlockReason, skippedImagesNotice } from '../lib/attachments';
import type { CompareState } from '../lib/compare';
import { ArrowUp, Bookmark, Brain, Check, ChevronDown, Columns2, Globe, Square } from 'lucide-react';
import { insertOnOwnLine } from '../lib/prompts';
import { ModelPicker } from './ModelPicker';
import { ChipPopover } from './ChipPopover';
import { searchTooltip } from '../lib/search';
import { searchAllowed } from '../lib/localModels';
import { THINKING_TOOLTIP } from '../lib/thinking';
import { EFFORT_HINTS, EFFORT_TOOLTIP, effortLabel } from '../lib/effort';
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
  searchService: SearchServiceId;
  searchReady: boolean;
  onWebSearchChange(on: boolean): void;
  /** Reasoning effort; null leaves it to the model. */
  effort: Effort | null;
  onEffortChange(effort: Effort | null): void;
  /** Whether local reasoning models think before answering. */
  thinking: boolean;
  onThinkingChange(on: boolean): void;
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
  /** A saved prompt to add at the caret on its own line; a new nonce adds it again. */
  insert?: { text: string; nonce: number } | null;
  /** Called once `insert` is in the box, so a remounted composer doesn't add it again. */
  onInsertUsed?(): void;
  /** Opens the Saved prompts window; the button is hidden without it. */
  onOpenPrompts?(): void;
}

/** What a suggestion card or the Library drops into the composer; text is left alone when undefined. */
export interface ComposerPrefill { text?: string; attachments?: Attachment[]; files?: File[]; /** Empty the message box and its attachments. */ clear?: boolean; nonce: number }

export function Composer({
  disabledReason, streaming, models, modelId, onModelChange, compare, onCompareChange, webSearch, searchService, searchReady, onWebSearchChange, effort, onEffortChange, thinking, onThinkingChange,
  replyModels, path,
  onSend, onStop, showCompareToggle, prefill, insert, onInsertUsed, onOpenPrompts,
}: Props) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  /** Where the caret was when the box last had focus; null until it has had it. */
  const caretRef = useRef<number | null>(null);
  const rememberCaret = () => { if (ref.current) caretRef.current = ref.current.selectionEnd; };

  const draft = useAttachmentDraft();
  /** Local models search through a search service, so the toggle is off for them until one is set up. */
  const searchBlocked = !searchAllowed(replyModels, replyModels.map((m) => m.id), searchReady);
  const allLocal = replyModels.length > 0 && replyModels.every((m) => m.source === 'local');
  const localThinking = replyModels.some((m) => m.source === 'local' && m.supportsReasoning);

  useEffect(() => {
    if (!prefill) return;
    if (prefill.clear) draft.clear();
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

  useEffect(() => {
    if (!insert) return;
    const next = insertOnOwnLine(text, caretRef.current ?? text.length, insert.text);
    setText(next.value);
    caretRef.current = next.caret;
    placeCaret.current = next.caret;
    onInsertUsed?.();
    ref.current?.focus();
  }, [insert?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps
  // Once the inserted text is rendered (rendering it moves the caret to the end), put the caret right after the prompt.
  const placeCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (placeCaret.current === null) return;
    ref.current?.setSelectionRange(placeCaret.current, placeCaret.current);
    placeCaret.current = null;
  }, [text]);
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
          onSelect={rememberCaret}
          onBlur={rememberCaret}
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
            <button className="icon-btn" aria-pressed={webSearch && !searchBlocked} aria-label="Web search" disabled={searchBlocked}
              title={searchTooltip({ on: webSearch, allLocal, service: searchService, ready: searchReady })}
              onClick={() => onWebSearchChange(!webSearch)}>
              <Globe size={15} />
            </button>
            {onOpenPrompts && (
              <button className="icon-btn" aria-label="Saved prompts" title="Saved prompts" onClick={onOpenPrompts}>
                <Bookmark size={15} />
              </button>
            )}
            {showCompareToggle && (
              <button className="icon-btn" aria-pressed={compare.enabled} aria-label="Compare models" disabled={models.length < 2 && !compare.enabled}
                title="Compare: send each message to several models and pick a reply" onClick={() => onCompareChange({ ...compare, enabled: !compare.enabled })}>
                <Columns2 size={15} />
              </button>
            )}
            <ModelPicker models={models} modelId={modelId} onModelChange={onModelChange} compare={compare} onCompareChange={onCompareChange} />
            {localThinking && (
              <button className={`chip ghost thinking-chip${thinking ? ' on' : ''}`} aria-pressed={thinking} title={THINKING_TOOLTIP}
                onClick={() => onThinkingChange(!thinking)}>
                <Brain size={13} />Thinking: {thinking ? 'On' : 'Off'}
              </button>
            )}
            {!localThinking && replyModels.some((m) => m.supportsReasoning) && (
              <ChipPopover title={EFFORT_TOOLTIP} className={`ghost effort-chip${effort ? ' on' : ''}`} panelClassName="effort-panel"
                icon={<Brain size={13} />} label={<>{effortLabel(effort)}<ChevronDown size={12} /></>}>
                {(close) => (
                  <>
                    <div className="pop-label">Reasoning effort</div>
                    {[null, ...EFFORTS].map((x) => (
                      <button key={x ?? 'default'} className={`pop-item${x === effort ? ' sel' : ''}`} aria-current={x === effort ? 'true' : undefined}
                        onClick={() => { onEffortChange(x); close(); }}>
                        <span>{effortLabel(x)}<small>{EFFORT_HINTS[x ?? 'default']}</small></span>
                        {x === effort && <Check size={15} className="check" />}
                      </button>
                    ))}
                  </>
                )}
              </ChipPopover>
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
