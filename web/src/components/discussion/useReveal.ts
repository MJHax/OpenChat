import { useCallback, useEffect, useRef, useState } from 'react';
import { countWords, revealRate, wordsPrefix } from '../../lib/reveal';

const TICK_MS = 50;

/**
 * Shows a streaming reply word by word. The count of words shown grows on a timer at `revealRate` of the words received
 * so far, never past them, so a model slower than the reveal shows at its own pace. `done` once the stream has ended and
 * every word is on screen. Disabled, it shows the text as it arrives.
 */
export function useReveal(text: string, enabled: boolean, streaming: boolean): { shown: string; done: boolean; showAll(): void } {
  const [count, setCount] = useState(0); // words shown; fractional between ticks
  const [all, setAll] = useState(false);
  const total = countWords(text);
  const totalRef = useRef(total);
  totalRef.current = total;

  // A new turn starts from empty text: reveal it from the start.
  const empty = text === '';
  useEffect(() => {
    if (!empty) return;
    setCount(0);
    setAll(false);
  }, [empty]);

  // Switched on mid-reply: carry on from what is already on screen instead of starting over.
  const wasEnabled = useRef(enabled);
  useEffect(() => {
    if (enabled && !wasEnabled.current) setCount(totalRef.current);
    wasEnabled.current = enabled;
  }, [enabled]);

  const ticking = enabled && !all && Math.floor(count) < total;
  useEffect(() => {
    if (!ticking) return;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      const elapsed = (now - last) / 1000;
      last = now;
      setCount((c) => Math.min(totalRef.current, c + revealRate(totalRef.current) * elapsed));
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [ticking]);

  const showAll = useCallback(() => setAll(true), []);
  if (!enabled || all) return { shown: text, done: !streaming, showAll };
  const words = Math.floor(count);
  return { shown: wordsPrefix(text, words), done: !streaming && words >= total, showAll };
}
