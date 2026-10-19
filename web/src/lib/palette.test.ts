import { describe, it, expect } from 'vitest';
import { PALETTE_COMMANDS, filterCommands, moveSelection } from './palette';

describe('filterCommands', () => {
  it('lists every command for an empty query', () => {
    expect(filterCommands('')).toHaveLength(PALETTE_COMMANDS.length);
    expect(filterCommands('   ')).toHaveLength(PALETTE_COMMANDS.length);
  });

  it('matches every term, ignoring case', () => {
    expect(filterCommands('new vid').map((c) => c.label)).toEqual(['New video']);
    expect(filterCommands('ACCENT green').map((c) => c.label)).toEqual(['Accent: Green']);
  });

  it('matches keywords too', () => {
    expect(filterCommands('dark').map((c) => c.label)).toContain('Toggle light / dark');
  });

  it('returns nothing when nothing matches', () => {
    expect(filterCommands('zzz')).toEqual([]);
  });
});

describe('moveSelection', () => {
  it('clamps to the list', () => {
    expect(moveSelection(0, -1, 5)).toBe(0);
    expect(moveSelection(4, 1, 5)).toBe(4);
    expect(moveSelection(1, 1, 5)).toBe(2);
    expect(moveSelection(2, 1, 0)).toBe(0);
  });
});
