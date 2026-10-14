import { useEffect, useRef, useState } from 'react';
import type { LibraryModel } from '../../../shared/types';
import { MAX_COMPARE, toggleModel, type CompareState } from '../lib/compare';

interface Props {
  /** Why sending is blocked right now, or null if it isn't. */
  disabledReason: string | null;
  streaming: boolean;
  models: LibraryModel[];
  modelId: string;
  onModelChange(id: string): void;
  compare: CompareState;
  onCompareChange(next: CompareState): void;
  onSend(text: string): void;
  onStop(): void;
}

export function Composer({ disabledReason, streaming, models, modelId, onModelChange, compare, onCompareChange, onSend, onStop }: Props) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || disabledReason || streaming) return;
    onSend(trimmed);
    setText('');
  };

  return (
    <div className="composer">
      <div className="composer-box">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder="Message…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="composer-bar">
          <div className="composer-models">
            <button
              className="toggle"
              aria-pressed={compare.enabled}
              disabled={models.length < 2}
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
            <button className="primary" onClick={submit} disabled={!!disabledReason || !text.trim()}>Send</button>
          )}
        </div>
        {disabledReason && !streaming && <div className="composer-hint">{disabledReason}</div>}
      </div>
    </div>
  );
}
