import { useEffect, useMemo, useState } from 'react';
import { usd, videoPrice, type VideoModel } from '../../../shared/videoModels';
import type { MediaCatalog, MediaLibraryModel } from '../../../shared/types';
import { api } from '../api';
import { loadLibrarySort, saveLibrarySort, sortMediaLibrary, type LibrarySort } from '../lib/models';
import { LibraryHeading } from './LibraryHeading';
import { formatVideoRate, videoBadges } from '../lib/videoUi';
import { TiltCard } from './TiltCard';
import { ProviderMark } from './ProviderMark';

const provider = (id: string) => id.split('/')[0];

function VideoModelCard({ m, added, busy, onAdd, onRemove }: { m: VideoModel; added: boolean; busy: boolean; onAdd(): void; onRemove(): void }) {
  const [open, setOpen] = useState(false);
  const shortest = m.durations[0] ?? 5;
  const table = (m.resolutions.length ? m.resolutions : [null]).map((r) => {
    const at = (sound: boolean) => videoPrice(m, { duration: 1, resolution: r, aspect: m.aspects[0] ?? '16:9', sound }, 0);
    return { r, silent: at(false), sound: m.sound ? at(true) : null };
  });
  return (
    <TiltCard as="li" max={10} className="model-card">
      <div className="model-card-head"><ProviderMark id={m.id} /><span className="model-card-name" title={m.name}>{m.name}</span></div>
      <code className="model-card-id" title={m.id}>{m.id}</code>
      <div className="model-card-stats"><span>{formatVideoRate(m)}</span></div>
      <div className="pills">{videoBadges(m).map((b) => <span key={b} className="pill">{b}</span>)}</div>
      {open && (
        <div className="image-model-details">
          {m.description && <p className="small">{m.description}</p>}
          <a className="small" href={`https://openrouter.ai/${m.id}`} target="_blank" rel="noopener noreferrer">More on OpenRouter</a>
          <p className="small muted">
            Per second: {table.map(({ r, silent, sound }) => `${r ?? 'any'} ${silent.cost === null ? '?' : usd(silent.cost)}${sound?.cost != null ? ` (${usd(sound.cost)} with sound)` : ''}`).join(' · ')}
          </p>
          <p className="small muted">Lengths: {m.durations.join(', ')}s (shortest clip from {usd((videoPrice(m, { duration: shortest, resolution: m.resolutions[0] ?? null, aspect: m.aspects[0] ?? '16:9', sound: false }, 0).cost ?? 0))})</p>
          {m.aspects.length > 0 && <p className="small muted">Shapes: {m.aspects.join(', ')}</p>}
        </div>
      )}
      <div className="model-card-actions">
        <button className="primary" disabled={added || busy} onClick={onAdd}>{added ? 'Added' : 'Add'}</button>
        {added && <button className="link danger" disabled={busy} onClick={onRemove}>Remove</button>}
        <button className="link" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Less' : 'More'}</button>
      </div>
    </TiltCard>
  );
}

/** The Video models part of the Model Library: the user's list and OpenRouter's video catalog. */
export function VideoModelLibrary() {
  const [library, setLibrary] = useState<MediaLibraryModel[]>([]);
  const [catalog, setCatalog] = useState<MediaCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [providers, setProviders] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [sort, setSort] = useState<LibrarySort>(() => loadLibrarySort('video'));
  const changeSort = (next: LibrarySort) => { setSort(next); saveLibrarySort(next, 'video'); };
  const mine = useMemo(() => sortMediaLibrary(library, sort), [library, sort]);

  const load = (refresh = false) => {
    setLoading(true);
    setError(null);
    // The list reads model details from the cached catalog, so it's reloaded once the catalog has arrived.
    api.mediaCatalog('video', refresh).then((c) => { setCatalog(c); return api.listMediaModels('video').then(setLibrary); }).catch((e: Error) => setError(e.message)).finally(() => setLoading(false));
  };
  useEffect(() => {
    load();
    api.listMediaModels('video').then(setLibrary).catch((e: Error) => setError(e.message));
  }, []);

  const all = (catalog?.models ?? []) as VideoModel[]; // kind=video catalog
  const providerList = useMemo(() => [...new Set(all.map((m) => provider(m.id)))].sort(), [catalog]);
  const q = query.trim().toLowerCase();
  const results = all.filter((m) => (!q || `${m.name} ${m.id}`.toLowerCase().includes(q)) && (providers.length === 0 || providers.includes(provider(m.id))));
  const added = new Set(library.map((e) => e.id));

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
      <LibraryHeading title="My video models" count={library.length} sort={sort} onSort={changeSort} />
      {library.length === 0 ? <p className="muted">No video models yet. Add some below to use them in the Video tab.</p> : (
        <ul className="model-list">
          {mine.map((e) => (
            <li key={e.id} className="model-row">
              <div className="model-main"><span>{e.displayName}</span><code>{e.id}</code></div>
              <div className="model-side">
                <span className="muted small">{e.model ? formatVideoRate(e.model as VideoModel) : 'not offered any more'}</span>
                <button className="link danger" disabled={busy === e.id} onClick={() => act(e.id, () => api.removeMediaModel(e.id, 'video'))}>Remove</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <h2>Browse OpenRouter video models</h2>
      <div className="catalog-filters">
        <div className="chip-row">
          <input type="search" placeholder="Search video models" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search video models" />
          <button className="link" disabled={loading} onClick={() => load(true)}>{loading ? 'Loading…' : 'Refresh'}</button>
        </div>
        <div className="chip-row">
          <span className="chip-label">Provider</span>
          {providerList.map((p) => (
            <button key={p} className={`chip${providers.includes(p) ? ' on' : ''}`} aria-pressed={providers.includes(p)}
              onClick={() => setProviders(providers.includes(p) ? providers.filter((x) => x !== p) : [...providers, p])}>{p}</button>
          ))}
        </div>
      </div>
      {catalog?.stale && <p className="muted small">Showing a cached catalog — OpenRouter couldn't be reached.</p>}
      {catalog && <p className="muted small">{results.length} video models</p>}
      <ul className="model-grid">
        {results.map((m) => (
          <VideoModelCard key={m.id} m={m} added={added.has(m.id)} busy={busy === m.id}
            onAdd={() => act(m.id, () => api.addMediaModel(m.id, 'video'))} onRemove={() => act(m.id, () => api.removeMediaModel(m.id, 'video'))} />
        ))}
      </ul>
    </>
  );
}
