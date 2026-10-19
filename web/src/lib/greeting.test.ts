import { describe, it, expect } from 'vitest';
import { greeting } from './greeting';

describe('greeting', () => {
  it('follows the time of day', () => {
    expect([4, 5, 11, 12, 17, 18, 23].map(greeting)).toEqual([
      'Good evening.', 'Good morning.', 'Good morning.', 'Good afternoon.', 'Good afternoon.', 'Good evening.', 'Good evening.',
    ]);
  });
});
