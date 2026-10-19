import { describe, it, expect } from 'vitest';
import { libraryType } from './library';

describe('libraryType', () => {
  it('sorts files into the Library filters by kind and extension', () => {
    expect(libraryType('image', 'a.png')).toBe('image');
    expect(libraryType('pdf', 'r.pdf')).toBe('doc');
    expect(libraryType('text', 'notes.TXT')).toBe('doc');
    expect(libraryType('text', 'cover.md')).toBe('doc');
    expect(libraryType('text', 'page.html')).toBe('doc');
    expect(libraryType('text', 'parser.ts')).toBe('code');
    expect(libraryType('text', 'Makefile')).toBe('code');
  });
});
