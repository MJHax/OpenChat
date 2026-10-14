import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, buildMessages } from '../src/prompt';

const empty = { aboutMe: '', customInstructions: '', memories: [] };

describe('buildSystemPrompt', () => {
  it('returns null when everything is empty or whitespace', () => {
    expect(buildSystemPrompt(empty)).toBeNull();
    expect(buildSystemPrompt({ aboutMe: '  ', customInstructions: '\n', memories: [' '] })).toBeNull();
  });

  it('includes only non-empty sections in order', () => {
    expect(buildSystemPrompt({ aboutMe: 'I am Sam.', customInstructions: '', memories: ['Likes tea', 'Has a dog'] })).toBe(
      'About the user:\nI am Sam.\n\nThings to remember about the user:\n- Likes tea\n- Has a dog',
    );
    expect(buildSystemPrompt({ ...empty, customInstructions: 'Be brief.' })).toBe('Instructions:\nBe brief.');
  });
});

describe('buildMessages', () => {
  const path = [
    { role: 'user' as const, content: 'hi' },
    { role: 'assistant' as const, content: 'hello' },
  ];

  it('prepends the system prompt when present', () => {
    expect(buildMessages({ ...empty, aboutMe: 'Sam' }, path)).toEqual([
      { role: 'system', content: 'About the user:\nSam' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
  });

  it('omits the system message when there is no persona', () => {
    expect(buildMessages(empty, path)).toEqual(path);
  });
});
