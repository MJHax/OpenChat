import { defaultSettings, estimateImageCost, type ImageModel } from '../../../shared/imageModels';
import { cheapestPerSecond, type VideoModel } from '../../../shared/videoModels';
import type { LibraryModel, MediaKind, MediaLibraryModel, Message } from '../../../shared/types';

/** The model a chat opens with: the last library model that replied in it, else the default model. */
/** `preferred` (e.g. the model that summarized a continued chat) applies until some model in the library has replied. */
export function initialModelId(messages: Pick<Message, 'role' | 'modelId'>[], models: LibraryModel[], preferred?: string | null): string {
  const ids = new Set(models.map((m) => m.id));
  const lastUsed = [...messages].reverse().find((m) => m.role === 'assistant' && m.modelId && ids.has(m.modelId))?.modelId;
  const fallback = preferred && ids.has(preferred) ? preferred : undefined;
  return lastUsed ?? fallback ?? (models.find((m) => m.isDefault) ?? models[0])?.id ?? '';
}

/**
 * The image or video model a thread uses: the user's pick, else the one its last generation used, else the kind's default,
 * else the first. Models the catalog no longer lists can't generate, so they're skipped.
 */
export function pickMediaEntry(library: MediaLibraryModel[], pickedId: string, threadModelId: string | null): MediaLibraryModel | undefined {
  const usable = library.filter((e) => e.model);
  const byId = (id: string | null) => (id ? usable.find((e) => e.id === id) : undefined);
  return byId(pickedId) ?? byId(threadModelId) ?? usable.find((e) => e.isDefault) ?? usable[0];
}

export type LibrarySort = 'added' | 'name' | 'cost';

export const LIBRARY_SORTS: { id: LibrarySort; label: string }[] = [
  { id: 'added', label: 'Date added' },
  { id: 'name', label: 'Name' },
  { id: 'cost', label: 'Cost' },
];

/** `items` in the chosen order: as listed (oldest added first), by name, or cheapest first with unknown prices last. */
function sortBy<T>(items: T[], sort: LibrarySort, name: (t: T) => string, cost: (t: T) => number | null): T[] {
  if (sort === 'added') return items;
  const byName = (a: T, b: T) => name(a).localeCompare(name(b), undefined, { sensitivity: 'base' });
  const price = (t: T) => cost(t) ?? Infinity;
  return [...items].sort(sort === 'name' ? byName : (a, b) => price(a) - price(b) || byName(a, b));
}

/** Input + output price per token; null when unknown or "varies". */
const chatCost = (m: LibraryModel): number | null => {
  const { promptPrice: p, completionPrice: c } = m;
  return p === null || c === null || p < 0 || c < 0 ? null : p + c;
};

/** The library in the user's chosen order. The server lists models oldest first, which is the 'added' order. */
export const sortLibrary = (models: LibraryModel[], sort: LibrarySort): LibraryModel[] =>
  sortBy(models, sort, (m) => m.displayName, chatCost);

/** One image at the model's usual settings, or a video's cheapest rate per second; null when unknown. */
function mediaCost(e: MediaLibraryModel): number | null {
  if (!e.model) return null;
  return e.kind === 'image'
    ? estimateImageCost(e.model as ImageModel, defaultSettings(e.model as ImageModel), null).cost
    : cheapestPerSecond(e.model as VideoModel);
}

export const sortMediaLibrary = (models: MediaLibraryModel[], sort: LibrarySort): MediaLibraryModel[] =>
  sortBy(models, sort, (m) => m.displayName, mediaCost);

/** Chat, image and video models each keep their own order. */
const sortKey = (kind: 'chat' | MediaKind) => (kind === 'chat' ? 'openchat.librarySort' : `openchat.librarySort.${kind}`);

export function loadLibrarySort(kind: 'chat' | MediaKind = 'chat'): LibrarySort {
  try {
    const v = localStorage.getItem(sortKey(kind));
    return LIBRARY_SORTS.some((s) => s.id === v) ? (v as LibrarySort) : 'added';
  } catch {
    return 'added';
  }
}

export function saveLibrarySort(sort: LibrarySort, kind: 'chat' | MediaKind = 'chat'): void {
  try {
    localStorage.setItem(sortKey(kind), sort);
  } catch {
    // storage unavailable (private window); the choice lasts this visit
  }
}
