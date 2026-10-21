import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db';
import { getPersona, getSettingsView, maskKey, resolveApiKey, updateSettings } from '../src/settings';
import { HttpError } from '../src/http';

describe('resolveApiKey', () => {
  it('prefers the Settings value over the environment', () => {
    const db = openDb(':memory:');
    expect(resolveApiKey(db, {})).toEqual({ key: '', source: 'none' });
    expect(resolveApiKey(db, { OPENROUTER_API_KEY: 'env-key' })).toEqual({ key: 'env-key', source: 'env' });
    updateSettings(db, { apiKey: '  settings-key ' });
    expect(resolveApiKey(db, { OPENROUTER_API_KEY: 'env-key' })).toEqual({ key: 'settings-key', source: 'settings' });
    updateSettings(db, { apiKey: '' });
    expect(resolveApiKey(db, { OPENROUTER_API_KEY: 'env-key' }).source).toBe('env');
  });
});

describe('maskKey', () => {
  it('shows only the start and end of the key', () => {
    expect(maskKey('sk-or-v1-abcdef1234567890')).toBe('sk-or-…7890');
    expect(maskKey('short')).toBe('••••');
    expect(maskKey('')).toBe('');
  });
});

describe('getSettingsView', () => {
  it('has defaults and never includes the raw key', () => {
    const db = openDb(':memory:');
    updateSettings(db, { apiKey: 'sk-or-v1-supersecretvalue99' });
    const view = getSettingsView(db, {});
    expect(view).toMatchObject({ hasApiKey: true, apiKeySource: 'settings', theme: 'system', aboutMe: '' });
    expect(JSON.stringify(view)).not.toContain('supersecret');
  });
});

describe('updateSettings', () => {
  it('rejects an invalid theme', () => {
    const db = openDb(':memory:');
    expect(() => updateSettings(db, { theme: 'neon' as never })).toThrow(HttpError);
  });
});

describe('getPersona', () => {
  it('includes only enabled memories', () => {
    const db = openDb(':memory:');
    updateSettings(db, { aboutMe: 'Sam', customInstructions: 'Be brief' });
    db.prepare('INSERT INTO memories (content, enabled, created_at) VALUES (?, ?, ?)').run('Likes tea', 1, 1);
    db.prepare('INSERT INTO memories (content, enabled, created_at) VALUES (?, ?, ?)').run('Paused fact', 0, 2);
    expect(getPersona(db)).toEqual({ aboutMe: 'Sam', customInstructions: 'Be brief', memories: ['Likes tea'] });
  });
});

describe('appearance settings', () => {
  it('defaults to blue, vivid, animations and tilt on', () => {
    const db = openDb(':memory:');
    expect(getSettingsView(db, {})).toMatchObject({ accent: 'blue', colorStyle: 'vivid', animations: true, tiltCards: true });
  });
  it('saves and reads them back', () => {
    const db = openDb(':memory:');
    updateSettings(db, { accent: 'rainbow', colorStyle: 'flat', animations: false, tiltCards: false });
    expect(getSettingsView(db, {})).toMatchObject({ accent: 'rainbow', colorStyle: 'flat', animations: false, tiltCards: false });
  });
  it('removes the saved Tavily key when saved empty', () => {
    const db = openDb(':memory:');
    updateSettings(db, { searchService: 'tavily', tavilyKey: 'tvly-abcdefghijkl' });
    updateSettings(db, { tavilyKey: '' });
    expect(getSettingsView(db, {})).toMatchObject({ hasTavilyKey: false, tavilyKeyMasked: '', searchReady: false });
  });
  it('rejects bad values', () => {
    const db = openDb(':memory:');
    expect(() => updateSettings(db, { accent: 'pink' as never })).toThrow(HttpError);
    expect(() => updateSettings(db, { colorStyle: 'loud' as never })).toThrow(HttpError);
    expect(() => updateSettings(db, { animations: 'yes' as never })).toThrow(HttpError);
  });
});

describe('web search settings', () => {
  it('defaults to none and not ready', () => {
    const db = openDb(':memory:');
    expect(getSettingsView(db, {})).toMatchObject({ searchService: 'none', searxngUrl: '', hasTavilyKey: false, tavilyKeyMasked: '', searchReady: false });
  });
  it('masks the Tavily key and never exposes it', () => {
    const db = openDb(':memory:');
    updateSettings(db, { searchService: 'tavily', tavilyKey: ' tvly-abcdefghijkl ' });
    const view = getSettingsView(db, {});
    expect(view).toMatchObject({ searchService: 'tavily', hasTavilyKey: true, tavilyKeyMasked: 'tvly-a…ijkl', searchReady: true });
    expect(JSON.stringify(view)).not.toContain('tvly-abcdefghijkl');
  });
  it('trims the SearXNG address and drops a trailing slash', () => {
    const db = openDb(':memory:');
    updateSettings(db, { searchService: 'searxng', searxngUrl: ' http://localhost:8080/ ' });
    expect(getSettingsView(db, {})).toMatchObject({ searxngUrl: 'http://localhost:8080', searchReady: true });
    updateSettings(db, { searxngUrl: '' });
    expect(getSettingsView(db, {})).toMatchObject({ searxngUrl: '', searchReady: false });
  });
  it('rejects bad values', () => {
    const db = openDb(':memory:');
    expect(() => updateSettings(db, { searchService: 'brave' as never })).toThrow('Web search service must be none, searxng, or tavily.');
    expect(() => updateSettings(db, { searxngUrl: 'ftp://x' })).toThrow('SearXNG address must start with http:// or https://.');
  });
});
