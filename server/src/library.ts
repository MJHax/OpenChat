import type { DB } from './db';
import { now } from './db';
import { HttpError } from './http';
import { getSetting, setSetting } from './settings';
import type { CatalogModel, LibraryModel } from '../../shared/types';

interface ModelRow {
  id: string;
  display_name: string;
  context_length: number | null;
  prompt_price: number | null;
  completion_price: number | null;
}

export function listLibrary(db: DB): LibraryModel[] {
  const defaultId = getSetting(db, 'default_model_id');
  const rows = db.prepare('SELECT * FROM models ORDER BY added_at').all() as ModelRow[];
  return rows.map((r) => ({
    id: r.id,
    displayName: r.display_name,
    contextLength: r.context_length,
    promptPrice: r.prompt_price,
    completionPrice: r.completion_price,
    isDefault: r.id === defaultId,
  }));
}

export function requireLibraryModel(db: DB, id: string): void {
  if (!db.prepare('SELECT 1 FROM models WHERE id = ?').get(id)) throw new HttpError(404, 'Model is not in your library.');
}

export function addModel(db: DB, meta: CatalogModel): void {
  db.prepare(
    'INSERT OR IGNORE INTO models (id, display_name, context_length, prompt_price, completion_price, added_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(meta.id, meta.name, meta.contextLength, meta.promptPrice, meta.completionPrice, now());
  if (!getSetting(db, 'default_model_id')) setSetting(db, 'default_model_id', meta.id);
}

export function renameModel(db: DB, id: string, name: string): void {
  db.prepare('UPDATE models SET display_name = ? WHERE id = ?').run(name, id);
}

export function setDefaultModel(db: DB, id: string): void {
  setSetting(db, 'default_model_id', id);
}

export function removeModel(db: DB, id: string): void {
  db.prepare('DELETE FROM models WHERE id = ?').run(id);
  if (getSetting(db, 'default_model_id') === id) {
    const next = db.prepare('SELECT id FROM models ORDER BY added_at LIMIT 1').get() as { id: string } | undefined;
    setSetting(db, 'default_model_id', next?.id ?? '');
  }
  if (getSetting(db, 'title_model_id') === id) setSetting(db, 'title_model_id', '');
}
