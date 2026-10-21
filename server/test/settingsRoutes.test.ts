import { describe, it, expect } from 'vitest';
import { makeApp } from './appHelpers';
import { OpenRouterError } from '../src/openrouter';
import { startFakeSearchServer } from '../../test/fakeSearchServer';
import type { Memory, SettingsView } from '../../shared/types';

describe('settings routes', () => {
  it('returns defaults with the env key masked', async () => {
    const { call } = makeApp();
    const res = await call('GET', '/api/settings');
    const view = (await res.json()) as SettingsView;
    expect(view).toMatchObject({ hasApiKey: true, apiKeySource: 'env', theme: 'system' });
    expect(JSON.stringify(view)).not.toContain('1234567890');
  });

  it('saves settings and never echoes the key back', async () => {
    const { call } = makeApp({}, {});
    const res = await call('PUT', '/api/settings', { apiKey: 'sk-or-v1-secretsecret42', aboutMe: 'Sam', theme: 'dark' });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain('secretsecret');
    expect(JSON.parse(text)).toMatchObject({ apiKeySource: 'settings', aboutMe: 'Sam', theme: 'dark' });
  });

  it('rejects an invalid theme and bad JSON with 400', async () => {
    const { call, app } = makeApp();
    expect((await call('PUT', '/api/settings', { theme: 'neon' })).status).toBe(400);
    const bad = await app.request('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{' });
    expect(bad.status).toBe(400);
  });

  it('saves the accent and rejects an unknown one', async () => {
    const { call } = makeApp();
    const res = await call('PUT', '/api/settings', { accent: 'green' });
    expect(((await res.json()) as SettingsView).accent).toBe('green');
    expect((await call('PUT', '/api/settings', { accent: 'x' })).status).toBe(400);
  });

  it('tests the key against OpenRouter', async () => {
    const ok = makeApp();
    expect(await (await ok.call('POST', '/api/settings/test-key')).json()).toEqual({ ok: true });

    const bad = makeApp({ checkKey: async () => { throw new OpenRouterError('OpenRouter rejected the API key.', 401); } });
    expect(await (await bad.call('POST', '/api/settings/test-key')).json()).toEqual({ ok: false, error: 'OpenRouter rejected the API key.' });

    const none = makeApp({}, {});
    expect(await (await none.call('POST', '/api/settings/test-key')).json()).toEqual({ ok: false, error: 'No API key set.' });
  });
});

describe('memory routes', () => {
  it('supports create, list, edit, toggle and delete', async () => {
    const { call } = makeApp();
    const created = (await (await call('POST', '/api/memories', { content: '  Likes tea ' })).json()) as Memory;
    expect(created).toMatchObject({ content: 'Likes tea', enabled: true });

    const edited = (await (await call('PATCH', `/api/memories/${created.id}`, { content: 'Likes green tea', enabled: false })).json()) as Memory;
    expect(edited).toMatchObject({ content: 'Likes green tea', enabled: false });

    expect(((await (await call('GET', '/api/memories')).json()) as Memory[]).length).toBe(1);
    expect((await call('DELETE', `/api/memories/${created.id}`)).status).toBe(200);
    expect(await (await call('GET', '/api/memories')).json()).toEqual([]);
  });

  it('rejects empty content and unknown ids', async () => {
    const { call } = makeApp();
    expect((await call('POST', '/api/memories', { content: '   ' })).status).toBe(400);
    expect((await call('PATCH', '/api/memories/999', { enabled: false })).status).toBe(404);
  });
});

describe('web search settings routes', () => {
  it('rejects a bad service and a bad address with 400', async () => {
    const { call } = makeApp();
    const a = await call('PUT', '/api/settings', { searchService: 'brave' });
    expect(a.status).toBe(400);
    expect(((await a.json()) as { error: string }).error).toBe('Web search service must be none, searxng, or tavily.');
    const b = await call('PUT', '/api/settings', { searxngUrl: 'ftp://x' });
    expect(b.status).toBe(400);
    expect(((await b.json()) as { error: string }).error).toBe('SearXNG address must start with http:// or https://.');
  });

  it('saves a Tavily setup without echoing the key', async () => {
    const { call } = makeApp();
    const res = await call('PUT', '/api/settings', { searchService: 'tavily', tavilyKey: ' tvly-abcdefghijkl ' });
    const text = await res.text();
    expect(text).not.toContain('tvly-abcdefghijkl');
    expect(JSON.parse(text)).toMatchObject({ hasTavilyKey: true, tavilyKeyMasked: 'tvly-a…ijkl', searchReady: true });
  });

  it('tests the saved search setup', async () => {
    const fake = await startFakeSearchServer();
    try {
      const { call } = makeApp({}, { OPENROUTER_API_KEY: 'k', OPENCHAT_TAVILY_URL: fake.url });
      const test = async () => (await (await call('POST', '/api/settings/test-search')).json()) as { ok: boolean; error?: string };

      expect(await test()).toEqual({ ok: false, error: 'Choose a search service and fill in its details first.' });

      await call('PUT', '/api/settings', { searchService: 'searxng', searxngUrl: `${fake.url}/` });
      expect(await test()).toEqual({ ok: true });

      fake.setJson(false);
      expect((await test()).error).toMatch(/^SearXNG answered, but its JSON output is turned off\./);
      fake.setJson(true);

      await call('PUT', '/api/settings', { searchService: 'tavily', tavilyKey: 'tvly-wrong' });
      expect(await test()).toEqual({ ok: false, error: "Tavily didn't accept this API key." });
      await call('PUT', '/api/settings', { tavilyKey: 'tvly-test' });
      expect(await test()).toEqual({ ok: true });

      await call('PUT', '/api/settings', { searchService: 'none' });
      expect((await test()).ok).toBe(false);
    } finally {
      await fake.close();
    }
  });
});
