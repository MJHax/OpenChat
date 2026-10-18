import { describe, it, expect } from 'vitest';
import { cheapestModel, turnLabel } from './discussion';
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

describe('turnLabel', () => {
  it('shows turns taken against the limit', () => {
    expect(turnLabel({ status: 'active', endReason: null, endNote: null, turnLimit: 12, turnsTaken: 7 })).toBe('Turn 7 of 12');
  });
});
