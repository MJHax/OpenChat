import { useEffect, useState } from 'react';
import { api } from '../api';
import { ErrorText } from './ErrorText';

/** Asks the memory model to condense `text` into a fact, lets the user edit it, and saves it to Memory. */
export function RememberBox({ text, onClose }: { text: string; onClose(saved: boolean): void }) {
  const [draft, setDraft] = useState('');
  const [state, setState] = useState<'suggesting' | 'ready' | 'saving'>('suggesting');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.suggestMemory(text)
      .then((suggestion) => alive && setDraft(suggestion))
      .catch((e: Error) => alive && setError(e.message))
      .finally(() => alive && setState('ready'));
    return () => {
      alive = false;
    };
  }, [text]);

  async function save() {
    setState('saving');
    try {
      await api.addMemory(draft.trim());
      onClose(true);
    } catch (e) {
      setError((e as Error).message);
      setState('ready');
    }
  }

  return (
    <div className="remember-box">
      {state === 'suggesting' ? (
        <span className="muted small">Suggesting a memory…</span>
      ) : (
        <>
          {error && <span className="error-text small"><ErrorText message={error} /></span>}
          <input type="text" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Type the fact to remember" autoFocus />
          <div className="row">
            <button onClick={() => onClose(false)}>Cancel</button>
            <button className="primary" disabled={!draft.trim() || state === 'saving'} onClick={save}>Save to memory</button>
          </div>
        </>
      )}
    </div>
  );
}
