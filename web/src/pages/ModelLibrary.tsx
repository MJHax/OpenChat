import { useEffect, useMemo, useState } from 'react';
import { CATEGORIES, type CatalogResponse, type Category, type LibraryModel } from '../../../shared/types';
import { api } from '../api';
import { CatalogFilters } from '../components/CatalogFilters';
import { ModelCard } from '../components/ModelCard';
import { PopularShelf } from '../components/PopularShelf';
import {
  filterCatalog, isFiltering, NO_FILTER, popularFor, sortCatalog, topProviders, type CatalogFilter, type SortKey,
} from '../lib/catalog';

export interface ModelLibraryProps {
  models: LibraryModel[];
  onChanged(): void;
}

const PAGE_SIZE = 60;
const TOP_PROVIDERS = 8;

export function ModelLibrary({ models, onChanged }: ModelLibraryProps) {
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<CatalogFilter>(NO_FILTER);
  const [sort, setSort] = useState<SortKey>('cheapest');
  const [category, setCategory] = useState<Category>('programming');
  const [limit, setLimit] = useState(PAGE_SIZE);
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
          />
        )}

        {catalog && <p className="muted small">{results.length} models</p>}
        {catalog && results.length === 0 ? (
          <p className="muted">
            No models match.{' '}
            {isFiltering(filter) && <button className="link" onClick={() => setFilter(NO_FILTER)}>Clear filters</button>}
          </p>
        ) : (
          <ul className="model-grid">
            {results.slice(0, limit).map((m) => (
              <ModelCard key={m.id} model={m} added={added.has(m.id)} busy={busy === m.id} onAdd={() => act(m.id, () => api.addModel(m.id))} />
            ))}
          </ul>
        )}
        {results.length > limit && (
          <button className="show-more" onClick={() => setLimit((n) => n + PAGE_SIZE)}>Show more</button>
        )}
      </div>
    </div>
  );
}
