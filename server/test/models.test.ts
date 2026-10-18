import { describe, it, expect, vi } from 'vitest';
import { makeApp } from './appHelpers';
import { OpenRouterError } from '../src/openrouter';
import type { CatalogModel, CatalogResponse, LibraryModel } from '../../shared/types';
import { withCatalogDefaults } from '../../shared/types';
import { modelModalities, modelSupportsTools } from '../src/library';

const CATALOG: CatalogModel[] = [
  { id: 'openai/gpt-4o:free', name: 'GPT-4o (free)', contextLength: 128000, promptPrice: 0, completionPrice: 0 },
  { id: '~anthropic/claude', name: 'Claude', contextLength: 200000, promptPrice: 0.000003, completionPrice: 0.000015 },
  { id: 'google/gemini', name: 'Gemini', contextLength: 1000000, promptPrice: 0.000001, completionPrice: 0.000004, inputModalities: ['text', 'image', 'file'], supportsTools: true },
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

  it('falls back to stale without waiting for category lists once the model list fails', async () => {
    let fail = false;
    let hang = false;
    const { call } = makeApp({
      listModels: async () => { if (fail) throw new OpenRouterError('Could not reach OpenRouter.', 0); return CATALOG; },
      listCategory: (category) => (hang ? new Promise<string[]>(() => {}) : Promise.resolve(category === 'programming' ? ['google/gemini'] : [])),
    });
    await call('GET', '/api/models/catalog');
    fail = true;
    hang = true;
    const res = await Promise.race([
      Promise.resolve(call('GET', '/api/models/catalog?refresh=1')).then((r) => r.json() as Promise<CatalogResponse>),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 500)),
    ]);
    expect(res).not.toBe('timeout');
    expect((res as CatalogResponse).stale).toBe(true);
    expect((res as CatalogResponse).rankings.programming).toEqual(['google/gemini']);
  });

  it('bundles category rankings and leaves out categories that fail', async () => {
    const { call } = makeApp({
      listModels: async () => CATALOG,
      listCategory: async (category) => {
        if (category === 'trivia') throw new OpenRouterError('boom', 502);
        return category === 'programming' ? ['google/gemini', '~anthropic/claude'] : [];
      },
    });
    const res = (await (await call('GET', '/api/models/catalog')).json()) as CatalogResponse;
    expect(res.models).toHaveLength(3);
    expect(res.rankings.programming).toEqual(['google/gemini', '~anthropic/claude']);
    expect(res.rankings.legal).toEqual([]);
    expect(res.rankings).not.toHaveProperty('trivia');
  });

  it('does not fetch or offer the roleplay category', async () => {
    const requested: string[] = [];
    const { call } = makeApp({ listModels: async () => CATALOG, listCategory: async (category) => { requested.push(category); return []; } });
    const res = (await (await call('GET', '/api/models/catalog')).json()) as CatalogResponse;
    expect(requested).not.toContain('roleplay');
    expect(requested).toHaveLength(11);
    expect(res.rankings).not.toHaveProperty('roleplay');
  });

  it('caches rankings with the models', async () => {
    let rankingCalls = 0;
    const { call } = makeApp({ listModels: async () => CATALOG, listCategory: async () => { rankingCalls++; return ['google/gemini']; } });
    await call('GET', '/api/models/catalog');
    const second = (await (await call('GET', '/api/models/catalog')).json()) as CatalogResponse;
    expect(rankingCalls).toBe(11);
    expect(second.rankings.programming).toEqual(['google/gemini']);
  });

  it('refetches a legacy array cache even when it is fresh', async () => {
    const { db, call, calls } = setup();
    db.prepare('INSERT INTO model_catalog_cache (id, fetched_at, json) VALUES (1, ?, ?)')
      .run(Date.now(), JSON.stringify([{ id: 'old/model', name: 'Old', contextLength: null, promptPrice: null, completionPrice: null }]));
    const res = (await (await call('GET', '/api/models/catalog')).json()) as CatalogResponse;
    expect(calls()).toBe(1);
    expect(res.models).toHaveLength(3);
  });

  it('serves a legacy cache as stale with defaults when the refetch fails', async () => {
    const { db, call } = makeApp({ listModels: async () => { throw new OpenRouterError('Could not reach OpenRouter.', 0); } });
    const legacy = { id: 'old/model', name: 'Old', contextLength: 8000, promptPrice: 0, completionPrice: 0 };
    db.prepare('INSERT INTO model_catalog_cache (id, fetched_at, json) VALUES (1, ?, ?)').run(Date.now(), JSON.stringify([legacy]));
    const res = (await (await call('GET', '/api/models/catalog')).json()) as CatalogResponse;
    expect(res.stale).toBe(true);
    expect(res.rankings).toEqual({});
    expect(res.models).toEqual([withCatalogDefaults(legacy)]);
  });

  it('retries rankings after a few minutes when a category failed, instead of caching the gap for a day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const t0 = Date.UTC(2026, 9, 15, 12);
      vi.setSystemTime(t0);
      let fail = true;
      let modelCalls = 0;
      const { call } = makeApp({
        listModels: async () => { modelCalls++; return CATALOG; },
        listCategory: async (category) => {
          if (fail && category === 'trivia') throw new OpenRouterError('Rate limited', 429);
          return ['google/gemini'];
        },
      });
      await call('GET', '/api/models/catalog');
      fail = false;
      vi.setSystemTime(t0 + 60_000);
      await call('GET', '/api/models/catalog');
      expect(modelCalls).toBe(1);
      vi.setSystemTime(t0 + 6 * 60_000);
      const res = (await (await call('GET', '/api/models/catalog')).json()) as CatalogResponse;
      expect(modelCalls).toBe(2);
      expect(res.rankings.trivia).toEqual(['google/gemini']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a cache row without rankings as having none', async () => {
    const { db, call } = makeApp({ listModels: async () => CATALOG });
    db.prepare('INSERT INTO model_catalog_cache (id, fetched_at, json) VALUES (1, ?, ?)').run(Date.now(), JSON.stringify({ models: CATALOG }));
    const res = (await (await call('GET', '/api/models/catalog')).json()) as CatalogResponse;
    expect(res.rankings).toEqual({});
    expect(res.models).toHaveLength(3);
  });
});

describe('model library', () => {
  it('handles ids with slashes, colons and tildes', async () => {
    const { call } = setup();
    const added = (await (await call('POST', '/api/models', { id: 'openai/gpt-4o:free' })).json()) as LibraryModel[];
    expect(added).toEqual([
      { id: 'openai/gpt-4o:free', displayName: 'GPT-4o (free)', contextLength: 128000, promptPrice: 0, completionPrice: 0, isDefault: true, inputModalities: ['text'], supportsTools: false },
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

  it('lists supportsTools for library models', async () => {
    const { call } = setup();
    await call('POST', '/api/models', { id: 'openai/gpt-4o:free' });
    const list = (await (await call('POST', '/api/models', { id: 'google/gemini' })).json()) as LibraryModel[];
    expect(list.map((m) => [m.id, m.supportsTools])).toEqual([['openai/gpt-4o:free', false], ['google/gemini', true]]);
  });

  it('stores input modalities when a model is added', async () => {
    const { call } = setup();
    const list = (await (await call('POST', '/api/models', { id: 'google/gemini' })).json()) as LibraryModel[];
    expect(list[0].inputModalities).toEqual(['text', 'image', 'file']);
  });

  it('backfills missing modalities from the cached catalog', async () => {
    const { call, db } = setup();
    await call('POST', '/api/models', { id: 'google/gemini' });
    db.prepare('UPDATE models SET input_modalities = NULL').run();
    const list = (await (await call('GET', '/api/models')).json()) as LibraryModel[];
    expect(list[0].inputModalities).toEqual(['text', 'image', 'file']);
    expect((db.prepare('SELECT input_modalities AS v FROM models').get() as { v: string | null }).v).not.toBeNull();
  });

  it('does not backfill from a legacy array cache, which has no modalities', async () => {
    const { call, db } = setup();
    await call('POST', '/api/models', { id: 'google/gemini' });
    db.prepare('UPDATE models SET input_modalities = NULL').run();
    const legacy = { id: 'google/gemini', name: 'Gemini', contextLength: 8000, promptPrice: 0, completionPrice: 0 };
    db.prepare('UPDATE model_catalog_cache SET json = ? WHERE id = 1').run(JSON.stringify([legacy]));
    expect(modelModalities(db, 'google/gemini')).toEqual(['text']);
    expect((db.prepare('SELECT input_modalities AS v FROM models').get() as { v: string | null }).v).toBeNull();
  });

  it('treats unknown modalities as text-only', async () => {
    const { call, db } = setup();
    expect(modelModalities(db, 'not/in-library')).toEqual(['text']);
    await call('POST', '/api/models', { id: 'google/gemini' });
    db.prepare('UPDATE models SET input_modalities = NULL').run();
    db.prepare('DELETE FROM model_catalog_cache').run();
    expect(modelModalities(db, 'google/gemini')).toEqual(['text']);
  });
});

describe('tool support', () => {
  it('stores tool support, backfills it from the catalog, and treats unknown as none', async () => {
    const { call, db } = setup();
    await call('POST', '/api/models', { id: 'google/gemini' });
    await call('POST', '/api/models', { id: '~anthropic/claude' });
    expect(modelSupportsTools(db, 'google/gemini')).toBe(true);
    expect(modelSupportsTools(db, '~anthropic/claude')).toBe(false);
    expect(modelSupportsTools(db, 'not/in-library')).toBe(false);

    db.prepare('UPDATE models SET supports_tools = NULL').run();
    expect(modelSupportsTools(db, 'google/gemini')).toBe(true);
    expect((db.prepare("SELECT supports_tools AS v FROM models WHERE id = 'google/gemini'").get() as { v: number | null }).v).toBe(1);

    db.prepare('UPDATE models SET supports_tools = NULL').run();
    db.prepare('DELETE FROM model_catalog_cache').run();
    expect(modelSupportsTools(db, 'google/gemini')).toBe(false);
  });
});
