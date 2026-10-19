import { describe, it, expect } from 'vitest';
import { initialModelId, pickMediaEntry, sortLibrary, sortMediaLibrary } from './models';
import type { VideoModel } from '../../../shared/videoModels';
import type { LibraryModel, MediaLibraryModel, Message } from '../../../shared/types';

const lib = (id: string, isDefault = false): LibraryModel => ({ id, displayName: id, contextLength: null, promptPrice: null, completionPrice: null, isDefault, inputModalities: ['text'], supportsTools: false, supportsReasoning: false });
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

describe('sortMediaLibrary', () => {
  const video = (id: string, name: string, perSecond: string | null): MediaLibraryModel => ({
    id, displayName: name, kind: 'video', isDefault: false, avgRenderMs: null, recentRenderMs: [], avgCost: {},
    model: perSecond === null ? null : {
      id, name, description: '', created: null, durations: [5], resolutions: ['720p'], aspects: ['16:9'], sizes: [],
      frames: { first: false, last: false }, sound: false, skus: { duration_seconds_720p: perSecond },
    } satisfies VideoModel,
  });
  const list = [video('v/1', 'Veo', '0.4'), video('v/2', 'gone', null), video('v/3', 'Kling', '0.1')];

  it('sorts video models by their cheapest rate per second, unpriced last', () => {
    expect(sortMediaLibrary(list, 'cost').map((m) => m.id)).toEqual(['v/3', 'v/1', 'v/2']);
    expect(sortMediaLibrary(list, 'name').map((m) => m.id)).toEqual(['v/2', 'v/3', 'v/1']);
    expect(sortMediaLibrary(list, 'added')).toBe(list);
  });
});

describe('pickMediaEntry', () => {
  const entry = (id: string, usable = true, isDefault = false): MediaLibraryModel => ({
    id, displayName: id, kind: 'image', isDefault, model: usable ? ({ id } as never) : null, avgCost: {}, avgRenderMs: null, recentRenderMs: [],
  });
  const list = [entry('a'), entry('b', true, true), entry('gone', false), entry('c')];

  it('starts a new thread on the default model', () => {
    expect(pickMediaEntry(list, '', null)?.id).toBe('b');
  });

  it('keeps the model an existing thread last used', () => {
    expect(pickMediaEntry(list, '', 'c')?.id).toBe('c');
  });

  it('prefers an explicit pick over everything', () => {
    expect(pickMediaEntry(list, 'a', 'c')?.id).toBe('a');
  });

  it('skips models the catalog no longer lists', () => {
    expect(pickMediaEntry(list, 'gone', 'gone')?.id).toBe('b');
    expect(pickMediaEntry([entry('gone', false, true), entry('c')], '', null)?.id).toBe('c');
  });

  it('has nothing when no model is usable', () => {
    expect(pickMediaEntry([entry('gone', false)], '', null)).toBeUndefined();
  });
});
