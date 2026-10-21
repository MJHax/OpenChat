import { useEffect, useMemo, useRef, useState } from 'react';
import { CATEGORIES, type CatalogResponse, type Category, type LibraryModel, type LocalCatalog } from '../../../shared/types';
import { api, ApiError } from '../api';
import { CatalogFilters } from '../components/CatalogFilters';
import { ModelCard } from '../components/ModelCard';
import { LocalModelCard } from '../components/LocalModelCard';
import { PopularShelf } from '../components/PopularShelf';
import { ImageModelLibrary } from '../components/ImageModelLibrary';
import { VideoModelLibrary } from '../components/VideoModelLibrary';
import { Segmented } from '../components/stats/Segmented';
import {
  countLabel, filterCatalog, isFiltering, latestOnly, NO_FILTER, popularFor, sortCatalog, topProviders, type CatalogFilter,
  type SortKey,
} from '../lib/catalog';
import type { LibrarySort } from '../lib/models';
import { sourceOptions, type SourceFilter } from '../lib/localModels';
import { LibraryHeading } from '../components/LibraryHeading';

export interface ModelLibraryProps {
  /** Already in the user's chosen order. */
  models: LibraryModel[];
  /** No OpenRouter key is set, so OpenRouter models can't be added. */
  noKey?: boolean;
  onChanged(): void;
  sort: LibrarySort;
  onSort(sort: LibrarySort): void;
}

const KINDS: { id: 'chat' | 'image' | 'video'; label: string }[] = [
  { id: 'chat', label: 'Chat models' }, { id: 'image', label: 'Image models' }, { id: 'video', label: 'Video models' },
];
const PAGE_SIZE = 60;
const TOP_PROVIDERS = 8;

export function ModelLibrary({ models, noKey = false, onChanged, sort: librarySort, onSort: onLibrarySort }: ModelLibraryProps) {
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<CatalogFilter>(NO_FILTER);
  const [sort, setSort] = useState<SortKey>('cheapest');
  const [category, setCategory] = useState<Category>('programming');
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [kind, setKind] = useState<'chat' | 'image' | 'video'>('chat');
  const [source, setSource] = useState<SourceFilter>('all');
  const [local, setLocal] = useState<LocalCatalog | null>(null);
  /** The error from saving a local model's settings, shown on its row. */
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);

  // A slow first load must not overwrite the result of a Refresh started after it.
  const latest = useRef(latestOnly());
  const load = (refresh = false) => {
    const isCurrent = latest.current();
    setLoading(true);
    setCatalogError(null);
    api.catalog(refresh)
      .then((c) => { if (isCurrent()) setCatalog(c); })
      .catch((e: Error) => { if (isCurrent()) setCatalogError(e.message); })
      .finally(() => { if (isCurrent()) setLoading(false); });
  };
  useEffect(() => load(), []);
  const latestLocal = useRef(latestOnly());
  useEffect(() => {
    const isCurrent = latestLocal.current();
    api.localModels().then((c) => { if (isCurrent()) setLocal(c); }).catch(() => { /* keep the previous catalog */ });
  }, [models]);
  useEffect(() => setLimit(PAGE_SIZE), [filter, sort]);

  const added = new Set(models.map((m) => m.id));
  const all = catalog?.models ?? [];
  const rankings = catalog?.rankings ?? {};
  const providers = useMemo(() => topProviders(all, TOP_PROVIDERS), [catalog]);
  const results = useMemo(() => sortCatalog(filterCatalog(all, filter), sort), [catalog, filter, sort]);
  const available = useMemo(() => CATEGORIES.map((c) => c.id).filter((id) => (rankings[id]?.length ?? 0) > 0), [catalog]);
  const shelfCategory: Category | undefined = available.includes(category) ? category : available[0];
  const popular = useMemo(
    () => (shelfCategory ? popularFor(all, rankings, shelfCategory, filter) : []),
    [catalog, shelfCategory, filter],
  );
  const showShelf = shelfCategory !== undefined && filter.query.trim() === '';

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

  const servers = local?.servers ?? [];
  const sourceChoice = servers.some((s) => s.id === source) || source === 'all' || source === 'openrouter' ? source : 'all';
  const showOpenRouter = sourceChoice === 'all' || sourceChoice === 'openrouter';
  const localShown = (local?.models ?? []).filter((m) => sourceChoice === 'all' || m.serverId === sourceChoice);
  const offline = servers.filter((s) => !s.online && (sourceChoice === 'all' || s.id === sourceChoice));
  const serverName = (id: string) => servers.find((s) => s.id === id)?.name ?? id;

  /** Saves a local model's setting, keeping the server's refusal (e.g. a window out of range) on its row. */
  async function saveLocal(id: string, patch: { contextWindow?: number; supportsTools?: boolean; supportsImages?: boolean }) {
    setRowError(null);
    try {
      await api.updateModel({ id, ...patch });
      onChanged();
    } catch (e) {
      setRowError({ id, message: e instanceof ApiError ? e.message : (e as Error).message });
    }
  }

  const switcher = <Segmented label="Model kind" options={KINDS} value={kind} onChange={setKind} />;
  if (kind !== 'chat') {
    return (
      <div className="page">
        <div className="page-inner">
          <div className="stats-head"><h1>Model Library</h1>{switcher}</div>
          {kind === 'image' ? <ImageModelLibrary /> : <VideoModelLibrary />}
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-inner">
        <div className="stats-head"><h1>Model Library</h1>{switcher}</div>
        {actionError && <p className="error-text">{actionError}</p>}

        <LibraryHeading title="My models" count={models.length} sort={librarySort} onSort={onLibrarySort} />
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
                  {m.source === 'local' && (
                    <div className="local-settings">
                      <label className="small">
                        Context window{' '}
                        <input
                          type="number"
                          className="window-input"
                          min={1}
                          defaultValue={m.contextWindow ?? undefined}
                          aria-label={`Context window for ${m.id}`}
                          onBlur={(e) => {
                            const n = Number(e.target.value);
                            if (Number.isInteger(n) && n > 0 && n !== m.contextWindow) void saveLocal(m.id, { contextWindow: n });
                          }}
                        />
                      </label>
                      {!m.capsKnown && (
                        <>
                          <label className="small">
                            <input type="checkbox" checked={m.supportsTools} onChange={(e) => void saveLocal(m.id, { supportsTools: e.target.checked })} /> Can use tools
                          </label>
                          <label className="small">
                            <input type="checkbox" checked={m.inputModalities.includes('image')} onChange={(e) => void saveLocal(m.id, { supportsImages: e.target.checked })} /> Can see images
                          </label>
                        </>
                      )}
                      {rowError?.id === m.id && <p className="error-text small">{rowError.message}</p>}
                    </div>
                  )}
                </div>
                <div className="model-side">
                  <span className="badge">{m.source === 'local' ? m.serverName ?? 'Local' : 'OpenRouter'}</span>
                  {m.isDefault ? (
                    <span className="badge">Default</span>
                  ) : (
                    <button className="link" disabled={busy === m.id} onClick={() => act(m.id, () => api.updateModel({ id: m.id, isDefault: true }))}>
                      Make default
                    </button>
                  )}
                  <button className="link accent" disabled={busy === m.id} onClick={() => act(m.id, () => api.removeModel(m.id))}>
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <h2>Browse</h2>
        <Segmented label="Model source" options={sourceOptions(servers)} value={sourceChoice} onChange={setSource} />
        {offline.map((s) => (
          <p key={s.id} className="muted small">{s.name} isn't reachable{s.error ? `: ${s.error}` : ''}.</p>
        ))}
        {localShown.length > 0 && (
          <ul className="model-grid">
            {localShown.map((m) => (
              <LocalModelCard
                key={m.id}
                model={m}
                serverName={serverName(m.serverId)}
                added={added.has(m.id)}
                busy={busy === m.id}
                onAdd={() => act(m.id, () => api.addModel(m.id))}
                onRemove={() => act(m.id, () => api.removeModel(m.id))}
              />
            ))}
          </ul>
        )}
        {showOpenRouter && (
        <>
        {noKey && <p className="muted small">Add your OpenRouter API key in Settings to add these models.</p>}
        <CatalogFilters
          filter={filter}
          onFilter={setFilter}
          sort={sort}
          onSort={setSort}
          providers={providers}
          loading={loading}
          onRefresh={() => load(true)}
        />
        {catalogError && (
          <p className="error-text">
            Couldn't load the catalog: {catalogError} <button className="link" onClick={() => load(true)}>Retry</button>
          </p>
        )}
        {catalog?.stale && <p className="muted small">Showing a cached catalog — OpenRouter couldn't be reached.</p>}

        {catalog && showShelf && shelfCategory && (
          <PopularShelf
            category={shelfCategory}
            onCategory={setCategory}
            available={available}
            models={popular}
            added={added}
            busy={busy}
            onAdd={(id) => act(id, () => api.addModel(id))}
            onRemove={(id) => act(id, () => api.removeModel(id))}
            needsKey={noKey}
          />
        )}

        {catalog && <p className="muted small">{countLabel(results.length)}</p>}
        {catalog && results.length === 0 ? (
          <p className="muted">
            No models match.{' '}
            {isFiltering(filter) && <button className="link" onClick={() => setFilter(NO_FILTER)}>Clear filters</button>}
          </p>
        ) : (
          <ul className="model-grid">
            {results.slice(0, limit).map((m) => (
              <ModelCard
                key={m.id}
                model={m}
                added={added.has(m.id)}
                busy={busy === m.id}
                needsKey={noKey}
                onAdd={() => act(m.id, () => api.addModel(m.id))}
                onRemove={() => act(m.id, () => api.removeModel(m.id))}
              />
            ))}
          </ul>
        )}
        {results.length > limit && (
          <button className="show-more" onClick={() => setLimit((n) => n + PAGE_SIZE)}>Show more</button>
        )}
        </>
        )}
      </div>
    </div>
  );
}
