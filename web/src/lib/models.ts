import type { LibraryModel, Message } from '../../../shared/types';

/** The model a chat opens with: the last library model that replied in it, else the default model. */
/** `preferred` (e.g. the model that summarized a continued chat) applies until some model in the library has replied. */
export function initialModelId(messages: Pick<Message, 'role' | 'modelId'>[], models: LibraryModel[], preferred?: string | null): string {
  const ids = new Set(models.map((m) => m.id));
  const lastUsed = [...messages].reverse().find((m) => m.role === 'assistant' && m.modelId && ids.has(m.modelId))?.modelId;
  const fallback = preferred && ids.has(preferred) ? preferred : undefined;
  return lastUsed ?? fallback ?? (models.find((m) => m.isDefault) ?? models[0])?.id ?? '';
}

export type LibrarySort = 'added' | 'name' | 'cost';

export const LIBRARY_SORTS: { id: LibrarySort; label: string }[] = [
  { id: 'added', label: 'Date added' },
  { id: 'name', label: 'Name' },
  { id: 'cost', label: 'Cost' },
];

/** Input + output price per token; unknown or "varies" sorts last. */
const costOf = (m: LibraryModel): number => {
  const { promptPrice: p, completionPrice: c } = m;
  return p === null || c === null || p < 0 || c < 0 ? Infinity : p + c;
};

/** The library in the user's chosen order. The server lists models oldest first, which is the 'added' order. */
export function sortLibrary(models: LibraryModel[], sort: LibrarySort): LibraryModel[] {
  if (sort === 'added') return models;
  const byName = (a: LibraryModel, b: LibraryModel) => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' });
  return [...models].sort(sort === 'name' ? byName : (a, b) => costOf(a) - costOf(b) || byName(a, b));
}

const SORT_KEY = 'openchat.librarySort';

export function loadLibrarySort(): LibrarySort {
  try {
    const v = localStorage.getItem(SORT_KEY);
    return LIBRARY_SORTS.some((s) => s.id === v) ? (v as LibrarySort) : 'added';
  } catch {
    return 'added';
  }
}

export function saveLibrarySort(sort: LibrarySort): void {
  try {
    localStorage.setItem(SORT_KEY, sort);
  } catch {
    // storage unavailable (private window); the choice lasts this visit
  }
}
