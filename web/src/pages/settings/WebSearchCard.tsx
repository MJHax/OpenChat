import { useEffect, useState } from 'react';
import { SEARCH_SERVICES, type SearchServiceId, type SettingsUpdate, type SettingsView } from '../../../../shared/types';
import { api } from '../../api';

const LABELS: Record<SearchServiceId, string> = { none: 'None', searxng: 'SearXNG', tavily: 'Tavily' };

export interface WebSearchCardProps {
  view: SettingsView;
  update(patch: SettingsUpdate): Promise<boolean>;
}

export function WebSearchCard({ view, update }: WebSearchCardProps) {
  const [address, setAddress] = useState(view.searxngUrl);
  const [keyDraft, setKeyDraft] = useState('');
  const [status, setStatus] = useState<string | null>(null);

  // After a save the server hands back the normalized address; show it so Save disables.
  useEffect(() => { setAddress(view.searxngUrl); }, [view.searxngUrl]);

  async function pick(service: SearchServiceId) {
    setStatus(null);
    await update({ searchService: service });
  }

  async function saveAddress() {
    if (await update({ searxngUrl: address.trim() })) setStatus('Saved.');
  }

  async function saveKey() {
    if (!keyDraft.trim()) return;
    if (await update({ tavilyKey: keyDraft.trim() })) {
      setKeyDraft('');
      setStatus('Saved.');
    }
  }

  async function test() {
    setStatus('Testing…');
    const result = await api.testSearch().catch((e: Error) => ({ ok: false, error: e.message }));
    setStatus(result.ok ? 'Connection works.' : `Failed: ${result.error}`);
  }

  return (
    <div className="card">
      <strong>Web search</strong>
      <div className="muted small">For local models. OpenRouter models use OpenRouter's own search.</div>
      <div className="row" style={{ justifyContent: 'flex-start' }} role="radiogroup" aria-label="Web search service">
        {SEARCH_SERVICES.map((s) => (
          <label key={s} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="radio" name="search-service" checked={view.searchService === s} onChange={() => pick(s)} />
            {LABELS[s]}
          </label>
        ))}
      </div>

      {view.searchService === 'searxng' && (
        <>
          <div className="row" style={{ justifyContent: 'flex-start' }}>
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="http://localhost:8080"
              style={{ flex: 1 }}
              aria-label="SearXNG address"
            />
            <button className="primary" onClick={saveAddress} disabled={address.trim() === view.searxngUrl}>Save</button>
            <button onClick={test} disabled={!view.searchReady}>Test connection</button>
          </div>
          <div className="muted small">Searches go to your SearXNG instance, which asks the search engines it is set up to use.</div>
        </>
      )}

      {view.searchService === 'tavily' && (
        <>
          <div className="muted small">{view.hasTavilyKey ? `Using key ${view.tavilyKeyMasked}.` : 'No key set yet.'}</div>
          <div className="row" style={{ justifyContent: 'flex-start' }}>
            <input
              type="password"
              placeholder="tvly-…"
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              style={{ flex: 1 }}
              autoComplete="off"
              aria-label="Tavily API key"
            />
            <button className="primary" onClick={saveKey} disabled={!keyDraft.trim()}>Save</button>
            <button onClick={test} disabled={!view.searchReady}>Test connection</button>
          </div>
          {view.hasTavilyKey && (
            <div>
              <button className="link danger" onClick={() => update({ tavilyKey: '' })}>Remove saved key</button>
            </div>
          )}
          <div className="muted small">Your search queries are sent to Tavily. The free plan includes 1,000 searches a month.</div>
        </>
      )}

      {status && <div className="small">{status}</div>}
    </div>
  );
}
