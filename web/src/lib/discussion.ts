import type { DiscussionState, LibraryModel } from '../../../shared/types';

/** A price we can compare: known and not "varies" (negative). */
const known = (p: number | null) => (p !== null && p >= 0 ? p : Infinity);

/** The library model with the lowest completion price (then prompt price); unknown prices sort last. */
export function cheapestModel(models: LibraryModel[]): LibraryModel | null {
  const sorted = [...models].sort((a, b) =>
    known(a.completionPrice) - known(b.completionPrice) || known(a.promptPrice) - known(b.promptPrice));
  return sorted[0] ?? null;
}

export const turnLabel = (s: DiscussionState) => `Turn ${s.turnsTaken} of ${s.turnLimit}`;
