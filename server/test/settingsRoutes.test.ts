import { describe, it, expect } from 'vitest';
import { makeApp } from './appHelpers';
import { OpenRouterError } from '../src/openrouter';
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
