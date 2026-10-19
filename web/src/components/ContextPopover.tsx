import { useEffect, useState } from 'react';
import type { ContextParts, ContextUsage } from '../../../shared/types';
import { api } from '../api';
import { contextLevel } from '../lib/context';
import { compactNumber, formatPercent } from '../lib/stats';
import { usePopover } from './usePopover';
import { ChevronDown } from 'lucide-react';

export interface ContextState {
  usages: ContextUsage[] | null;
  error: string | null;
  /** The window that runs out first, and how full it is (null when its size is unknown). */
  fullest: ContextUsage | null;
  fill: number | null;
}

const fill = (u: ContextUsage) => (u.contextLength ? u.used / u.contextLength : null);

/**
 * How full each model's window is for the chat. `chatId` is null for a chat that hasn't been created yet (only the
 * system prompt and `draftInstructions` count); `refreshKey` changes whenever the chat reloads, so the numbers tick up.
 */
export function useContextUsages(chatId: string | null, modelIds: string[], refreshKey: unknown, draftInstructions: string): ContextState {
  const [usages, setUsages] = useState<ContextUsage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const models = modelIds.join('\n');

  useEffect(() => {
    if (!models) return;
    let current = true;
    setError(null);
    Promise.all(models.split('\n').map((id) => api.context(id, chatId, draftInstructions)))
      .then((u) => current && setUsages(u))
      .catch((e: Error) => current && setError(e.message));
    return () => { current = false; };
  }, [models, chatId, refreshKey, chatId ? '' : draftInstructions]);

  const fullest = usages?.reduce<ContextUsage | null>((a, u) => (a && (fill(a) ?? 0) >= (fill(u) ?? 0) ? a : u), null) ?? null;
  return { usages: models ? usages : null, error, fullest, fill: fullest ? fill(fullest) : null };
}

export interface ContextPopoverProps {
  context: ContextState;
  /** False when nothing goes to a model yet (no model picked). */
  show: boolean;
  nameOf(id: string): string;
  /** Offered once the chat has messages; null hides the button. */
  onContinue: (() => void) | null;
  continuing: boolean;
}

const PARTS: { key: keyof ContextParts; label: string }[] = [
  { key: 'system', label: 'System prompt' },
  { key: 'user', label: 'Your messages' },
  { key: 'assistant', label: 'Model replies' },
  { key: 'attachments', label: 'Attachments' },
  { key: 'search', label: 'Web search results' },
];

/** Like formatPercent, but a chat that has started never reads 0%. */
export const percent = (f: number | null) => (f !== null && f > 0 && f < 0.005 ? '<1%' : formatPercent(f));
const tilde = (u: ContextUsage) => (u.estimated ? '~' : '');

function Bar({ usage }: { usage: ContextUsage }) {
  const scale = Math.max(usage.contextLength ?? usage.used, usage.used, 1);
  return (
    <div className="context-bar" aria-hidden="true">
      {PARTS.map(({ key, label }) =>
        usage.parts[key] > 0 && (
          <b key={key} className={`ctx-${key}`} style={{ width: `${(usage.parts[key] / scale) * 100}%` }}
            title={`${label}: ${compactNumber(usage.parts[key])}`} />
        ))}
    </div>
  );
}

function Summary({ usage }: { usage: ContextUsage }) {
  const f = fill(usage);
  const over = f !== null && f > 1;
  return (
    <span className={over ? 'error-text' : undefined}>
      {tilde(usage)}{compactNumber(usage.used)}
      {usage.contextLength ? ` / ${compactNumber(usage.contextLength)} (${percent(f)})` : ' · window size unknown'}
    </span>
  );
}

export function ContextPopover({ context, show, nameOf, onContinue, continuing }: ContextPopoverProps) {
  const { open, setOpen, root } = usePopover();
  const { usages, error, fullest, fill: f } = context;

  if (!show) return null;
  const shown = usages?.[0] ?? null;
  const free = shown?.contextLength ? shown.contextLength - shown.used : null;
  const level = contextLevel(f);

  return (
    <div className="stats-pop" ref={root}>
      <button type="button" className={`link stats-pop-button${level === 'full' ? ' over' : level === 'warn' ? ' warn' : ''}`} aria-expanded={open}
        aria-haspopup="dialog" onClick={() => setOpen(!open)}>
        Context {fullest ? (f !== null ? `${tilde(fullest)}${percent(f)}` : `${tilde(fullest)}${compactNumber(fullest.used)}`) : '…'} <ChevronDown size={14} />
      </button>
      {open && (
        <div className="stats-pop-panel" role="dialog" aria-label="Context window">
          <h4>Context window</h4>
          {error ? (
            <p className="error-text small">{error}</p>
          ) : !usages || !shown ? (
            <p className="muted small">Loading…</p>
          ) : (
            <>
              {usages.map((u) => (
                <div key={u.modelId} className="context-model">
                  <div className="stats-pop-row"><span className="muted">{nameOf(u.modelId)}</span><Summary usage={u} /></div>
                  <Bar usage={u} />
                </div>
              ))}
              {PARTS.map(({ key, label }) => (
                <div key={key} className="stats-pop-row">
                  <span className="muted"><i className={`context-dot ctx-${key}`} />{label}</span>
                  <span>{shown.parts[key] ? compactNumber(shown.parts[key]) : '—'}</span>
                </div>
              ))}
              {free !== null && (
                <div className="stats-pop-row">
                  <span className="muted"><i className="context-dot ctx-free" />Free space</span>
                  <span className={free < 0 ? 'error-text' : undefined}>{free < 0 ? `${compactNumber(-free)} over` : compactNumber(free)}</span>
                </div>
              )}
              <p className="muted small context-note">
                {shown.estimated
                  ? 'Estimated until the first reply reports its real token count.'
                  : 'Total is from the latest reply; the split by part is an estimate.'}
                {usages.length > 1 ? ` Parts shown for ${nameOf(shown.modelId)}.` : ''}
              </p>
              {onContinue && (
                <div className="context-continue">
                  <button onClick={() => { setOpen(false); onContinue(); }} disabled={continuing}>
                    {continuing ? 'Summarizing…' : 'Summarize and continue'}
                  </button>
                  <p className="muted small">Starts a new chat from a short summary of this one, with its latest files. Costs about one reply.</p>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
