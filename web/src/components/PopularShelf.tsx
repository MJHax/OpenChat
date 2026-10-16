import { CATEGORIES, type CatalogModel, type Category } from '../../../shared/types';
import { ModelCard } from './ModelCard';

export interface PopularShelfProps {
  category: Category;
  onCategory(next: Category): void;
  /** Categories that have rankings, so the select never offers an empty one. */
  available: Category[];
  /** Already ranked and filtered (see popularFor). */
  models: CatalogModel[];
  added: Set<string>;
  busy: string | null;
  onAdd(id: string): void;
}

export function PopularShelf({ category, onCategory, available, models, added, busy, onAdd }: PopularShelfProps) {
  const label = CATEGORIES.find((c) => c.id === category)?.label ?? category;
  return (
    <section className="shelf">
      <div className="shelf-head">
        <h3>Popular for</h3>
        <select value={category} onChange={(e) => onCategory(e.target.value as Category)} aria-label="Category">
          {CATEGORIES.filter((c) => available.includes(c.id)).map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
      </div>
      {models.length === 0 ? (
        <p className="muted small">No popular {label} models match these filters.</p>
      ) : (
        <ul className="shelf-strip">
          {models.map((m) => (
            <ModelCard key={m.id} model={m} compact added={added.has(m.id)} busy={busy === m.id} onAdd={() => onAdd(m.id)} />
          ))}
        </ul>
      )}
    </section>
  );
}
