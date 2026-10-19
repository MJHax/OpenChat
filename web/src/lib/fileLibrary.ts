import type { LibraryFileType, LibraryItem } from '../../../shared/types';

export type TypeFilter = 'all' | LibraryFileType;

export const TYPE_FILTERS: { id: TypeFilter; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'image', label: 'Images' }, { id: 'video', label: 'Video' }, { id: 'doc', label: 'Docs' }, { id: 'code', label: 'Code' },
];

/** How many files each section shows before "See all". */
export const SECTION_PREVIEW = 4;

/** The Library's search (file names) and type filter. */
export function filterItems(items: LibraryItem[], query: string, type: TypeFilter): LibraryItem[] {
  const q = query.trim().toLowerCase();
  return items.filter((i) => (type === 'all' || i.type === type) && (!q || i.name.toLowerCase().includes(q)));
}

/** A section's first few files, and whether there are more to see. */
export function previewOf(items: LibraryItem[]): { shown: LibraryItem[]; more: boolean } {
  return { shown: items.slice(0, SECTION_PREVIEW), more: items.length > SECTION_PREVIEW };
}

/** Chats take images, PDFs and text, so every file but a video can start one. */
export const canReuse = (item: LibraryItem): boolean => item.type !== 'video';
