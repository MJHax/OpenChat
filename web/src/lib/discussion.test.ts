import { describe, it, expect } from 'vitest';
import { cheapestModel, discussionOverflowBody, discussionOverflowTitle, endText, initials, turnLabel } from './discussion';
import type { LibraryModel } from '../../../shared/types';

const model = (id: string, completionPrice: number | null, promptPrice: number | null = 0): LibraryModel => ({
  id, displayName: id, contextLength: null, promptPrice, completionPrice, isDefault: false, inputModalities: ['text'], supportsTools: false, supportsReasoning: false, source: 'openrouter', serverId: null, serverName: null, contextWindow: null, capsKnown: true,
});

describe('cheapestModel', () => {
  it('picks the lowest known completion price, then prompt price', () => {
    expect(cheapestModel([model('a', 0.00002), model('b', 0.00001, 0.00002), model('c', 0.00001, 0.000001)])?.id).toBe('c');
  });

  it('puts unknown and varying prices last', () => {
    expect(cheapestModel([model('auto', -1), model('unknown', null), model('known', 0.5)])?.id).toBe('known');
    expect(cheapestModel([model('unknown', null)])?.id).toBe('unknown');
  });

  it('prefers paid models over free ones, which are often rate-limited', () => {
    expect(cheapestModel([model('free', 0, 0), model('paid', 0.00000006)])?.id).toBe('paid');
    expect(cheapestModel([model('free', 0, 0), model('unknown', null)])?.id).toBe('free');
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
  const base = { status: 'ended' as const, endNote: null, turnLimit: 4, turnsTaken: 4, moderatorNoteAfter: null };
  it('says why a discussion ended, and nothing while active', () => {
    expect(endText({ ...base, endReason: 'limit' })).toBe('Reached the turn limit.');
    expect(endText({ ...base, endReason: 'stopped' })).toBe('You stopped the discussion.');
    expect(endText({ ...base, endReason: 'moderator', endNote: 'They agreed.' })).toBe('The moderator ended the discussion: They agreed.');
    expect(endText({ ...base, status: 'active', endReason: null })).toBeNull();
  });
});

describe('turnLabel', () => {
  it('shows turns taken against the limit', () => {
    expect(turnLabel({ status: 'active', endReason: null, endNote: null, turnLimit: 12, turnsTaken: 7, moderatorNoteAfter: null })).toBe('Turn 7 of 12');
  });
});

describe('discussion overflow copy', () => {
  it('names the model and the next speaker', () => {
    expect(discussionOverflowTitle([{ modelId: 'x', displayName: 'qwen3:1.7b', window: 1, estimate: 2 }])).toBe('This discussion is longer than qwen3:1.7b can remember.');
    expect(discussionOverflowBody('Egg-Defender')).toBe("It's Egg-Defender's turn next, so the discussion is paused.");
  });
});
