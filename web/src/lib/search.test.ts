import { afterEach, describe, it, expect } from 'vitest';
import { SEARCH_NOTE, SEARCH_TOOLTIP, domainOf, loadSearch, saveSearch, sourceLabel } from './search';

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => { data.delete(k); },
    setItem: (k, v) => { data.set(k, v); },
  };
}

const original = (globalThis as { localStorage?: Storage }).localStorage;
afterEach(() => { (globalThis as { localStorage?: Storage }).localStorage = original; });

describe('search toggle storage', () => {
  it('remembers the toggle per chat, off by default', () => {
    (globalThis as { localStorage?: Storage }).localStorage = memoryStorage();
    expect(loadSearch('a')).toBe(false);
    saveSearch('a', true);
    expect(loadSearch('a')).toBe(true);
    expect(loadSearch('b')).toBe(false);
    saveSearch('a', false);
    expect(loadSearch('a')).toBe(false);
    expect(localStorage.getItem('openchat.search.a')).toBe('0');
  });

  it('still works when storage throws', () => {
    (globalThis as { localStorage?: Storage }).localStorage = {
      ...memoryStorage(),
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    };
    expect(loadSearch('a')).toBe(false);
    expect(() => saveSearch('a', true)).not.toThrow();
  });
});

describe('search cost copy', () => {
  it('gives the measured price range and says when a model searches every reply', () => {
    expect(SEARCH_TOOLTIP).toBe("Let the model search the web. Each search costs about $0.007–$0.01 on top of the model's price, even with free models.");
    expect(SEARCH_NOTE).toContain('about $0.007–$0.01');
    expect(SEARCH_NOTE).toContain("Models that can't use tools search on every reply.");
  });
});

describe('source display', () => {
  it('shows the domain without www', () => {
    expect(domainOf('https://www.nodejs.org/en/blog')).toBe('nodejs.org');
    expect(domainOf('not a url')).toBe('not a url');
  });

  it('falls back to the URL when a source has no title', () => {
    expect(sourceLabel({ url: 'https://x.dev/a', title: '  ' })).toBe('https://x.dev/a');
    expect(sourceLabel({ url: 'https://x.dev/a', title: ' Docs ' })).toBe('Docs');
  });
});
