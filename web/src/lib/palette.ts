import type { SearchHit } from '../../../shared/types';

// The command palette's fixed commands (chat search results are added by the component).

export type PaletteGroup = 'Create' | 'Go to' | 'Appearance';

export interface PaletteCommand {
  id: string;
  group: PaletteGroup;
  label: string;
  keywords?: string;
}

export const PALETTE_COMMANDS: PaletteCommand[] = [
  { id: 'new-chat', group: 'Create', label: 'New chat', keywords: 'start conversation' },
  { id: 'new-image', group: 'Create', label: 'New image', keywords: 'generate picture' },
  { id: 'new-video', group: 'Create', label: 'New video', keywords: 'generate clip' },
  { id: 'new-discussion', group: 'Create', label: 'New discussion', keywords: 'debate models' },
  { id: 'go-models', group: 'Go to', label: 'Model Library', keywords: 'models add catalog' },
  { id: 'go-stats', group: 'Go to', label: 'Stats', keywords: 'usage cost spend' },
  { id: 'go-library', group: 'Go to', label: 'Library', keywords: 'files uploads downloads generated images videos' },
  { id: 'open-prompts', group: 'Go to', label: 'Saved prompts', keywords: 'snippets templates bookmarks' },
  { id: 'go-settings-general', group: 'Go to', label: 'Settings: General', keywords: 'api key default model' },
  { id: 'go-settings-appearance', group: 'Go to', label: 'Settings: Appearance', keywords: 'theme accent color motion' },
  { id: 'go-settings-memory', group: 'Go to', label: 'Settings: Memory', keywords: 'remember' },
  { id: 'go-settings-data', group: 'Go to', label: 'Settings: Data', keywords: 'export delete storage' },
  { id: 'go-settings-limits', group: 'Go to', label: 'Settings: Spending limits', keywords: 'budget' },
  { id: 'toggle-theme', group: 'Appearance', label: 'Toggle light / dark', keywords: 'theme mode dark light' },
  { id: 'accent-blue', group: 'Appearance', label: 'Accent: Blue', keywords: 'color' },
  { id: 'accent-orange', group: 'Appearance', label: 'Accent: Orange', keywords: 'color' },
  { id: 'accent-green', group: 'Appearance', label: 'Accent: Green', keywords: 'color' },
  { id: 'accent-rainbow', group: 'Appearance', label: 'Accent: Rainbow', keywords: 'color' },
  { id: 'style-flat', group: 'Appearance', label: 'Color style: Flat', keywords: 'solid' },
  { id: 'style-vivid', group: 'Appearance', label: 'Color style: Vivid', keywords: 'gradient glow' },
];

/** Commands whose label or keywords contain every word of the query, in their original order. */
export function filterCommands(query: string, commands: PaletteCommand[] = PALETTE_COMMANDS): PaletteCommand[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return commands;
  return commands.filter((c) => {
    const hay = `${c.label} ${c.keywords ?? ''}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

/** The next highlighted row after moving by `delta`, kept inside a list of `count` rows. */
export function moveSelection(index: number, delta: number, count: number): number {
  if (count === 0) return 0;
  return Math.min(count - 1, Math.max(0, index + delta));
}

export type PaletteRow = { kind: 'hit'; hit: SearchHit } | { kind: 'command'; command: PaletteCommand };

/**
 * The palette's rows for `query`: every chat hit (above the commands), but only if those hits came back for this
 * same query — older hits would move the Enter target while the new search is in flight.
 */
export function paletteRows(query: string, search: { query: string; hits: SearchHit[] }): PaletteRow[] {
  const hits = search.query.trim() === query.trim() && query.trim() ? search.hits : [];
  return [...hits.map((hit) => ({ kind: 'hit' as const, hit })), ...filterCommands(query).map((command) => ({ kind: 'command' as const, command }))];
}
