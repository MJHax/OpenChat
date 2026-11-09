import { describe, it, expect } from 'vitest';
import { validateNewDiscussion } from './discussion';
import type { NewDiscussion } from './types';

const MAX = 20_000;
const person = (name: string, isModerator = false) => ({ name, modelId: 'openai/gpt-4o', instructions: '', isModerator });
const draft = (over: Partial<NewDiscussion> = {}): NewDiscussion => ({
  topic: 'Which came first, the chicken or the egg?',
  turnLimit: 10,
  participants: [person('Egg-Defender'), person('Chicken-Defender')],
  ...over,
});

describe('validateNewDiscussion', () => {
  it('accepts a valid discussion', () => {
    expect(validateNewDiscussion(draft(), MAX)).toBeNull();
  });

  it('needs 2 to 6 participants', () => {
    const msg = 'A discussion needs 2 to 6 participants.';
    expect(validateNewDiscussion(draft({ participants: [person('A')] }), MAX)).toBe(msg);
    const seven = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((n) => person(n));
    expect(validateNewDiscussion(draft({ participants: seven }), MAX)).toBe(msg);
  });

  it('needs different names, ignoring case and spaces', () => {
    expect(validateNewDiscussion(draft({ participants: [person('Egg'), person(' egg ')] }), MAX))
      .toBe('Each participant needs a different name.');
  });

  it('reserves Host', () => {
    expect(validateNewDiscussion(draft({ participants: [person('host'), person('B')] }), MAX))
      .toBe('"Host" is reserved for you. Pick another name.');
  });

  it('needs a name of at most 40 characters', () => {
    expect(validateNewDiscussion(draft({ participants: [person('  '), person('B')] }), MAX)).toBe('Every participant needs a name.');
    expect(validateNewDiscussion(draft({ participants: [person('x'.repeat(41)), person('B')] }), MAX))
      .toBe('Names can be at most 40 characters.');
  });

  it('needs a model for everyone', () => {
    expect(validateNewDiscussion(draft({ participants: [{ ...person('A'), modelId: '' }, person('B')] }), MAX))
      .toBe('Pick a model for every participant.');
  });

  it('needs a topic of at most 500 characters', () => {
    expect(validateNewDiscussion(draft({ topic: '  ' }), MAX)).toBe('Enter a topic.');
    expect(validateNewDiscussion(draft({ topic: 'x'.repeat(501) }), MAX)).toBe('The topic can be at most 500 characters.');
  });

  it('needs a whole-number turn limit from 1 to 100', () => {
    const msg = 'The turn limit must be a whole number from 1 to 100.';
    for (const turnLimit of [0, 101, 2.5]) expect(validateNewDiscussion(draft({ turnLimit }), MAX)).toBe(msg);
  });

  it('allows at most one moderator', () => {
    expect(validateNewDiscussion(draft({ participants: [person('A', true), person('B', true)] }), MAX))
      .toBe('Only one participant can be the moderator.');
    expect(validateNewDiscussion(draft({ participants: [person('M', true), person('B')] }), MAX)).toBeNull();
  });

  it('only lets a discussion with a moderator skip the turn limit', () => {
    expect(validateNewDiscussion(draft({ moderatorDecides: true }), MAX))
      .toBe('Only a discussion with a moderator can let the moderator decide when it ends.');
    expect(validateNewDiscussion(draft({ moderatorDecides: true, participants: [person('M', true), person('B')] }), MAX)).toBeNull();
  });

  it('limits instructions', () => {
    const long = { ...person('A'), instructions: 'x'.repeat(MAX + 1) };
    expect(validateNewDiscussion(draft({ participants: [long, person('B')] }), MAX)).toBe('Instructions can be at most 20,000 characters.');
  });
});
