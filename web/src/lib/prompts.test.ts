import { describe, it, expect } from 'vitest';
import type { SavedPrompt } from '../../../shared/types';
import { fillSlots, insertOnOwnLine, matchesPrompt, promptLabel, promptSlots } from './prompts';

const prompt = (title: string, content: string): SavedPrompt => ({ id: 1, title, content, createdAt: 1, updatedAt: 1 });

describe('promptSlots', () => {
  it('lists each slot name once, in order, trimmed', () => {
    expect(promptSlots('Review {{file}} then {{ file }} and {{line no}}')).toEqual(['file', 'line no']);
  });

  it('leaves brace text that is not a slot alone', () => {
    expect(promptSlots('{{ user.name }} {{}} {{{x}}} {x}')).toEqual([]);
  });
});

describe('fillSlots', () => {
  it('fills every use of a slot and keeps empty ones as written', () => {
    expect(fillSlots('Review {{file}} and {{ file }} at {{line}}', { file: 'a.ts', line: '' })).toBe('Review a.ts and a.ts at {{line}}');
  });
});

describe('insertOnOwnLine', () => {
  it('is the whole text in an empty box', () => {
    expect(insertOnOwnLine('', 0, 'P')).toEqual({ value: 'P', caret: 1 });
  });

  it('starts a new line after text before the caret', () => {
    expect(insertOnOwnLine('hello', 5, 'P')).toEqual({ value: 'hello\nP', caret: 7 });
  });

  it('breaks the line on both sides in the middle of a line', () => {
    expect(insertOnOwnLine('hello world', 5, 'P')).toEqual({ value: 'hello\nP\n world', caret: 7 });
  });

  it('goes above text at the start of a line', () => {
    expect(insertOnOwnLine('hello', 0, 'P')).toEqual({ value: 'P\nhello', caret: 1 });
  });

  it('adds no extra break right after a newline', () => {
    expect(insertOnOwnLine('a\n', 2, 'P')).toEqual({ value: 'a\nP', caret: 3 });
    expect(insertOnOwnLine('a\nb', 2, 'P')).toEqual({ value: 'a\nP\nb', caret: 3 });
  });

  it('clamps a caret past the end', () => {
    expect(insertOnOwnLine('abc', 99, 'P')).toEqual({ value: 'abc\nP', caret: 5 });
  });
});

describe('promptLabel and matchesPrompt', () => {
  it('falls back to the first non-empty line', () => {
    expect(promptLabel(prompt('', '\n  First line here\nsecond'))).toBe('First line here');
    expect(promptLabel(prompt('Review', 'x'))).toBe('Review');
    expect(promptLabel(prompt('', 'x'.repeat(80)))).toHaveLength(60);
  });

  it('matches title or content, ignoring case', () => {
    expect(matchesPrompt(prompt('Review', 'x'), 'REVIEW')).toBe(true);
    expect(matchesPrompt(prompt('', 'please review'), 'REVIEW')).toBe(true);
    expect(matchesPrompt(prompt('A', 'b'), 'review')).toBe(false);
    expect(matchesPrompt(prompt('A', 'b'), '')).toBe(true);
  });
});
