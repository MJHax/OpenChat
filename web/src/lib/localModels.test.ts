import { describe, it, expect } from 'vitest';
import type { LibraryModel, LocalServerStatus } from '../../../shared/types';
import { formatSize, modelDetails, searchAllowed, sourceOptions } from './localModels';

const server = (id: string, name: string) => ({ id, name }) as LocalServerStatus;
const model = (over: Partial<LibraryModel>) => ({
  id: 'm', displayName: 'M', contextLength: null, promptPrice: null, completionPrice: null, isDefault: false,
  inputModalities: ['text'], supportsTools: false, supportsReasoning: false, source: 'openrouter', serverId: null,
  serverName: null, contextWindow: null, capsKnown: true, ...over,
}) as LibraryModel;

describe('sourceOptions', () => {
  it('lists All, OpenRouter, then each server', () => {
    expect(sourceOptions([server('s1', 'Ollama'), server('s2', 'LM Studio')])).toEqual([
      { id: 'all', label: 'All' }, { id: 'openrouter', label: 'OpenRouter' },
      { id: 's1', label: 'Ollama' }, { id: 's2', label: 'LM Studio' },
    ]);
    expect(sourceOptions([]).map((o) => o.label)).toEqual(['All', 'OpenRouter']);
  });
});

describe('formatSize', () => {
  it('uses 1024-based units', () => {
    expect(formatSize(1_500_000_000)).toBe('1.4 GB');
    expect(formatSize(815_000_000)).toBe('777 MB');
  });
  it('is empty when unknown', () => {
    expect(formatSize(null)).toBe('');
  });
});

describe('modelDetails', () => {
  it('describes a local model as free with its window', () => {
    expect(modelDetails(model({ source: 'local', contextWindow: 16384, contextLength: 32768 }))).toBe('Free · local · 16K context');
  });
  it('keeps the OpenRouter line', () => {
    expect(modelDetails(model({ promptPrice: 0.000001, completionPrice: 0.000002, contextLength: 128000 }))).toBe('$1.00/M in · $2.00/M out · 128K context');
  });
});

describe('searchAllowed', () => {
  const models = [model({ id: 'l', source: 'local' }), model({ id: 'o' })];
  it('is blocked only when every chosen model is local', () => {
    expect(searchAllowed(models, ['l'], false)).toBe(false);
    expect(searchAllowed(models, ['l', 'o'], false)).toBe(true);
    expect(searchAllowed(models, ['o'], false)).toBe(true);
    expect(searchAllowed(models, [], false)).toBe(true);
  });
  it('is allowed for local models once a search service is ready', () => {
    expect(searchAllowed(models, ['l'], true)).toBe(true);
    expect(searchAllowed(models, ['l', 'o'], true)).toBe(true);
  });
});
