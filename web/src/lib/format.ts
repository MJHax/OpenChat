export function formatCost(usd: number | null): string {
  if (usd === null) return '';
  if (usd === 0) return '$0';
  if (usd < 0.0001) return '<$0.0001';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export const formatTokens = (n: number): string => n.toLocaleString('en-US');

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${+(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${+(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${+(n / 1024 ** 3).toFixed(2)} GB`;
}

export function formatPricePerM(perToken: number | null): string {
  if (perToken === null) return '—';
  if (perToken < 0) return 'varies';
  if (perToken === 0) return 'free';
  return `$${(perToken * 1_000_000).toFixed(2)}/M`;
}

export function formatContext(n: number | null): string {
  if (!n) return '';
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

export type DateGroup = 'Today' | 'Yesterday' | 'Previous 7 days' | 'Older';

export function groupByDate<T extends { updatedAt: number }>(items: T[], now = new Date()): { label: DateGroup; items: T[] }[] {
  const DAY = 86_400_000;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const groups: { label: DateGroup; items: T[] }[] = [
    { label: 'Today', items: [] },
    { label: 'Yesterday', items: [] },
    { label: 'Previous 7 days', items: [] },
    { label: 'Older', items: [] },
  ];
  for (const item of items) {
    const t = item.updatedAt;
    const index = t >= today ? 0 : t >= today - DAY ? 1 : t >= today - 7 * DAY ? 2 : 3;
    groups[index].items.push(item);
  }
  return groups.filter((g) => g.items.length > 0);
}

/** Splits a search snippet whose matches are wrapped in « » into plain and highlighted parts. */
export function splitSnippet(snippet: string): { text: string; hit: boolean }[] {
  return snippet
    .split(/(«[^»]*»)/)
    .filter(Boolean)
    .map((part) => (part.startsWith('«') ? { text: part.slice(1, -1), hit: true } : { text: part, hit: false }));
}
