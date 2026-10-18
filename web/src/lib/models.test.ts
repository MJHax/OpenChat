import { describe, it, expect } from 'vitest';
import { initialModelId } from './models';
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
