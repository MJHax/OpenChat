import type { DiscussionState, LibraryModel } from '../../../shared/types';

/** A price we can compare: known and not "varies" (negative). */
const known = (p: number | null) => (p !== null && p >= 0 ? p : Infinity);

/** Paid models first, then free ones (often rate-limited), then models whose price is unknown. */
const tier = (m: LibraryModel) =>
  known(m.completionPrice) === Infinity ? 2 : m.completionPrice === 0 && (m.promptPrice ?? 0) === 0 ? 1 : 0;

/** The cheapest paid library model by completion price (then prompt price); free and unknown prices sort after. */
export function cheapestModel(models: LibraryModel[]): LibraryModel | null {
  const sorted = [...models].sort((a, b) =>
    tier(a) - tier(b) || known(a.completionPrice) - known(b.completionPrice) || known(a.promptPrice) - known(b.promptPrice));
  return sorted[0] ?? null;
}

/** Up to two initials for an avatar: "Egg-Defender" → "ED", "Moderator" → "MO". */
export function initials(name: string): string {
  const words = name.trim().split(/[\s\-_]+/).filter(Boolean);
  if (!words.length) return '?';
  return (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase();
}

/** Why the discussion ended, for the line at the end of the transcript; null while it can still take turns. */
export function endText(s: DiscussionState): string | null {
  if (s.status !== 'ended') return null;
  if (s.endReason === 'moderator') return `The moderator ended the discussion${s.endNote ? `: ${s.endNote}` : '.'}`;
  if (s.endReason === 'stopped') return 'You stopped the discussion.';
  return 'Reached the turn limit.';
}

export const turnLabel = (s: DiscussionState) => `Turn ${s.turnsTaken} of ${s.turnLimit}`;
