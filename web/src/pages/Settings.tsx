import { useEffect, useState } from 'react';
import type { LibraryModel, Memory, SettingsUpdate, SettingsView, Theme } from '../../../shared/types';
import { api } from '../api';
import { SEARCH_NOTE } from '../lib/search';

export interface SettingsProps {
  models: LibraryModel[];
  onChanged(): void;
}

export function Settings({ models, onChanged }: SettingsProps) {
  const [view, setView] = useState<SettingsView | null>(null);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [keyDraft, setKeyDraft] = useState('');
  const [keyStatus, setKeyStatus] = useState<string | null>(null);
  const [aboutMe, setAboutMe] = useState('');
  const [instructions, setInstructions] = useState('');
  const [savedNote, setSavedNote] = useState('');
  const [newMemory, setNewMemory] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getSettings()
      .then((v) => { setView(v); setAboutMe(v.aboutMe); setInstructions(v.customInstructions); })
      .catch((e: Error) => setError(e.message));
    api.listMemories().then(setMemories).catch((e: Error) => setError(e.message));
  }, []);

  async function update(patch: SettingsUpdate) {
    setError(null);
    try {
      setView(await api.updateSettings(patch));
      onChanged();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }

  async function memoryAction(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      setMemories(await api.listMemories());
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function saveKey() {
    if (!keyDraft.trim()) return;
    if (await update({ apiKey: keyDraft })) {
      setKeyDraft('');
      setKeyStatus('Saved.');
    }
  }

  async function testKey() {
    setKeyStatus('Testing…');
    const result = await api.testKey().catch((e: Error) => ({ ok: false, error: e.message }));
    setKeyStatus(result.ok ? 'Connection works.' : `Failed: ${result.error}`);
  }

  async function savePersonalization() {
    if (await update({ aboutMe, customInstructions: instructions })) {
      setSavedNote('Saved.');
      setTimeout(() => setSavedNote(''), 2000);
    }
  }

  if (!view) return <div className="page"><div className="page-inner">{error ? <p className="error-text">{error}</p> : 'Loading…'}</div></div>;

  return (
    <div className="page">
      <div className="page-inner">
        <h1>Settings</h1>
        {error && <p className="error-text">{error}</p>}

        <h2>OpenRouter API key</h2>
        <div className="card">
          <div className="muted small">
            {view.hasApiKey
              ? `Using key ${view.apiKeyMasked} from ${view.apiKeySource === 'env' ? 'the .env file' : 'Settings'}.`
              : 'No key set yet.'}
          </div>
          <div className="row" style={{ justifyContent: 'flex-start' }}>
            <input
              type="password"
              placeholder="sk-or-…"
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              style={{ flex: 1 }}
              autoComplete="off"
              aria-label="OpenRouter API key"
            />
            <button className="primary" onClick={saveKey} disabled={!keyDraft.trim()}>Save key</button>
            <button onClick={testKey} disabled={!view.hasApiKey}>Test connection</button>
          </div>
          {view.apiKeySource === 'settings' && (
            <div>
              <button className="link danger" onClick={() => update({ apiKey: '' })}>Remove saved key</button>
            </div>
          )}
          {keyStatus && <div className="small">{keyStatus}</div>}
        </div>

        <h2>Personalization</h2>
        <div className="card">
          <label className="field">
            About me
            <textarea rows={4} value={aboutMe} onChange={(e) => setAboutMe(e.target.value)} placeholder="What should models know about you?" />
          </label>
          <label className="field">
            Custom instructions
            <textarea rows={4} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="How should models respond?" />
          </label>
          <div className="row">
            {savedNote && <span className="muted small">{savedNote}</span>}
            <button className="primary" onClick={savePersonalization}>Save</button>
          </div>
        </div>

        <h2>Memory</h2>
        <div className="card">
          <div className="muted small">Enabled memories are added to every chat. Untick a memory to pause it.</div>
          {memories.map((m) => (
            <div key={m.id} className="memory-row">
              <input
                type="checkbox"
                checked={m.enabled}
                onChange={(e) => memoryAction(() => api.updateMemory(m.id, { enabled: e.target.checked }))}
                aria-label="Enabled"
              />
              <input
                type="text"
                defaultValue={m.content}
                onBlur={(e) => {
                  const content = e.target.value.trim();
                  if (content && content !== m.content) memoryAction(() => api.updateMemory(m.id, { content }));
                }}
              />
              <button className="link danger" onClick={() => memoryAction(() => api.deleteMemory(m.id))}>Delete</button>
            </div>
          ))}
          <form
            className="memory-row"
            onSubmit={(e) => {
              e.preventDefault();
              const content = newMemory.trim();
              if (!content) return;
              memoryAction(() => api.addMemory(content)).then(() => setNewMemory(''));
            }}
          >
            <input type="text" placeholder="Add a memory, e.g. “I prefer metric units”" value={newMemory} onChange={(e) => setNewMemory(e.target.value)} />
            <button type="submit" disabled={!newMemory.trim()}>Add</button>
          </form>
        </div>

        <h2>Other</h2>
        <div className="card">
          <p className="muted small">
            <strong>Web search</strong> — {SEARCH_NOTE}
          </p>
          <label className="field">
            Model for chat titles
            <select value={view.titleModelId} onChange={(e) => update({ titleModelId: e.target.value })}>
              <option value="">Same model as the chat</option>
              {models.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
            </select>
          </label>
          <label className="field">
            Model for memories
            <select value={view.memoryModelId} onChange={(e) => update({ memoryModelId: e.target.value })}>
              <option value="">Same as default model</option>
              {models.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
            </select>
          </label>
          <label className="field">
            Theme
            <select value={view.theme} onChange={(e) => update({ theme: e.target.value as Theme })}>
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
        </div>
      </div>
    </div>
  );
}
