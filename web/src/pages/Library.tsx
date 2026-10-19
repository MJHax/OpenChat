import { useEffect, useState } from 'react';
import type { LibraryItem, LibraryResponse } from '../../../shared/types';
import { api } from '../api';
import { canReuse, filterItems, previewOf, TYPE_FILTERS, type TypeFilter } from '../lib/fileLibrary';
import { reuseItem, type ReuseDraft } from '../lib/reuse';
import { Segmented } from '../components/stats/Segmented';
import { ErrorText } from '../components/ErrorText';
import { LibraryTile } from '../components/library/LibraryTile';
import { LibraryPreview } from '../components/library/LibraryPreview';

type Section = 'uploads' | 'generated';
const SECTIONS: { id: Section; title: string; empty: string }[] = [
  { id: 'uploads', title: 'Uploads', empty: 'No uploads yet.' },
  { id: 'generated', title: 'Generated', empty: 'No generated files yet.' },
];

const countLabel = (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`;

/** Every file the user uploaded and every file OpenChat made, to download, reuse in a new chat, or trace back to its chats. */
export function Library({ onReuse }: { onReuse(d: ReuseDraft): void }) {
  const [lib, setLib] = useState<LibraryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [type, setType] = useState<TypeFilter>('all');
  const [expanded, setExpanded] = useState<Section | null>(null);
  const [preview, setPreview] = useState<LibraryItem | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => { api.library().then(setLib).catch((e: Error) => setError(e.message)); }, []);

  async function reuse(item: LibraryItem) {
    setBusy(item.key);
    setError(null);
    try {
      onReuse(await reuseItem(item));
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  }
  const reuseFor = (item: LibraryItem) => (canReuse(item) ? () => void reuse(item) : undefined);
  const filtering = !!query.trim() || type !== 'all';

  return (
    <div className="page">
      <div className="page-inner lib-page">
        <div className="stats-head">
          <h1>Library</h1>
          <input type="search" className="lib-search" placeholder="Search files" aria-label="Search files" value={query}
            onChange={(e) => setQuery(e.target.value)} />
          <Segmented label="File type" options={TYPE_FILTERS} value={type} onChange={setType} />
        </div>
        {error && <p className="error-text"><ErrorText message={error} /></p>}
        {!lib ? (!error && <p className="muted">Loading…</p>) : SECTIONS.filter((s) => !expanded || s.id === expanded).map((s) => {
          const items = filterItems(lib[s.id], query, type);
          const { shown, more } = expanded ? { shown: items, more: false } : previewOf(items);
          return (
            <section key={s.id} className="lib-section" aria-label={s.title}>
              <div className="lib-section-head">
                {expanded && <button type="button" className="link" onClick={() => setExpanded(null)}>← Back</button>}
                <h2>{s.title}</h2>
                <span className="muted">{countLabel(items.length)}</span>
                {more && <button type="button" className="link lib-see-all" onClick={() => setExpanded(s.id)}>See all</button>}
              </div>
              {shown.length === 0 ? <p className="muted small">{filtering ? 'Nothing matches.' : s.empty}</p> : (
                <div className="lib-grid">
                  {shown.map((item) => (
                    <LibraryTile key={item.key} item={item} busy={busy === item.key} onOpen={() => setPreview(item)} onReuse={reuseFor(item)} />
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>
      {preview && <LibraryPreview item={preview} busy={busy === preview.key} onReuse={reuseFor(preview)} onClose={() => setPreview(null)} />}
    </div>
  );
}
