import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { participantColor } from '../../../shared/discussion';
import { usd } from '../../../shared/videoModels';
import type { DiscussionDetail, Message } from '../../../shared/types';

/** Served with the report: no scripts, nothing loaded from anywhere but the page itself. */
export const REPORT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:";

const END_TEXT = {
  limit: 'Reached the turn limit.',
  stopped: 'The host stopped the discussion.',
  moderator: 'The moderator ended the discussion.',
} as const;

const STYLE = `
  body { font: 14px/1.6 Georgia, 'Times New Roman', serif; color: #1a1a1a; background: #fff; max-width: 760px; margin: 2rem auto; padding: 0 16px; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  h2 { font-size: 17px; margin: 2rem 0 0.5rem; }
  .meta { color: #555; margin: 0 0 1.5rem; }
  table { border-collapse: collapse; width: 100%; font-family: system-ui, sans-serif; font-size: 13px; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #ddd; }
  td.num, th.num { text-align: right; }
  thead { display: table-header-group; }
  .turn { margin: 0 0 1rem; break-inside: avoid; }
  .who { font-family: system-ui, sans-serif; font-size: 13px; font-weight: 700; }
  .model { font-weight: 400; color: #666; }
  .body p { margin: 0.25rem 0; }
  .handoff, .end { font-style: italic; color: #555; margin: 0 0 1rem; }
  pre { white-space: pre-wrap; background: #f5f5f5; padding: 8px; }
  @page { margin: 18mm; }
  @media print { body { margin: 0; max-width: none; } }
`;

function Turn({ m, d, modelName }: { m: Message; d: DiscussionDetail; modelName: (id: string) => string }) {
  const who = d.participants.find((p) => p.id === m.participantId);
  const handoff = d.participants.find((p) => p.id === m.handoffTo);
  if (who && !m.content.trim()) {
    return <p className="handoff">{handoff ? `${who.name} → ${handoff.name}` : `${who.name} said nothing.`}</p>;
  }
  return (
    <div className="turn">
      <div className="who" style={who ? { color: participantColor(who.position).fg } : undefined}>
        {who ? who.name : 'You (host)'}
        {who && <span className="model"> · {modelName(who.modelId)}</span>}
        {handoff && <span className="model"> → {handoff.name}</span>}
        {m.status === 'stopped' && <span className="model"> (cut off)</span>}
      </div>
      <div className="body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown></div>
    </div>
  );
}

function Report({ d, generatedAt, modelName }: { d: DiscussionDetail; generatedAt: number; modelName: (id: string) => string }) {
  const { state } = d;
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>{d.chat.title}</title>
        <style>{STYLE}</style>
      </head>
      <body>
        <h1>{d.topic}</h1>
        <p className="meta">
          {`OpenChat discussion · ${new Date(generatedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`}
          {` · ${state.turnsTaken} ${state.turnsTaken === 1 ? 'turn' : 'turns'} · ${usd(d.chat.totalCost)} total`}
        </p>
        <table>
          <thead><tr><th>Participant</th><th>Model</th><th className="num">Turns</th><th className="num">Cost</th></tr></thead>
          <tbody>
            {d.participants.map((p) => (
              <tr key={p.id}>
                <td>{p.name}{p.isModerator ? ' (moderator)' : ''}</td>
                <td>{modelName(p.modelId)}</td>
                <td className="num">{p.turns}</td>
                <td className="num">{usd(p.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h2>Transcript</h2>
        {d.messages.map((m) => <Turn key={m.id} m={m} d={d} modelName={modelName} />)}
        {state.status === 'ended' && state.endReason && (
          <p className="end">{state.endReason === 'moderator' && state.endNote ? `The moderator ended the discussion: ${state.endNote}` : END_TEXT[state.endReason]}</p>
        )}
        {d.summary && (
          <>
            <h2>Summary</h2>
            <p className="meta">{`Written by ${modelName(d.summary.modelId)}`}</p>
            <div className="body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{d.summary.text}</ReactMarkdown></div>
          </>
        )}
      </body>
    </html>
  );
}

/**
 * The printable report as a full HTML document. Model text goes through Markdown without raw HTML, so anything it
 * writes is escaped, and unsafe link targets are dropped by react-markdown's default URL check.
 */
export function renderReport(d: DiscussionDetail, opts: { generatedAt: number; modelNames?: Record<string, string> }): string {
  const modelName = (id: string) => opts.modelNames?.[id] ?? id;
  return `<!doctype html>${renderToStaticMarkup(<Report d={d} generatedAt={opts.generatedAt} modelName={modelName} />)}`;
}
