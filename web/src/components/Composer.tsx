import { useEffect, useRef, useState } from 'react';
import type { LibraryModel } from '../../../shared/types';

interface Props {
  disabled: boolean;
  streaming: boolean;
  models: LibraryModel[];
  modelId: string;
  onModelChange(id: string): void;
  onSend(text: string): void;
  onStop(): void;
}

export function Composer({ disabled, streaming, models, modelId, onModelChange, onSend, onStop }: Props) {
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
    if (!trimmed || disabled || streaming || !modelId) return;
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
          <select value={modelId} onChange={(e) => onModelChange(e.target.value)} disabled={models.length === 0} aria-label="Model">
            {models.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
          </select>
          {streaming ? (
            <button className="primary" onClick={onStop}>Stop</button>
          ) : (
            <button className="primary" onClick={submit} disabled={disabled || !text.trim()}>Send</button>
          )}
        </div>
      </div>
    </div>
  );
}
