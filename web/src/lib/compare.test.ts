import { describe, it, expect } from 'vitest';
import { COMPARE_OFF, compareModels, parseCompareState, toggleModel } from './compare';

describe('parseCompareState', () => {
  it('reads saved state and tolerates junk', () => {
    expect(parseCompareState('{"enabled":true,"modelIds":["a/1","b/2"]}')).toEqual({ enabled: true, modelIds: ['a/1', 'b/2'] });
    expect(parseCompareState(null)).toEqual(COMPARE_OFF);
    expect(parseCompareState('not json')).toEqual(COMPARE_OFF);
    expect(parseCompareState('{"enabled":"yes","modelIds":[1,"a/1","a/1"]}')).toEqual({ enabled: false, modelIds: ['a/1'] });
  });
});

describe('compareModels', () => {
  const library = ['a/1', 'b/2', 'c/3', 'd/4', 'e/5'];
  it('returns the models to send when 2-4 valid ones are chosen', () => {
    expect(compareModels({ enabled: true, modelIds: ['a/1', 'c/3'] }, library)).toEqual(['a/1', 'c/3']);
  });
  it('ignores models no longer in the library and requires at least 2', () => {
    expect(compareModels({ enabled: true, modelIds: ['a/1', 'gone/x'] }, library)).toBeNull();
    expect(compareModels({ enabled: true, modelIds: [] }, library)).toBeNull();
  });
  it('returns null when compare is off', () => {
    expect(compareModels({ enabled: false, modelIds: ['a/1', 'b/2'] }, library)).toBeNull();
  });
});

describe('toggleModel', () => {
  it('adds and removes models, capped at 4', () => {
    const on = { enabled: true, modelIds: ['a/1'] };
    expect(toggleModel(on, 'b/2').modelIds).toEqual(['a/1', 'b/2']);
    expect(toggleModel(on, 'a/1').modelIds).toEqual([]);
    expect(toggleModel({ enabled: true, modelIds: ['a', 'b', 'c', 'd'] }, 'e').modelIds).toEqual(['a', 'b', 'c', 'd']);
  });
});
