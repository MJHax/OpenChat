import { describe, it, expect } from 'vitest';
import { makeApp } from './appHelpers';
import { OpenRouterError } from '../src/openrouter';
import type { CatalogModel, CatalogResponse, LibraryModel } from '../../shared/types';
import { withCatalogDefaults } from '../../shared/types';

const CATALOG: CatalogModel[] = [
  { id: 'openai/gpt-4o:free', name: 'GPT-4o (free)', contextLength: 128000, promptPrice: 0, completionPrice: 0 },
  { id: '~anthropic/claude', name: 'Claude', contextLength: 200000, promptPrice: 0.000003, completionPrice: 0.000015 },
  { id: 'google/gemini', name: 'Gemini', contextLength: 1000000, promptPrice: 0.000001, completionPrice: 0.000004 },
].map(withCatalogDefaults);

function setup(listModels?: () => Promise<CatalogModel[]>) {
  let calls = 0;
  const ctx = makeApp({ listModels: listModels ?? (async () => { calls++; return CATALOG; }) });
  return { ...ctx, calls: () => calls };
}

describe('catalog', () => {
  it('caches the catalog and refetches on refresh=1', async () => {
    const { call, calls } = setup();
    const first = (await (await call('GET', '/api/models/catalog')).json()) as CatalogResponse;
    await call('GET', '/api/models/catalog');
    expect(first.models).toHaveLength(3);
    expect(first.stale).toBe(false);
    expect(calls()).toBe(1);
    await call('GET', '/api/models/catalog?refresh=1');
    expect(calls()).toBe(2);
  });

  it('falls back to a stale cache when OpenRouter fails, else 502', async () => {
    let fail = false;
    const { call } = setup(async () => { if (fail) throw new OpenRouterError('Could not reach OpenRouter.', 0); return CATALOG; });
    const noCache = makeApp({ listModels: async () => { throw new OpenRouterError('Could not reach OpenRouter.', 0); } });
    expect((await noCache.call('GET', '/api/models/catalog')).status).toBe(502);

    await call('GET', '/api/models/catalog');
    fail = true;
    const stale = (await (await call('GET', '/api/models/catalog?refresh=1')).json()) as CatalogResponse;
    expect(stale.stale).toBe(true);
    expect(stale.models).toHaveLength(3);
  });
});

describe('model library', () => {
  it('handles ids with slashes, colons and tildes', async () => {
    const { call } = setup();
    const added = (await (await call('POST', '/api/models', { id: 'openai/gpt-4o:free' })).json()) as LibraryModel[];
    expect(added).toEqual([
      { id: 'openai/gpt-4o:free', displayName: 'GPT-4o (free)', contextLength: 128000, promptPrice: 0, completionPrice: 0, isDefault: true },
    ]);

    await call('POST', '/api/models', { id: '~anthropic/claude' });
    let list = (await (await call('PATCH', '/api/models', { id: '~anthropic/claude', displayName: 'My Claude', isDefault: true })).json()) as LibraryModel[];
    expect(list.find((m) => m.id === '~anthropic/claude')).toMatchObject({ displayName: 'My Claude', isDefault: true });
    expect(list.find((m) => m.id === 'openai/gpt-4o:free')?.isDefault).toBe(false);

    list = (await (await call('DELETE', `/api/models?id=${encodeURIComponent('openai/gpt-4o:free')}`)).json()) as LibraryModel[];
    expect(list.map((m) => m.id)).toEqual(['~anthropic/claude']);
  });

  it('reassigns the default when the default model is removed', async () => {
    const { call } = setup();
    await call('POST', '/api/models', { id: 'google/gemini' });
    await call('POST', '/api/models', { id: '~anthropic/claude' });
    const list = (await (await call('DELETE', '/api/models?id=google%2Fgemini')).json()) as LibraryModel[];
    expect(list).toEqual([expect.objectContaining({ id: '~anthropic/claude', isDefault: true })]);
  });

  it('adding twice is harmless and unknown ids return 404 on PATCH', async () => {
    const { call } = setup();
    await call('POST', '/api/models', { id: 'google/gemini' });
    const list = (await (await call('POST', '/api/models', { id: 'google/gemini' })).json()) as LibraryModel[];
    expect(list).toHaveLength(1);
    expect((await call('PATCH', '/api/models', { id: 'nope/x', isDefault: true })).status).toBe(404);
    expect((await call('POST', '/api/models', { id: '  ' })).status).toBe(400);
  });
});
