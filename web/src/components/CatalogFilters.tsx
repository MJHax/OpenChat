import { useState } from 'react';
import { CAPABILITIES, providerChips, SORTS, UNUSED_HINT, type CatalogFilter, type SortKey } from '../lib/catalog';

export interface CatalogFiltersProps {
  filter: CatalogFilter;
  onFilter(next: CatalogFilter): void;
  sort: SortKey;
  onSort(next: SortKey): void;
  providers: { top: string[]; rest: string[] };
  loading: boolean;
  onRefresh(): void;
}

const toggle = <T,>(list: T[], item: T): T[] => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);

export function CatalogFilters({ filter, onFilter, sort, onSort, providers, loading, onRefresh }: CatalogFiltersProps) {
  const [allProviders, setAllProviders] = useState(false);
  const { chips, hiddenCount } = providerChips(providers, filter.providers, allProviders);

  return (
    <div className="catalog-filters">
      <div className="filters">
        <input type="search" placeholder="Search models" value={filter.query} onChange={(e) => onFilter({ ...filter, query: e.target.value })} />
        <select value={sort} onChange={(e) => onSort(e.target.value as SortKey)} aria-label="Sort">
          {SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
        <button onClick={onRefresh} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
      </div>

      <div className="chip-row" role="group" aria-label="Capabilities">
        <span className="chip-label">Can do</span>
        {CAPABILITIES.map((c) => {
          const on = filter.capabilities.includes(c.id);
          return (
            <button
              key={c.id}
              className={`chip${on ? ' on' : ''}${c.usedByOpenChat ? '' : ' unused'}`}
              aria-pressed={on}
              title={c.usedByOpenChat ? undefined : UNUSED_HINT}
              onClick={() => onFilter({ ...filter, capabilities: toggle(filter.capabilities, c.id) })}
            >
              {c.label}
            </button>
          );
        })}
        <span className="muted small">• {UNUSED_HINT}</span>
      </div>

      <div className="chip-row" role="group" aria-label="Providers">
        <span className="chip-label">Provider</span>
        {chips.map((p) => {
          const on = filter.providers.includes(p);
          return (
            <button key={p} className={`chip${on ? ' on' : ''}`} aria-pressed={on} onClick={() => onFilter({ ...filter, providers: toggle(filter.providers, p) })}>
              {p}
            </button>
          );
        })}
        {/* One button that changes label, so keyboard focus stays on it when it's toggled. */}
        {(allProviders ? providers.rest.length > 0 : hiddenCount > 0) && (
          <button
            className="chip more"
            aria-expanded={allProviders}
            aria-label={allProviders ? 'Fewer providers' : `+${hiddenCount} more providers`}
            onClick={() => setAllProviders((v) => !v)}
          >
            {allProviders ? 'Fewer' : `+${hiddenCount}`}
          </button>
        )}
      </div>
    </div>
  );
}
