import { describe, it, expect } from 'vitest';
import { timingParts } from './timing';

describe('timingParts', () => {
  it('lists speed, first token and load time', () => {
    expect(timingParts({ firstTokenMs: 812, loadMs: 3140, tokensPerSec: 41.6 })).toEqual(['42 tok/s', '0.8 s to first token', 'loaded in 3.1 s']);
  });
  it('keeps one decimal under 10 tok/s', () => {
    expect(timingParts({ firstTokenMs: null, loadMs: null, tokensPerSec: 7.46 })).toEqual(['7.5 tok/s']);
  });
  it('leaves out a load that was not a cold load', () => {
    expect(timingParts({ firstTokenMs: 500, loadMs: 300, tokensPerSec: null })).toEqual(['0.5 s to first token']);
  });
  it('is empty with nothing known', () => {
    expect(timingParts({ firstTokenMs: null, loadMs: null, tokensPerSec: null })).toEqual([]);
    expect(timingParts(null)).toEqual([]);
  });
  it('leaves out zero speed', () => {
    expect(timingParts({ firstTokenMs: null, loadMs: null, tokensPerSec: 0 })).toEqual([]);
  });
});
