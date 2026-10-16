import { describe, it, expect } from 'vitest';
import { formatContext, formatCost, formatPricePerM, formatTokens, groupByDate, splitSnippet, formatBytes } from './format';

describe('formatCost', () => {
  it('formats small and large amounts', () => {
    expect(formatCost(null)).toBe('');
    expect(formatCost(0)).toBe('$0');
    expect(formatCost(0.00001)).toBe('<$0.0001');
    expect(formatCost(0.0031)).toBe('$0.0031');
    expect(formatCost(1.234)).toBe('$1.23');
  });
});

describe('formatTokens / formatContext / formatPricePerM', () => {
  it('formats numbers for display', () => {
    expect(formatTokens(1240)).toBe('1,240');
    expect(formatContext(null)).toBe('');
    expect(formatContext(128000)).toBe('128K');
    expect(formatContext(1048576)).toBe('1M');
    expect(formatPricePerM(null)).toBe('—');
    expect(formatPricePerM(-1)).toBe('varies');
    expect(formatPricePerM(0)).toBe('free');
    expect(formatPricePerM(0.000003)).toBe('$3.00/M');
  });
});

describe('groupByDate', () => {
  it('buckets items relative to now, skipping empty groups', () => {
    const now = new Date(2026, 9, 14, 15, 0);
    const at = (d: number, h = 12) => ({ updatedAt: new Date(2026, 9, d, h).getTime() });
    const groups = groupByDate([at(14, 9), at(13), at(10), at(1)], now);
    expect(groups.map((g) => [g.label, g.items.length])).toEqual([
      ['Today', 1], ['Yesterday', 1], ['Previous 7 days', 1], ['Older', 1],
    ]);
    expect(groupByDate([at(14)], now).map((g) => g.label)).toEqual(['Today']);
  });
});

describe('splitSnippet', () => {
  it('splits highlighted parts', () => {
    expect(splitSnippet('…I like «bananas» a lot')).toEqual([
      { text: '…I like ', hit: false },
      { text: 'bananas', hit: true },
      { text: ' a lot', hit: false },
    ]);
  });
});

describe('formatBytes', () => {
  it('formats file sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 MB');
    expect(formatBytes(20.25 * 1024 * 1024)).toBe('20.3 MB');
  });
});
