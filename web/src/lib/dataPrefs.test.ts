import { afterEach, describe, it, expect } from 'vitest';
import { forgetAllPrefs, forgetChatPrefs } from './dataPrefs';

function memoryStorage(entries: Record<string, string>): Storage {
  const data = new Map(Object.entries(entries));
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

const stored = () => Object.keys(Object.fromEntries([...Array(localStorage.length).keys()].map((i) => [localStorage.key(i), 1])));

describe('forgetting browser prefs', () => {
  it('removes the per-chat keys of deleted chats only', () => {
    (globalThis as { localStorage?: Storage }).localStorage = memoryStorage({
      'openchat.compare.a': '{}', 'openchat.search.a': '1', 'openchat.compare.b': '{}', 'openchat.stats.range': 'week',
    });
    forgetChatPrefs(['a']);
    expect(stored()).toEqual(['openchat.compare.b', 'openchat.stats.range']);
  });

  it('removes every OpenChat key on a full reset and leaves other sites alone', () => {
    (globalThis as { localStorage?: Storage }).localStorage = memoryStorage({
      'openchat.compare.a': '{}', 'openchat.images.model': 'x', 'other.thing': '1',
    });
    forgetAllPrefs();
    expect(stored()).toEqual(['other.thing']);
  });

  it('does nothing when storage is unavailable', () => {
    (globalThis as { localStorage?: Storage }).localStorage = undefined;
    expect(() => { forgetChatPrefs(['a']); forgetAllPrefs(); }).not.toThrow();
  });
});
