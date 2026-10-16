import { describe, it, expect } from 'vitest';
import { filterCatalog, providerOf } from './catalog';
import type { CatalogModel } from '../../../shared/types';
import { withCatalogDefaults } from '../../../shared/types';

const m = (id: string, name: string): CatalogModel => withCatalogDefaults({ id, name });
const models = [m('openai/gpt-4o', 'OpenAI: GPT-4o'), m('anthropic/claude-sonnet', 'Anthropic: Claude Sonnet'), m('~anthropic/claude-latest', 'Claude Latest')];

describe('catalog filtering', () => {
  it('extracts the provider', () => {
    expect(providerOf('openai/gpt-4o')).toBe('openai');
    expect(providerOf('~anthropic/claude-latest')).toBe('anthropic');
  });

  it('filters by provider and by every query term against id and name', () => {
    expect(filterCatalog(models, '', 'anthropic').map((x) => x.id)).toEqual(['anthropic/claude-sonnet', '~anthropic/claude-latest']);
    expect(filterCatalog(models, 'claude son', '').map((x) => x.id)).toEqual(['anthropic/claude-sonnet']);
    expect(filterCatalog(models, 'GPT', '').map((x) => x.id)).toEqual(['openai/gpt-4o']);
    expect(filterCatalog(models, '', '')).toHaveLength(3);
  });
});
