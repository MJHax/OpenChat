import { useEffect, useMemo, useState } from 'react';
import type { CatalogResponse, LibraryModel } from '../../../shared/types';
import { api } from '../api';
import { filterCatalog, providerOf } from '../lib/catalog';
import { formatContext, formatPricePerM } from '../lib/format';

export interface ModelLibraryProps {
  models: LibraryModel[];
  onChanged(): void;
}

const MAX_ROWS = 200;

export function ModelLibrary({ models, onChanged }: ModelLibraryProps) {
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = (refresh = false) => {
    setLoading(true);
    setCatalogError(null);
    api.catalog(refresh)
      .then(setCatalog)
      .catch((e: Error) => setCatalogError(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => load(), []);

  const added = new Set(models.map((m) => m.id));
  const providers = useMemo(() => [...new Set((catalog?.models ?? []).map((m) => providerOf(m.id)))].sort(), [catalog]);
  const filtered = useMemo(() => filterCatalog(catalog?.models ?? [], query, provider), [catalog, query, provider]);

  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setActionError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="page">
      <div className="page-inner">
        <h1>Model Library</h1>
        {actionError && <p className="error-text">{actionError}</p>}

        <h2>My models</h2>
        {models.length === 0 ? (
          <p className="muted">No models yet. Add some from the catalog below.</p>
        ) : (
          <ul className="model-list">
            {models.map((m) => (
              <li key={m.id} className="model-row">
                <div className="model-main">
                  <input
                    className="name-input"
                    defaultValue={m.displayName}
                    aria-label={`Display name for ${m.id}`}
                    onBlur={(e) => {
                      const name = e.target.value.trim();
                      if (name && name !== m.displayName) act(m.id, () => api.updateModel({ id: m.id, displayName: name }));
                    }}
                  />
                  <code>{m.id}</code>
                </div>
                <div className="model-side">
                  {m.isDefault ? (
                    <span className="badge">Default</span>
                  ) : (
                    <button className="link" disabled={busy === m.id} onClick={() => act(m.id, () => api.updateModel({ id: m.id, isDefault: true }))}>
                      Make default
                    </button>
                  )}
                  <button className="link danger" disabled={busy === m.id} onClick={() => act(m.id, () => api.removeModel(m.id))}>
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <h2>Browse OpenRouter</h2>
        <div className="filters">
          <input type="search" placeholder="Search models" value={query} onChange={(e) => setQuery(e.target.value)} />
          <select value={provider} onChange={(e) => setProvider(e.target.value)} aria-label="Provider">
            <option value="">All providers</option>
            {providers.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <button onClick={() => load(true)} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
        </div>
        {catalogError && (
          <p className="error-text">
            Couldn't load the catalog: {catalogError} <button className="link" onClick={() => load(true)}>Retry</button>
          </p>
        )}
        {catalog?.stale && <p className="muted small">Showing a cached catalog — OpenRouter couldn't be reached.</p>}
        {catalog && (
          <p className="muted small">
            {filtered.length} models{filtered.length > MAX_ROWS ? ` (showing first ${MAX_ROWS}; refine your search)` : ''}
          </p>
        )}
        <ul className="model-list">
          {filtered.slice(0, MAX_ROWS).map((m) => (
            <li key={m.id} className="model-row">
              <div className="model-main">
                <span>{m.name}</span>
                <code>{m.id}</code>
              </div>
              <div className="model-side">
                {m.contextLength !== null && <span>{formatContext(m.contextLength)} ctx</span>}
                <span>in {formatPricePerM(m.promptPrice)}</span>
                <span>out {formatPricePerM(m.completionPrice)}</span>
                <button className="primary" disabled={added.has(m.id) || busy === m.id} onClick={() => act(m.id, () => api.addModel(m.id))}>
                  {added.has(m.id) ? 'Added' : 'Add'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
