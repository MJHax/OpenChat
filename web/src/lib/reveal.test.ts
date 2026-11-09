import { describe, it, expect } from 'vitest';
import { REVEAL_BEAT_MS, REVEAL_MAX_MS, REVEAL_WPS, countWords, revealRate, wordsPrefix } from './reveal';

describe('reveal helpers', () => {
  it('exposes the pacing constants', () => {
    expect([REVEAL_WPS, REVEAL_MAX_MS, REVEAL_BEAT_MS]).toEqual([6, 10_000, 1_000]);
  });

  it('reveals at 6 words per second, faster for long replies', () => {
    expect(revealRate(30)).toBe(6);
    expect(revealRate(120)).toBe(12);
  });

  it('counts words across any whitespace', () => {
    expect(countWords('Hi  there\nfriend')).toBe(3);
    expect(countWords('   ')).toBe(0);
    expect(countWords('')).toBe(0);
  });

  it('keeps original whitespace and markdown in a prefix', () => {
    expect(wordsPrefix('Hi **there** friend', 2)).toBe('Hi **there**');
    expect(wordsPrefix('Hi  there\nfriend', 2)).toBe('Hi  there');
  });

  it('returns the whole text when n covers every word, and nothing for n <= 0', () => {
    expect(wordsPrefix('a b', 5)).toBe('a b');
    expect(wordsPrefix('a b', 0)).toBe('');
  });

  it('floors a fractional word count and treats NaN as 0', () => {
    expect(wordsPrefix('a b c', 1.9)).toBe('a');
    expect(wordsPrefix('a b c', 0.5)).toBe('');
    expect(wordsPrefix('a b c', Number.NaN)).toBe('');
  });
});
