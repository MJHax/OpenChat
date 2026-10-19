import { afterEach, describe, it, expect } from 'vitest';
import {
  APPEARANCE_KEY, DEFAULT_APPEARANCE, effectiveStyle, htmlAttrs, loadAppearance, nextTheme, parseAppearance, resolvedTheme, saveAppearance,
} from './appearance';

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

describe('parseAppearance', () => {
  it('falls back to the defaults for missing or broken values', () => {
    expect(parseAppearance(null)).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearance('not json')).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearance('[1]')).toEqual(DEFAULT_APPEARANCE);
  });

  it('keeps valid fields and drops invalid ones', () => {
    expect(parseAppearance('{"accent":"pink","colorStyle":"flat","animations":"yes","tiltCards":false}'))
      .toEqual({ ...DEFAULT_APPEARANCE, colorStyle: 'flat', tiltCards: false });
  });
});

describe('appearance storage', () => {
  it('round-trips through localStorage', () => {
    (globalThis as { localStorage?: Storage }).localStorage = memoryStorage();
    expect(loadAppearance()).toEqual(DEFAULT_APPEARANCE);
    const a = { ...DEFAULT_APPEARANCE, theme: 'dark' as const, accent: 'green' as const };
    saveAppearance(a);
    expect(localStorage.getItem(APPEARANCE_KEY)).not.toBeNull();
    expect(loadAppearance()).toEqual(a);
  });

  it('survives storage that throws', () => {
    (globalThis as { localStorage?: Storage }).localStorage = {
      ...memoryStorage(),
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    };
    expect(loadAppearance()).toEqual(DEFAULT_APPEARANCE);
    expect(() => saveAppearance(DEFAULT_APPEARANCE)).not.toThrow();
  });
});

describe('effectiveStyle', () => {
  it('makes rainbow always vivid', () => {
    expect(effectiveStyle({ accent: 'rainbow', colorStyle: 'flat' })).toBe('vivid');
    expect(effectiveStyle({ accent: 'green', colorStyle: 'flat' })).toBe('flat');
  });
});

describe('themes', () => {
  it('resolves system against the OS', () => {
    expect(resolvedTheme('system', true)).toBe('dark');
    expect(resolvedTheme('system', false)).toBe('light');
    expect(resolvedTheme('light', true)).toBe('light');
  });

  it('toggles to the opposite of what is showing', () => {
    expect(nextTheme('system', true)).toBe('light');
    expect(nextTheme('system', false)).toBe('dark');
    expect(nextTheme('dark', false)).toBe('light');
    expect(nextTheme('light', true)).toBe('dark');
  });
});

describe('htmlAttrs', () => {
  it('maps appearance to data attributes', () => {
    expect(htmlAttrs(DEFAULT_APPEARANCE, true, false)).toEqual({ theme: 'dark', accent: 'blue', style: 'vivid', motion: 'on', tilt: 'on' });
  });

  it('turns motion and tilt off under reduced motion', () => {
    expect(htmlAttrs({ ...DEFAULT_APPEARANCE, animations: true }, false, true)).toMatchObject({ motion: 'off', tilt: 'off' });
  });

  it('follows the switches', () => {
    expect(htmlAttrs({ ...DEFAULT_APPEARANCE, animations: false }, false, false)).toMatchObject({ motion: 'off', tilt: 'on' });
    expect(htmlAttrs({ ...DEFAULT_APPEARANCE, tiltCards: false }, false, false)).toMatchObject({ motion: 'on', tilt: 'off' });
  });
});
