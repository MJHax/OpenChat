import { afterEach, describe, it, expect } from 'vitest';
import { loadThinking, saveThinking } from './thinking';

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

describe('thinking storage', () => {
  it('defaults to on', () => {
    (globalThis as { localStorage?: Storage }).localStorage = memoryStorage();
    expect(loadThinking('a')).toBe(true);
    expect(loadThinking(null)).toBe(true);
  });

  it('remembers each chat, and starts new chats on the last pick', () => {
    (globalThis as { localStorage?: Storage }).localStorage = memoryStorage();
    saveThinking('a', false);
    expect(loadThinking('a')).toBe(false);
    expect(loadThinking(null)).toBe(false);
    expect(loadThinking('c')).toBe(false);
    saveThinking('b', true);
    expect(loadThinking('b')).toBe(true);
    expect(loadThinking('a')).toBe(false);
  });

  it('falls back to on when storage is unavailable', () => {
    (globalThis as { localStorage?: Storage }).localStorage = undefined;
    expect(loadThinking('a')).toBe(true);
    expect(() => saveThinking('a', false)).not.toThrow();
  });
});
