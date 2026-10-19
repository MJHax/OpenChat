import { LIBRARY_SORTS, type LibrarySort } from '../lib/models';

/** The "My models" heading with its sort control, shown once there is more than one model to order. */
export function LibraryHeading({ title, count, sort, onSort }: { title: string; count: number; sort: LibrarySort; onSort(sort: LibrarySort): void }) {
  return (
    <div className="section-head">
      <h2>{title}</h2>
      {count > 1 && (
        <label className="muted small">
          Sort by{' '}
          <select value={sort} onChange={(e) => onSort(e.target.value as LibrarySort)} aria-label={`Sort ${title.toLowerCase()}`}>
            {LIBRARY_SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
      )}
    </div>
  );
}
