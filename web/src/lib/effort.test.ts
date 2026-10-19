import { afterEach, describe, it, expect } from 'vitest';
import { loadEffort, saveEffort } from './effort';

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

describe('effort storage', () => {
  it('uses the model default until an effort is picked', () => {
    (globalThis as { localStorage?: Storage }).localStorage = memoryStorage();
    expect(loadEffort('a')).toBeNull();
    expect(loadEffort(null)).toBeNull();
  });

  it('remembers each chat, and starts new chats on the last pick', () => {
    (globalThis as { localStorage?: Storage }).localStorage = memoryStorage();
    saveEffort('a', 'high');
    expect(loadEffort('a')).toBe('high');
    expect(loadEffort(null)).toBe('high');
    saveEffort('b', null);
    expect(loadEffort('b')).toBeNull();
    expect(loadEffort('a')).toBe('high');
    expect(loadEffort('c')).toBeNull(); // takes the last pick: default
  });

  it('falls back to the default when storage is unavailable', () => {
    (globalThis as { localStorage?: Storage }).localStorage = undefined;
    expect(loadEffort('a')).toBeNull();
    expect(() => saveEffort('a', 'low')).not.toThrow();
  });
});
