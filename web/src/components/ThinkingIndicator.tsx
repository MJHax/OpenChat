import { useEffect, useState } from 'react';

/** Shown until the first words arrive; reasoning models can think silently for 20+ seconds. */
export function ThinkingIndicator({ startedAt, reasoning, webSearch = false }: { startedAt: number; reasoning: string; webSearch?: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return (
    <div className="thinking">
      Thinking… {seconds}s{webSearch && ' · web search on'}
      {reasoning && (
        <details className="reasoning">
          <summary>Show reasoning</summary>
          <div className="reasoning-text">{reasoning}</div>
        </details>
      )}
    </div>
  );
}
