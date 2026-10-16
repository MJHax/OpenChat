import { describe, it, expect } from 'vitest';
import {
  capabilitiesOf, countLabel, filterCatalog, isFiltering, isNew, latestOnly, NO_FILTER, popularFor, providerChips, providerOf,
  sortCatalog, topProviders, type Capability, CAPABILITIES } from './catalog';
import { withCatalogDefaults, type CatalogModel } from '../../../shared/types';

const m = (id: string, o: Partial<CatalogModel> = {}): CatalogModel => withCatalogDefaults({ id, name: id, ...o });
const ids = (list: CatalogModel[]) => list.map((x) => x.id);

describe('search and provider filtering', () => {
  const models = [
    m('openai/gpt-4o', { name: 'OpenAI: GPT-4o' }),
    m('anthropic/claude-sonnet', { name: 'Anthropic: Claude Sonnet' }),
    m('~anthropic/claude-latest', { name: 'Claude Latest' }),
    m('google/gemini', { name: 'Gemini' }),
  ];

  it('extracts the provider', () => {
    expect(providerOf('openai/gpt-4o')).toBe('openai');
    expect(providerOf('~anthropic/claude-latest')).toBe('anthropic');
  });

  it('matches every query term against id and name', () => {
    expect(ids(filterCatalog(models, { ...NO_FILTER, query: 'claude son' }))).toEqual(['anthropic/claude-sonnet']);
    expect(ids(filterCatalog(models, { ...NO_FILTER, query: 'GPT' }))).toEqual(['openai/gpt-4o']);
  });

  it('treats a whitespace-only query as no query', () => {
    expect(filterCatalog(models, { ...NO_FILTER, query: '   ' })).toHaveLength(4);
    expect(isFiltering({ ...NO_FILTER, query: '   ' })).toBe(false);
    expect(isFiltering({ ...NO_FILTER, providers: ['openai'] })).toBe(true);
  });

  it('ORs selected providers', () => {
    expect(ids(filterCatalog(models, { ...NO_FILTER, providers: ['openai', 'google'] }))).toEqual(['openai/gpt-4o', 'google/gemini']);
    expect(ids(filterCatalog(models, { ...NO_FILTER, providers: ['anthropic'] }))).toEqual(['anthropic/claude-sonnet', '~anthropic/claude-latest']);
  });
});

describe('capabilities', () => {
  const caps = [
    m('a/reason', { supportsReasoning: true }),
    m('a/free', { promptPrice: 0, completionPrice: 0 }),
    m('a/halffree', { promptPrice: 0, completionPrice: 0.000001 }),
    m('a/long', { contextLength: 200_000 }),
    m('a/short', { contextLength: 199_999 }),
    m('a/vision', { inputModalities: ['text', 'image'] }),
    m('a/tools', { supportsTools: true }),
    m('a/file', { inputModalities: ['text', 'file'] }),
    m('a/all', {
      supportsReasoning: true, supportsTools: true, inputModalities: ['text', 'image', 'file'],
      contextLength: 1_000_000, promptPrice: 0, completionPrice: 0,
    }),
  ];
  const only = (c: Capability) => ids(filterCatalog(caps, { ...NO_FILTER, capabilities: [c] }));

  it('filters on each capability', () => {
    expect(only('reasoning')).toEqual(['a/reason', 'a/all']);
    expect(only('free')).toEqual(['a/free', 'a/all']);
    expect(only('longContext')).toEqual(['a/long', 'a/all']);
    expect(only('vision')).toEqual(['a/vision', 'a/all']);
    expect(only('tools')).toEqual(['a/tools', 'a/all']);
    expect(only('file')).toEqual(['a/file', 'a/all']);
  });

  it('does not count a half-free model as free', () => {
    expect(capabilitiesOf(caps[2])).toEqual([]);
  });

  it('ANDs selected capabilities', () => {
    expect(ids(filterCatalog(caps, { ...NO_FILTER, capabilities: ['reasoning', 'tools'] }))).toEqual(['a/all']);
  });

  it('lists capabilities in display order', () => {
    expect(capabilitiesOf(caps[8])).toEqual(['reasoning', 'free', 'longContext', 'vision', 'tools', 'file']);
  });
});

describe('sorting', () => {
  const list = [
    m('p/varies', { name: 'Varies', promptPrice: -1, completionPrice: -1, created: 300, contextLength: 2_000_000 }),
    m('p/unknown', { name: 'Unknown', created: null, contextLength: null }),
    m('p/pricey', { name: 'Pricey', promptPrice: 0.00001, completionPrice: 0.00003, created: 100, contextLength: 128_000 }),
    m('p/free', { name: 'Free', promptPrice: 0, completionPrice: 0, created: 200, contextLength: 32_000 }),
    m('p/cheap', { name: 'Cheap', promptPrice: 0.0000001, completionPrice: 0.0000004, created: 200, contextLength: 128_000 }),
  ];

  it('cheapest puts free first and unknown or varying prices last, ties by name', () => {
    expect(ids(sortCatalog(list, 'cheapest'))).toEqual(['p/free', 'p/cheap', 'p/pricey', 'p/unknown', 'p/varies']);
  });

  it('newest puts unknown dates last, ties by name', () => {
    expect(ids(sortCatalog(list, 'newest'))).toEqual(['p/varies', 'p/cheap', 'p/free', 'p/pricey', 'p/unknown']);
  });

  it('largest context puts unknown last, ties by name', () => {
    expect(ids(sortCatalog(list, 'context'))).toEqual(['p/varies', 'p/cheap', 'p/pricey', 'p/free', 'p/unknown']);
  });

  it('name sorts alphabetically without mutating the input', () => {
    const before = ids(list);
    expect(ids(sortCatalog(list, 'name'))).toEqual(['p/cheap', 'p/free', 'p/pricey', 'p/unknown', 'p/varies']);
    expect(ids(list)).toEqual(before);
  });
});

describe('topProviders', () => {
  it('ranks by model count, ties alphabetical, rest alphabetical', () => {
    const list = ['openai/a', 'openai/b', 'openai/c', 'google/a', 'google/b', 'anthropic/a', 'anthropic/b', 'x/a', 'b/a'].map((id) => m(id));
    expect(topProviders(list, 3)).toEqual({ top: ['openai', 'anthropic', 'google'], rest: ['b', 'x'] });
  });
});

describe('providerChips', () => {
  const providers = { top: ['openai', 'google'], rest: ['b', 'x'] };

  it('collapsed: top plus selected long-tail providers, counting the hidden rest', () => {
    expect(providerChips(providers, ['x'], false)).toEqual({ chips: ['openai', 'google', 'x'], hiddenCount: 1 });
    expect(providerChips(providers, [], false)).toEqual({ chips: ['openai', 'google'], hiddenCount: 2 });
  });

  it('expanded: every provider, none hidden', () => {
    expect(providerChips(providers, [], true)).toEqual({ chips: ['openai', 'google', 'b', 'x'], hiddenCount: 0 });
  });

  it('keeps a selected provider that is no longer in the catalog so it can be turned off', () => {
    expect(providerChips(providers, ['gone', 'openai'], false).chips).toEqual(['openai', 'google', 'gone']);
    expect(providerChips(providers, ['gone'], true).chips).toEqual(['openai', 'google', 'b', 'x', 'gone']);
  });
});

describe('countLabel', () => {
  it('pluralizes', () => {
    expect(countLabel(0)).toBe('0 models');
    expect(countLabel(1)).toBe('1 model');
    expect(countLabel(2)).toBe('2 models');
    expect(countLabel(1234)).toBe('1,234 models');
  });
});

describe('latestOnly', () => {
  it('treats only the most recently started request as current', () => {
    const latest = latestOnly();
    const first = latest();
    expect(first()).toBe(true);
    const second = latest();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });
});

describe('popularFor', () => {
  const catalog = Array.from({ length: 14 }, (_, i) => m(`g/${i}`, { supportsTools: i % 2 === 0 }));

  it('keeps OpenRouter order, skips unknown ids and caps at 10', () => {
    const rest = catalog.map((x) => x.id).filter((id) => id !== 'g/3' && id !== 'g/1');
    const ranked = ['g/3', 'missing/x', 'g/1', ...rest];
    const result = ids(popularFor(catalog, { programming: ranked }, 'programming', NO_FILTER));
    expect(result.slice(0, 2)).toEqual(['g/3', 'g/1']);
    expect(result).not.toContain('missing/x');
    expect(result).toHaveLength(10);
  });

  it('applies capability and provider filters', () => {
    const result = popularFor(catalog, { programming: ['g/1', 'g/2', 'g/4'] }, 'programming', { capabilities: ['tools'], providers: [] });
    expect(ids(result)).toEqual(['g/2', 'g/4']);
    expect(popularFor(catalog, { programming: ['g/1'] }, 'programming', { capabilities: [], providers: ['other'] })).toEqual([]);
  });

  it('returns nothing for a category without rankings', () => {
    expect(popularFor(catalog, {}, 'legal', NO_FILTER)).toEqual([]);
  });
});

describe('isNew', () => {
  const now = Date.UTC(2026, 9, 15);
  const DAY_S = 86_400;
  it('is true up to 30 days old and false after or when unknown', () => {
    expect(isNew(m('a/x', { created: now / 1000 - 30 * DAY_S }), now)).toBe(true);
    expect(isNew(m('a/x', { created: now / 1000 - 30 * DAY_S - 1 }), now)).toBe(false);
    expect(isNew(m('a/x', { created: null }), now)).toBe(false);
  });
});

describe('CAPABILITIES', () => {
  it('marks Vision, File input and Tools as used by OpenChat', () => {
    const used = Object.fromEntries(CAPABILITIES.map((c) => [c.id, c.usedByOpenChat]));
    expect(used).toMatchObject({ vision: true, file: true, tools: true });
  });
});
