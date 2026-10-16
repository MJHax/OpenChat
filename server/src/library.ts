import type { DB } from './db';
import { now } from './db';
import { HttpError } from './http';
import { getSetting, setSetting } from './settings';
import { cachedCapabilities } from './catalog';
import type { CatalogModel, LibraryModel } from '../../shared/types';

interface ModelRow {
  id: string;
  display_name: string;
  context_length: number | null;
  prompt_price: number | null;
  completion_price: number | null;
  input_modalities: string | null;
  supports_tools: number | null;
}

const TEXT_ONLY = ['text'];

/** Rows added before capabilities were stored are filled in from the cached catalog when it knows the model. */
function backfillCapabilities(db: DB, rows: ModelRow[]): void {
  const missing = rows.filter((r) => r.input_modalities === null || r.supports_tools === null);
  if (missing.length === 0) return;
  const cached = cachedCapabilities(db);
  const update = db.prepare('UPDATE models SET input_modalities = ?, supports_tools = ? WHERE id = ?');
  for (const r of missing) {
    const caps = cached.get(r.id);
    if (!caps) continue;
    r.input_modalities ??= JSON.stringify(caps.inputModalities);
    r.supports_tools ??= caps.supportsTools ? 1 : 0;
    update.run(r.input_modalities, r.supports_tools, r.id);
  }
}

const parseModalities = (value: string | null): string[] => (value ? (JSON.parse(value) as string[]) : TEXT_ONLY);

/** What a model accepts as input; ['text'] when it isn't in the library or its capabilities are unknown. */
export function modelModalities(db: DB, id: string): string[] {
  const row = db.prepare('SELECT * FROM models WHERE id = ?').get(id) as ModelRow | undefined;
  if (!row) return TEXT_ONLY;
  backfillCapabilities(db, [row]);
  return parseModalities(row.input_modalities);
}

/** Whether a model can use tools (and so OpenRouter's web search tool); false when unknown. */
export function modelSupportsTools(db: DB, id: string): boolean {
  const row = db.prepare('SELECT * FROM models WHERE id = ?').get(id) as ModelRow | undefined;
  if (!row) return false;
  backfillCapabilities(db, [row]);
  return row.supports_tools === 1;
}

export function displayNameOf(db: DB, id: string): string {
  const row = db.prepare('SELECT display_name FROM models WHERE id = ?').get(id) as { display_name: string } | undefined;
  return row?.display_name ?? id;
}

export function listLibrary(db: DB): LibraryModel[] {
  const defaultId = getSetting(db, 'default_model_id');
  const rows = db.prepare('SELECT * FROM models ORDER BY added_at').all() as ModelRow[];
  backfillCapabilities(db, rows);
  return rows.map((r) => ({
    id: r.id,
    displayName: r.display_name,
    contextLength: r.context_length,
    promptPrice: r.prompt_price,
    completionPrice: r.completion_price,
    isDefault: r.id === defaultId,
    inputModalities: parseModalities(r.input_modalities),
  }));
}

export function requireLibraryModel(db: DB, id: string): void {
  if (!db.prepare('SELECT 1 FROM models WHERE id = ?').get(id)) throw new HttpError(404, 'Model is not in your library.');
}

export function addModel(db: DB, meta: CatalogModel): void {
  db.prepare(
    'INSERT OR IGNORE INTO models (id, display_name, context_length, prompt_price, completion_price, added_at, input_modalities, supports_tools) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(meta.id, meta.name, meta.contextLength, meta.promptPrice, meta.completionPrice, now(), JSON.stringify(meta.inputModalities), meta.supportsTools ? 1 : 0);
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
  if (getSetting(db, 'memory_model_id') === id) setSetting(db, 'memory_model_id', '');
}
