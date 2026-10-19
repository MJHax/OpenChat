import type { DiscussionDetail } from '../../../../shared/types';
import { participantColor } from '../../../../shared/discussion';
import { formatCost } from '../../lib/format';
import { initials } from '../../lib/discussion';
import { usePopover } from '../usePopover';
import { ChevronDown } from 'lucide-react';

const money = (usd: number) => (usd === 0 ? '$0.00' : formatCost(usd));

export function Avatar({ name, position, small }: { name: string; position: number; small?: boolean }) {
  const c = participantColor(position);
  return <span className={`avatar${small ? ' small' : ''}`} style={{ background: c.bg, color: c.fg }} aria-hidden="true">{initials(name)}</span>;
}

/** The header's avatar stack; opens a list of who's in the room, on which model, with turns, cost and instructions. */
export function ParticipantsPopover({ participants, nameOf }: { participants: DiscussionDetail['participants']; nameOf(id: string): string }) {
  const { open, setOpen, root } = usePopover();
  return (
    <div className="stats-pop" ref={root}>
      <button type="button" className="chip ghost avatar-stack" aria-expanded={open} aria-haspopup="dialog" aria-label="Participants" onClick={() => setOpen(!open)}>
        {participants.map((p) => <Avatar key={p.id} name={p.name} position={p.position} small />)} <ChevronDown size={14} />
      </button>
      {open && (
        <div className="stats-pop-panel popover down right participants-panel" role="dialog" aria-label="Participants">
          <h4>Participants</h4>
          {participants.map((p) => (
            <div key={p.id} className="participant-pop-row">
              <div className="stats-pop-row">
                <span className="participant-pop-name">
                  <Avatar name={p.name} position={p.position} small />
                  <span>
                    <b>{p.name}</b>{p.isModerator && <span className="muted"> · moderator</span>}
                    <br /><span className="muted">{nameOf(p.modelId)}</span>
                  </span>
                </span>
                <span>{p.turns} {p.turns === 1 ? 'turn' : 'turns'}<br /><span className="muted">{money(p.cost)}</span></span>
              </div>
              {p.instructions && (
                <details className="participant-instructions">
                  <summary className="muted">Instructions</summary>
                  <p>{p.instructions}</p>
                </details>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
