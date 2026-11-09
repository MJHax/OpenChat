/** Words revealed per second for a short reply. */
export const REVEAL_WPS = 6;
/** No reply takes longer than this to appear. */
export const REVEAL_MAX_MS = 10_000;
/** Pause after a reply has fully appeared. */
export const REVEAL_BEAT_MS = 1_000;

export function countWords(text: string): number {
  return text.match(/\S+/g)?.length ?? 0;
}

/** The text up to and including the n-th word, with its original whitespace and markdown. */
export function wordsPrefix(text: string, words: number): string {
  // A count from elapsed time x rate is fractional; never round it up past what should show.
  const n = Number.isNaN(words) ? 0 : Math.floor(words);
  if (n <= 0) return '';
  let seen = 0;
  for (const m of text.matchAll(/\S+/g)) {
    seen += 1;
    if (seen === n) return text.slice(0, m.index + m[0].length);
  }
  return text;
}

/** Words per second: at least REVEAL_WPS, faster when needed to finish within REVEAL_MAX_MS. */
export function revealRate(totalWords: number): number {
  return Math.max(REVEAL_WPS, totalWords / (REVEAL_MAX_MS / 1000));
}
