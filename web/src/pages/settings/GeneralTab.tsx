import { useEffect, useState } from 'react';
import type { LibraryModel, SettingsUpdate, SettingsView } from '../../../../shared/types';
import { api } from '../../api';
import { SEARCH_NOTE } from '../../lib/search';
import { LocalServersCard } from './LocalServersCard';
import { WebSearchCard } from './WebSearchCard';

export interface GeneralTabProps {
  view: SettingsView;
  models: LibraryModel[];
  section: string | null;
  update(patch: SettingsUpdate): Promise<boolean>;
}

export function GeneralTab({ view, models, section, update }: GeneralTabProps) {
  const [keyDraft, setKeyDraft] = useState('');
  const [keyStatus, setKeyStatus] = useState<string | null>(null);
  const [aboutMe, setAboutMe] = useState(view.aboutMe);
  const [instructions, setInstructions] = useState(view.customInstructions);
  const [savedNote, setSavedNote] = useState('');

  useEffect(() => {
    if (section) document.getElementById(section)?.scrollIntoView({ block: 'start' });
  }, [section]);

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

  return (
    <>
      <h2>Models</h2>
      <div className="card">
        <strong>OpenRouter</strong>
        <div className="muted small">Optional. Needed for OpenRouter models, images and video.</div>
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

      <LocalServersCard />

      <WebSearchCard view={view} update={update} />

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
          <span className="muted small" style={{ fontWeight: 400 }}>Chats that only used local models are titled by their own model, so they never leave your machine.</span>
        </label>
        <label className="field">
          Model for memories
          <select value={view.memoryModelId} onChange={(e) => update({ memoryModelId: e.target.value })}>
            <option value="">Same as default model</option>
            {models.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
          </select>
        </label>
      </div>
    </>
  );
}
