import { describe, it, expect } from 'vitest';
import { noticeFor } from './limits';
import type { LimitStatus } from '../../../shared/types';

const status = (period: LimitStatus['period'], spent: number, amount: number, start = 100): LimitStatus => ({ period, spent, amount, start, resetsAt: start + 1 });
const none = () => null;

describe('noticeFor', () => {
  it('warns from 80% of a limit', () => {
    expect(noticeFor([status('daily', 3.9, 5)], none)).toBeNull();
    expect(noticeFor([status('daily', 4, 5)], none)?.period).toBe('daily');
    expect(noticeFor([status('daily', 6, 5)], none)?.period).toBe('daily');
  });

  it('picks the fullest limit', () => {
    expect(noticeFor([status('daily', 4, 5), status('monthly', 19, 20)], none)?.period).toBe('monthly');
  });

  it('stays hidden after dismissal until the period resets', () => {
    const dismissedAt100 = (p: string) => (p === 'daily' ? 100 : null);
    expect(noticeFor([status('daily', 4.5, 5, 100)], dismissedAt100)).toBeNull();
    expect(noticeFor([status('daily', 4.5, 5, 200)], dismissedAt100)?.period).toBe('daily');
    expect(noticeFor([status('daily', 4.5, 5, 100), status('weekly', 9, 10, 50)], dismissedAt100)?.period).toBe('weekly');
  });
});
