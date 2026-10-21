import { describe, expect, it } from 'vitest';
import type { ContextOverflow } from '../../../shared/types';
import { overflowTitle } from './overflow';

const o = (displayName: string): ContextOverflow => ({ modelId: displayName, displayName, window: 1024, estimate: 2000 });

describe('overflowTitle', () => {
  it('names one model', () => {
    expect(overflowTitle([o('A')])).toBe('This chat is longer than A can remember.');
  });
  it('joins two with "and"', () => {
    expect(overflowTitle([o('A'), o('B')])).toBe('This chat is longer than A and B can remember.');
  });
  it('joins three with commas and "and"', () => {
    expect(overflowTitle([o('A'), o('B'), o('C')])).toBe('This chat is longer than A, B and C can remember.');
  });
});
