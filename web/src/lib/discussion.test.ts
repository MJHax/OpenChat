import { describe, it, expect } from 'vitest';
import { cheapestModel, endText, initials, turnLabel } from './discussion';
import type { LibraryModel } from '../../../shared/types';

const model = (id: string, completionPrice: number | null, promptPrice: number | null = 0): LibraryModel => ({
  id, displayName: id, contextLength: null, promptPrice, completionPrice, isDefault: false, inputModalities: ['text'], supportsTools: false,
});

describe('cheapestModel', () => {
  it('picks the lowest known completion price, then prompt price', () => {
    expect(cheapestModel([model('a', 0.00002), model('b', 0.00001, 0.00002), model('c', 0.00001, 0.000001)])?.id).toBe('c');
  });

  it('puts unknown and varying prices last', () => {
    expect(cheapestModel([model('auto', -1), model('unknown', null), model('known', 0.5)])?.id).toBe('known');
    expect(cheapestModel([model('unknown', null)])?.id).toBe('unknown');
  });

  it('returns null for an empty library', () => {
    expect(cheapestModel([])).toBeNull();
  });
});

describe('initials', () => {
  it('takes the first letters of two words, or two letters of one', () => {
    expect(initials('Egg-Defender')).toBe('ED');
    expect(initials('  moderator ')).toBe('MO');
    expect(initials('Big egg fan')).toBe('BE');
    expect(initials('')).toBe('?');
  });
});

describe('endText', () => {
  const base = { status: 'ended' as const, endNote: null, turnLimit: 4, turnsTaken: 4 };
  it('says why a discussion ended, and nothing while active', () => {
    expect(endText({ ...base, endReason: 'limit' })).toBe('Reached the turn limit.');
    expect(endText({ ...base, endReason: 'stopped' })).toBe('You stopped the discussion.');
    expect(endText({ ...base, endReason: 'moderator', endNote: 'They agreed.' })).toBe('The moderator ended the discussion: They agreed.');
    expect(endText({ ...base, status: 'active', endReason: null })).toBeNull();
  });
});

describe('turnLabel', () => {
  it('shows turns taken against the limit', () => {
    expect(turnLabel({ status: 'active', endReason: null, endNote: null, turnLimit: 12, turnsTaken: 7 })).toBe('Turn 7 of 12');
  });
});
