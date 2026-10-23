import { useEffect, useMemo, useState } from 'react';
import type { ImageModel } from '../../../shared/imageModels';
import type { MediaCatalog, MediaLibraryModel } from '../../../shared/types';
import { api } from '../api';
import { loadLibrarySort, saveLibrarySort, sortMediaLibrary, type LibrarySort } from '../lib/models';
import { LibraryHeading } from './LibraryHeading';
import { formatImagePrice, imageBadges, money } from '../lib/imagePrice';
import { TiltCard } from './TiltCard';
import { ProviderMark } from './ProviderMark';
import { SvgTag } from './SvgTag';

const provider = (id: string) => id.split('/')[0];

/** The user's average for the model at its usual settings, if they've used it. */
function avgFor(entry: MediaLibraryModel | undefined): number | null {
  const values = Object.values(entry?.avgCost ?? {});
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function ImageModelCard({ m, entry, busy, onAdd, onRemove }: {
  m: ImageModel; entry: MediaLibraryModel | undefined; busy: boolean; onAdd(): void; onRemove(): void;
}) {
  const [open, setOpen] = useState(false);
  const prices = m.price.kind === 'image' ? Object.entries(m.price.bySize) : [];
  return (
    <TiltCard as="li" max={10} className="model-card">
      <div className="model-card-head">
        <ProviderMark id={m.id} />
        <span className="model-card-name" title={m.name}>{m.name}</span>
        {m.svg && <SvgTag />}
      </div>
      <code className="model-card-id" title={m.id}>{m.id}</code>
      <div className="model-card-stats"><span>{formatImagePrice(m, avgFor(entry))}</span></div>
      <div className="pills">{imageBadges(m).map((b) => <span key={b} className="pill">{b}</span>)}</div>
      {open && (
        <div className="image-model-details">
          {m.description && <p className="small">{m.description}</p>}
          <a className="small" href={`https://openrouter.ai/${m.id}`} target="_blank" rel="noopener noreferrer">More on OpenRouter</a>
          {prices.length > 1 && (
            <p className="small muted">Price by size: {prices.map(([size, usd]) => `${size.toUpperCase()} ${money(usd)}`).join(' · ')}</p>
          )}
          {m.aspects.length > 0 && <p className="small muted">Shapes: {m.aspects.join(', ')}</p>}
        </div>
      )}
      <div className="model-card-actions">
        <button className="primary" disabled={!!entry || busy} onClick={onAdd}>{entry ? 'Added' : 'Add'}</button>
        {entry && <button className="link accent" disabled={busy} onClick={onRemove}>Remove</button>}
        <button className="link" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Less' : 'More'}</button>
      </div>
    </TiltCard>
  );
}

/** The Image models half of the Model Library: the user's list, and OpenRouter's image catalog to add from. */
export function ImageModelLibrary() {
  const [library, setLibrary] = useState<MediaLibraryModel[]>([]);
  const [catalog, setCatalog] = useState<MediaCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [providers, setProviders] = useState<string[]>([]);
  const [svgOnly, setSvgOnly] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [sort, setSort] = useState<LibrarySort>(() => loadLibrarySort('image'));
  const changeSort = (next: LibrarySort) => { setSort(next); saveLibrarySort(next, 'image'); };
  const mine = useMemo(() => sortMediaLibrary(library, sort), [library, sort]);

  const load = (refresh = false) => {
    setLoading(true);
    setError(null);
    // The list reads model details from the cached catalog, so it's reloaded once the catalog has arrived.
    api.mediaCatalog('image', refresh).then((c) => { setCatalog(c); return api.listMediaModels('image').then(setLibrary); }).catch((e: Error) => setError(e.message)).finally(() => setLoading(false));
  };
  useEffect(() => {
    load();
    api.listMediaModels('image').then(setLibrary).catch((e: Error) => setError(e.message));
  }, []);

  const all = (catalog?.models ?? []) as ImageModel[]; // kind=image catalog
  const providerList = useMemo(() => [...new Set(all.map((m) => provider(m.id)))].sort(), [catalog]);
  const q = query.trim().toLowerCase();
  const results = all.filter((m) => (!q || `${m.name} ${m.id}`.toLowerCase().includes(q)) && (providers.length === 0 || providers.includes(provider(m.id))) && (!svgOnly || m.svg));
  const byId = new Map(library.map((e) => [e.id, e]));

  async function act(id: string, fn: () => Promise<MediaLibraryModel[]>) {
    setBusy(id);
    setError(null);
    try {
      setLibrary(await fn());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {error && <p className="error-text">{error}</p>}
      <LibraryHeading title="My image models" count={library.length} sort={sort} onSort={changeSort} />
      {library.length === 0 ? (
        <p className="muted">No image models yet. Add some below to use them in the Images tab.</p>
      ) : (
        <ul className="model-list">
          {mine.map((e) => (
            <li key={e.id} className="model-row">
              <div className="model-main"><span>{e.displayName}{(e.model as ImageModel | null)?.svg && <SvgTag />}</span><code>{e.id}</code></div>
              <div className="model-side">
                <span className="muted small">{e.model ? formatImagePrice(e.model as ImageModel, avgFor(e)) : ''}</span>
                {e.isDefault ? (
                  <span className="badge">Default</span>
                ) : (
                  <button className="link" disabled={busy === e.id} onClick={() => act(e.id, () => api.setDefaultMediaModel(e.id, 'image'))}>Make default</button>
                )}
                <button className="link accent" disabled={busy === e.id} onClick={() => act(e.id, () => api.removeMediaModel(e.id, 'image'))}>Remove</button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <h2>Browse OpenRouter image models</h2>
      <div className="catalog-filters">
        <div className="chip-row">
          <input type="search" placeholder="Search image models" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search image models" />
          <button className="link" disabled={loading} onClick={() => load(true)}>{loading ? 'Loading…' : 'Refresh'}</button>
        </div>
        <div className="chip-row" role="group" aria-label="Output">
          <span className="chip-label">Makes</span>
          <button className={`chip${svgOnly ? ' on' : ''}`} aria-pressed={svgOnly} title="Only models that make SVG (vector) images" onClick={() => setSvgOnly(!svgOnly)}>
            SVG
          </button>
        </div>
        <div className="chip-row">
          <span className="chip-label">Provider</span>
          {providerList.map((p) => (
            <button key={p} className={`chip${providers.includes(p) ? ' on' : ''}`} aria-pressed={providers.includes(p)}
              onClick={() => setProviders(providers.includes(p) ? providers.filter((x) => x !== p) : [...providers, p])}>
              {p}
            </button>
          ))}
        </div>
      </div>
      {catalog?.stale && <p className="muted small">Showing a cached catalog — OpenRouter couldn't be reached.</p>}
      {catalog && <p className="muted small">{results.length} image models</p>}
      <ul className="model-grid">
        {results.map((m) => (
          <ImageModelCard key={m.id} m={m} entry={byId.get(m.id)} busy={busy === m.id}
            onAdd={() => act(m.id, () => api.addMediaModel(m.id, 'image'))}
            onRemove={() => act(m.id, () => api.removeMediaModel(m.id, 'image'))} />
        ))}
      </ul>
    </>
  );
}
