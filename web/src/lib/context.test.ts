import { describe, it, expect } from 'vitest';
import { contextLevel, WARN_AT } from './context';

describe('contextLevel', () => {
  it('warns from 80% and is full from 100%', () => {
    expect(WARN_AT).toBe(0.8);
    expect(contextLevel(null)).toBe('ok');
    expect(contextLevel(0.79)).toBe('ok');
    expect(contextLevel(0.8)).toBe('warn');
    expect(contextLevel(0.99)).toBe('warn');
    expect(contextLevel(1)).toBe('full');
    expect(contextLevel(1.4)).toBe('full');
  });
});
