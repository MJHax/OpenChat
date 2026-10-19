import { describe, it, expect } from 'vitest';
import { PALETTE_COMMANDS, filterCommands, moveSelection, paletteRows } from './palette';

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

describe('paletteRows', () => {
  const hit = (id: string) => ({ chatId: id, chatTitle: id, chatKind: 'chat' as const, messageId: `m${id}`, snippet: '' });

  it('keeps every search hit, above the commands', () => {
    const hits = Array.from({ length: 30 }, (_, i) => hit(String(i)));
    const rows = paletteRows('new', { query: 'new', hits });
    expect(rows.filter((r) => r.kind === 'hit')).toHaveLength(30);
    expect(rows[30]).toMatchObject({ kind: 'command' });
  });

  it('drops hits that belong to an older query', () => {
    const rows = paletteRows('new chat', { query: 'new', hits: [hit('a')] });
    expect(rows.every((r) => r.kind === 'command')).toBe(true);
    expect(rows[0]).toMatchObject({ kind: 'command', command: { label: 'New chat' } });
  });
});
