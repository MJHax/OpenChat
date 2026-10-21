import { describe, expect, it } from 'vitest';
import type { ContextOverflow } from '../../../shared/types';
import { draftAfterFailedSend, overflowTitle, summaryNote } from './overflow';

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

describe('draftAfterFailedSend', () => {
  it('gives a failed send its text and attachments back', () => {
    expect(draftAfterFailedSend({ kind: 'send', text: 'long', attachments: [1] })).toEqual({ text: 'long', attachments: [1] });
  });
  it('has nothing to give back for regenerate or edit', () => {
    expect(draftAfterFailedSend({ kind: 'regenerate' })).toBeNull();
    expect(draftAfterFailedSend({ kind: 'edit', text: 'x', attachments: [] })).toBeNull();
  });
});

describe('summaryNote', () => {
  it('says the summary only covers what the model can hold', () => {
    expect(summaryNote([o('Gemma')])).toBe('The summary will only cover the part of the chat Gemma can hold.');
  });
});
