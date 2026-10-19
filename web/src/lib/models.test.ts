import { describe, it, expect } from 'vitest';
import { initialModelId, sortLibrary } from './models';
import type { LibraryModel, Message } from '../../../shared/types';

const lib = (id: string, isDefault = false): LibraryModel => ({ id, displayName: id, contextLength: null, promptPrice: null, completionPrice: null, isDefault, inputModalities: ['text'], supportsTools: false });
const reply = (modelId: string): Pick<Message, 'role' | 'modelId'> => ({ role: 'assistant', modelId });
const models = [lib('a/one'), lib('b/two', true), lib('c/three')];

describe('initialModelId', () => {
  it('uses the default model for a new chat', () => {
    expect(initialModelId([], models)).toBe('b/two');
  });

  it('uses the last model that replied in an existing chat', () => {
    expect(initialModelId([reply('a/one'), { role: 'user', modelId: null }, reply('c/three')], models)).toBe('c/three');
  });

  it('prefers a given model (a continued chat) only until a model has replied', () => {
    expect(initialModelId([{ role: 'assistant', modelId: null }], models, 'c/three')).toBe('c/three');
    expect(initialModelId([reply('a/one')], models, 'c/three')).toBe('a/one');
    expect(initialModelId([], models, 'gone/model')).toBe('b/two');
  });

  it('falls back to the default when the last model was removed from the library', () => {
    expect(initialModelId([reply('gone/model')], models)).toBe('b/two');
  });

  it('falls back to the first model when no default is set, or empty when the library is empty', () => {
    expect(initialModelId([], [lib('a/one'), lib('c/three')])).toBe('a/one');
    expect(initialModelId([], [])).toBe('');
  });
});

describe('sortLibrary', () => {
  const priced = (id: string, name: string, p: number | null, c: number | null): LibraryModel => ({ ...lib(id), displayName: name, promptPrice: p, completionPrice: c });
  const list = [priced('x/1', 'beta', 0.002, 0.002), priced('x/2', 'Alpha', -1, -1), priced('x/3', 'gamma', 0, 0), priced('x/4', 'delta', null, 0.001)];
  const ids = (ms: LibraryModel[]) => ms.map((m) => m.id);

  it('keeps the order added', () => {
    expect(ids(sortLibrary(list, 'added'))).toEqual(['x/1', 'x/2', 'x/3', 'x/4']);
  });

  it('sorts by display name, ignoring case', () => {
    expect(ids(sortLibrary(list, 'name'))).toEqual(['x/2', 'x/1', 'x/4', 'x/3']);
  });

  it('sorts cheapest first, with unknown and varying prices last by name', () => {
    expect(ids(sortLibrary(list, 'cost'))).toEqual(['x/3', 'x/1', 'x/2', 'x/4']);
  });
});
