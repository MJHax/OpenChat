import type { Source } from '../../../shared/types';
import { domainOf, sourceLabel } from '../lib/search';

/** The pages a reply's web search drew on, collapsed by default. */
export function Sources({ sources }: { sources: Source[] }) {
  if (sources.length === 0) return null;
  return (
    <details className="sources">
      <summary>Sources ({sources.length})</summary>
      <ol>
        {sources.map((s) => (
          <li key={s.url}>
            <a href={s.url} target="_blank" rel="noopener noreferrer">{sourceLabel(s)}</a>
            <span className="muted"> {domainOf(s.url)}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}
