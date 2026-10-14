import { describe, it, expect } from 'vitest';
import { makeApp } from './appHelpers';
import { OpenRouterError, type OpenRouterClient } from '../src/openrouter';
import { cleanFact } from '../src/memorySuggest';
import { updateSettings } from '../src/settings';
import type { LibraryModel, SettingsView } from '../../shared/types';

function capture(reply: string | Error = 'User lives in a farming town.') {
  const calls: Parameters<OpenRouterClient['complete']>[0][] = [];
  const complete: OpenRouterClient['complete'] = async (o) => {
    calls.push(o);
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { complete, calls };
}

const suggest = (call: ReturnType<typeof makeApp>['call'], text: unknown) => call('POST', '/api/memories/suggest', { text });

describe('memory suggestions', () => {
  it('uses the memory model with a reasoning-safe budget', async () => {
    const { complete, calls } = capture();
    const { call, db } = makeApp({ complete });
    updateSettings(db, { defaultModelId: 'm/default', memoryModelId: 'm/memory' });
    const res = await suggest(call, 'I live in a small farming town of 50 people.');
    expect(await res.json()).toEqual({ suggestion: 'User lives in a farming town.' });
    expect(calls[0]).toMatchObject({ model: 'm/memory', maxTokens: 1000 });
    expect(calls[0].messages[0].role).toBe('system');
    expect(calls[0].messages[1]).toEqual({ role: 'user', content: 'I live in a small farming town of 50 people.' });
  });

  it('falls back to the default model and truncates long text', async () => {
    const { complete, calls } = capture();
    const { call, db } = makeApp({ complete });
    updateSettings(db, { defaultModelId: 'm/default' });
    await suggest(call, 'x'.repeat(5000));
    expect(calls[0].model).toBe('m/default');
    expect(calls[0].messages[1].content).toHaveLength(4000);
  });

  it('cleans the suggestion to one line', async () => {
    const { complete } = capture('\n\n**"User prefers metric units."**\nExtra explanation');
    const { call, db } = makeApp({ complete });
    updateSettings(db, { defaultModelId: 'm/default' });
    expect(await (await suggest(call, 'I use metric')).json()).toEqual({ suggestion: 'User prefers metric units.' });
  });

  it('400 for empty text, no model, or no API key', async () => {
    const withModel = makeApp();
    updateSettings(withModel.db, { defaultModelId: 'm/default' });
    expect((await suggest(withModel.call, '   ')).status).toBe(400);
    expect((await suggest(withModel.call, 42)).status).toBe(400);

    const noModel = makeApp();
    const res = await suggest(noModel.call, 'hello');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('Add a model in the Model Library first.');

    const noKey = makeApp({}, {});
    updateSettings(noKey.db, { defaultModelId: 'm/default' });
    expect((await suggest(noKey.call, 'hello')).status).toBe(400);
  });

  it('502 with the OpenRouter message when the call fails', async () => {
    const { complete } = capture(new OpenRouterError('Your OpenRouter account is out of credits.', 402));
    const { call, db } = makeApp({ complete });
    updateSettings(db, { defaultModelId: 'm/default' });
    const res = await suggest(call, 'hello');
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe('Your OpenRouter account is out of credits.');
  });

  it('502 when the model suggests nothing', async () => {
    const { complete } = capture('  \n ');
    const { call, db } = makeApp({ complete });
    updateSettings(db, { defaultModelId: 'm/default' });
    const res = await suggest(call, 'hello');
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toMatch(/Type the fact yourself/);
  });

  it('exposes the memory model setting and clears it when the model is removed', async () => {
    const { call } = makeApp({ listModels: async () => [] });
    await call('POST', '/api/models', { id: 'm/memory' });
    const view = (await (await call('PUT', '/api/settings', { memoryModelId: 'm/memory' })).json()) as SettingsView;
    expect(view.memoryModelId).toBe('m/memory');
    (await (await call('DELETE', '/api/models?id=m%2Fmemory')).json()) as LibraryModel[];
    expect(((await (await call('GET', '/api/settings')).json()) as SettingsView).memoryModelId).toBe('');
  });
});

describe('cleanFact', () => {
  it('keeps the first non-empty line without quotes or markdown, max 300 chars', () => {
    expect(cleanFact('- "User has a dog named Max."')).toBe('User has a dog named Max.');
    expect(cleanFact('\n\n`Fact`\nmore')).toBe('Fact');
    expect(cleanFact('a'.repeat(400))).toHaveLength(300);
    expect(cleanFact('   ')).toBe('');
  });
});
