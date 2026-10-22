import { useState } from 'react';
import type { DiscussionDetail, LibraryModel } from '../../../../shared/types';
import {
  DEFAULT_TURN_LIMIT, INSTRUCTIONS_MAX, MAX_PARTICIPANTS, MAX_TURN_LIMIT, MIN_PARTICIPANTS, participantColor, validateNewDiscussion,
} from '../../../../shared/discussion';
import { api } from '../../api';
import { useAvailability } from '../AvailabilityContext';
import { availabilityLabel } from '../../lib/availability';
import { ErrorText } from '../ErrorText';
import { initials, setupNotes } from '../../lib/discussion';
import { X } from 'lucide-react';

interface Row {
  key: number;
  name: string;
  modelId: string;
  instructions: string;
  isModerator: boolean;
}

export interface DiscussionSetupProps {
  models: LibraryModel[];
  onCreated(d: DiscussionDetail): void;
}

let nextKey = 0;
const row = (n: number, modelId: string): Row => ({ key: nextKey++, name: `Participant ${n}`, modelId, instructions: '', isModerator: false });

/** The form a discussion starts from: a topic, 2–6 participants with their own instructions, and a turn limit. */
export function DiscussionSetup({ models, onCreated }: DiscussionSetupProps) {
  const availability = useAvailability();
  const defaultModel = (models.find((m) => m.isDefault) ?? models[0])?.id ?? '';
  const [topic, setTopic] = useState('');
  const [turnLimit, setTurnLimit] = useState(String(DEFAULT_TURN_LIMIT));
  const [rows, setRows] = useState<Row[]>(() => [row(1, defaultModel), row(2, defaultModel)]);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const supportsTools = (id: string) => models.find((m) => m.id === id)?.supportsTools ?? false;
  // Rows made before the library loaded (or whose model was removed since) use the default model.
  const modelOf = (r: Row) => (models.some((m) => m.id === r.modelId) ? r.modelId : defaultModel);
  const moderator = rows.find((r) => r.isModerator && supportsTools(modelOf(r)));
  const notes = setupNotes(rows.map(modelOf));

  const update = (key: number, patch: Partial<Row>) => {
    setError(null);
    setRows((rs) => rs.map((r) => {
      if (r.key !== key) return patch.isModerator ? { ...r, isModerator: false } : r; // one moderator at most
      const next = { ...r, ...patch };
      return next.isModerator && !supportsTools(modelOf(next)) ? { ...next, isModerator: false } : next;
    }));
  };

  async function start() {
    const draft = {
      topic, turnLimit: Number(turnLimit),
      participants: rows.map((r) => ({ name: r.name, modelId: modelOf(r), instructions: r.instructions, isModerator: r === moderator })),
    };
    const problem = validateNewDiscussion(draft, INSTRUCTIONS_MAX);
    if (problem) return setError(problem);
    setStarting(true);
    try {
      onCreated(await api.createDiscussion(draft));
    } catch (e) {
      setError((e as Error).message);
      setStarting(false);
    }
  }

  if (!models.length) {
    return (
      <div className="page"><div className="page-inner discussion-setup">
        <div className="setup-hint">Add a model in the <a href="#/models">Model Library</a> to start a discussion.</div>
      </div></div>
    );
  }

  return (
    <div className="page">
      <div className="page-inner discussion-setup">
        <h1>New discussion</h1>
        <label className="field">
          Topic
          <input value={topic} onChange={(e) => { setTopic(e.target.value); setError(null); }} placeholder="Which came first, the chicken or the egg?" />
        </label>

        <h2>Participants</h2>
        <ul className="participant-rows">
          {rows.map((r) => {
            const color = participantColor(rows.indexOf(r));
            return (
              <li key={r.key} className="participant-row card">
                <div className="participant-row-top">
                  <span className="avatar" style={{ background: color.bg, color: color.fg }} aria-hidden="true">{initials(r.name)}</span>
                  <input aria-label="Name" value={r.name} onChange={(e) => update(r.key, { name: e.target.value })} />
                  <select aria-label="Model" value={modelOf(r)} onChange={(e) => update(r.key, { modelId: e.target.value })}>
                    {models.map((m) => {
                      const label = availabilityLabel(availability[m.id]);
                      return <option key={m.id} value={m.id} disabled={!!label}>{label ? `${m.displayName} (${label})` : m.displayName}</option>;
                    })}
                  </select>
                  {supportsTools(modelOf(r)) && (
                    <label className="moderator-toggle" title="Picks who speaks next and can end the discussion">
                      <input type="checkbox" checked={r === moderator} onChange={(e) => update(r.key, { isModerator: e.target.checked })} /> Moderator
                    </label>
                  )}
                  {rows.length > MIN_PARTICIPANTS && (
                    <button className="icon" aria-label={`Remove ${r.name}`} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}><X size={16} /></button>
                  )}
                </div>
                <textarea rows={2} aria-label="Instructions" value={r.instructions} placeholder="Argue that the egg came first."
                  onChange={(e) => update(r.key, { instructions: e.target.value })} />
              </li>
            );
          })}
        </ul>
        {rows.length < MAX_PARTICIPANTS && (
          <button onClick={() => setRows((rs) => [...rs, row(rs.length + 1, defaultModel)])}>+ Add participant</button>
        )}
        {notes.sharedServer && <p className="muted small">These models share one server, so each turn may wait while the next model loads.</p>}
        {notes.tip && <p className="muted small">Tip: one local model can play every participant. Give each one different instructions.</p>}
        <p className="muted small">
          {moderator ? `Order: ${moderator.name.trim() || 'The moderator'} picks who speaks` : 'Order: rotation, in the order above'}.
          {' '}Each participant only sees its own instructions.
        </p>

        <div className="setup-footer">
          <label className="turn-limit">
            Turn limit
            <input type="number" min={1} max={MAX_TURN_LIMIT} value={turnLimit} onChange={(e) => { setTurnLimit(e.target.value); setError(null); }} />
          </label>
          <button className="primary" disabled={starting} onClick={() => void start()}>{starting ? 'Starting…' : 'Start discussion'}</button>
        </div>
        {error && <p className="error-text"><ErrorText message={error} /></p>}
      </div>
    </div>
  );
}
