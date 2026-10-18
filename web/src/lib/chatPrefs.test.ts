import { afterEach, describe, it, expect } from 'vitest';
import { forgetChatPrefs } from './chatPrefs';
import { saveCompare } from './compare';
import { saveSearch } from './search';

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

describe('forgetChatPrefs', () => {
  it("removes only the given chats' compare and search settings", () => {
    const storage = memoryStorage();
    (globalThis as { localStorage?: Storage }).localStorage = storage;
    for (const id of ['a', 'b', 'c']) {
      saveCompare(id, { enabled: true, modelIds: ['x', 'y'] });
      saveSearch(id, true);
    }
    storage.setItem('openchat.theme', 'dark');
    forgetChatPrefs(['a', 'c']);
    expect([...Array(storage.length).keys()].map((i) => storage.key(i)).sort()).toEqual(['openchat.compare.b', 'openchat.search.b', 'openchat.theme']);
  });

  it('does nothing when storage is unavailable', () => {
    (globalThis as { localStorage?: Storage }).localStorage = {
      removeItem: () => { throw new Error('blocked'); },
    } as unknown as Storage;
    expect(() => forgetChatPrefs(['a'])).not.toThrow();
  });
});
