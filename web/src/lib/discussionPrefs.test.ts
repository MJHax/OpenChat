import { afterEach, describe, it, expect } from 'vitest';
import { DEFAULT_DISCUSSION_PREFS, loadDiscussionPrefs, saveDiscussionPrefs } from './discussionPrefs';

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

function use(storage: Storage) {
  (globalThis as { localStorage?: Storage }).localStorage = storage;
}

describe('discussion preferences', () => {
  it('defaults to natural reveal and keep going', () => {
    use(memoryStorage());
    expect(DEFAULT_DISCUSSION_PREFS).toEqual({ reveal: 'natural', waitForMe: false });
    expect(loadDiscussionPrefs()).toEqual(DEFAULT_DISCUSSION_PREFS);
  });

  it('round trips saved preferences', () => {
    use(memoryStorage());
    saveDiscussionPrefs({ reveal: 'instant', waitForMe: true });
    expect(loadDiscussionPrefs()).toEqual({ reveal: 'instant', waitForMe: true });
  });

  it('falls back to defaults for invalid JSON', () => {
    const s = memoryStorage();
    s.setItem('openchat.discussionPrefs', '{nope');
    use(s);
    expect(loadDiscussionPrefs()).toEqual(DEFAULT_DISCUSSION_PREFS);
  });

  it('falls back per field for unknown values', () => {
    const s = memoryStorage();
    s.setItem('openchat.discussionPrefs', JSON.stringify({ reveal: 'slow', waitForMe: 'yes' }));
    use(s);
    expect(loadDiscussionPrefs()).toEqual(DEFAULT_DISCUSSION_PREFS);
  });

  it('survives storage that throws', () => {
    use({
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    } as unknown as Storage);
    expect(loadDiscussionPrefs()).toEqual(DEFAULT_DISCUSSION_PREFS);
    expect(() => saveDiscussionPrefs({ reveal: 'instant', waitForMe: true })).not.toThrow();
  });
});
