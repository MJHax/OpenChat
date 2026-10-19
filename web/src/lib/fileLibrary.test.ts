import { describe, it, expect } from 'vitest';
import type { LibraryFileType, LibraryItem } from '../../../shared/types';
import { canReuse, filterItems, previewOf, TYPE_FILTERS } from './fileLibrary';

const item = (name: string, type: LibraryFileType): LibraryItem => ({
  key: name, type, name, size: 1, createdAt: 1, source: { type: 'chatFile', messageId: 'm', name },
  chats: [{ chatId: 'c', kind: 'chat', title: 'C', at: 1 }],
});
const items = [item('parser.ts', 'code'), item('cover.md', 'doc'), item('fox.png', 'image'), item('waves.mp4', 'video')];

describe('filterItems', () => {
  it('matches the search against file names, ignoring case', () => {
    expect(filterItems(items, ' PARS ', 'all').map((i) => i.name)).toEqual(['parser.ts']);
  });

  it('keeps only the chosen type', () => {
    expect(filterItems(items, '', 'doc').map((i) => i.name)).toEqual(['cover.md']);
  });

  it('returns everything with no search and All', () => {
    expect(filterItems(items, '', 'all')).toEqual(items);
  });
});

describe('previewOf', () => {
  it('shows four items and offers See all only past four', () => {
    expect(previewOf(items)).toEqual({ shown: items, more: false });
    const five = [...items, item('x.ts', 'code')];
    expect(previewOf(five)).toEqual({ shown: five.slice(0, 4), more: true });
    expect(previewOf([])).toEqual({ shown: [], more: false });
  });
});

describe('canReuse', () => {
  it('lets every file but videos start a new chat', () => {
    expect(items.map(canReuse)).toEqual([true, true, true, false]);
  });
});

describe('TYPE_FILTERS', () => {
  it('lists the filters in order', () => {
    expect(TYPE_FILTERS.map((f) => f.label)).toEqual(['All', 'Images', 'Video', 'Docs', 'Code']);
  });
});
