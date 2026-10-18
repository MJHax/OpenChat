/** From this share of the window the Context button turns amber and the composer offers "Summarize and continue". */
export const WARN_AT = 0.8;

export type ContextLevel = 'ok' | 'warn' | 'full';

/** How full a context window is: `fill` is used / window size, null when the window size is unknown. */
export function contextLevel(fill: number | null): ContextLevel {
  if (fill === null || fill < WARN_AT) return 'ok';
  return fill >= 1 ? 'full' : 'warn';
}
