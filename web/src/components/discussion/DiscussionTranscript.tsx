import { Fragment } from 'react';
import type { DiscussionDetail, Message } from '../../../../shared/types';
import { Markdown } from '../Markdown';
import { formatCost } from '../../lib/format';
import { endText } from '../../lib/discussion';
import { Avatar } from './ParticipantsPopover';

export interface LiveTurn {
  participantId: string;
  text: string;
  /** What the server is waiting on (e.g. a model loading); cleared once the turn starts writing. */
  status?: string;
}

export interface DiscussionTranscriptProps {
  detail: DiscussionDetail;
  live: LiveTurn | null;
  /** Host messages waiting for the current turn to finish. */
  queued: string[];
  nameOf(modelId: string): string;
}

function Line({ m, detail, nameOf }: { m: Message; detail: DiscussionDetail; nameOf(id: string): string }) {
  const who = detail.participants.find((p) => p.id === m.participantId);
  const handoff = detail.participants.find((p) => p.id === m.handoffTo);
  if (!who) {
    return (
      <div className="turn host">
        <div className="turn-name">You (host)</div>
        <div className="bubble">{m.content}</div>
      </div>
    );
  }
  if (!m.content.trim()) {
    return <div className="turn-handoff muted">{handoff ? `${who.name} → ${handoff.name}` : `${who.name} said nothing.`}</div>;
  }
  return (
    <div className="turn">
      <Avatar name={who.name} position={who.position} />
      <div className="turn-main">
        <div className="turn-name">
          {who.name} <span className="muted">· {nameOf(who.modelId)}</span>
          {handoff && <span className="handoff-tag">→ {handoff.name}</span>}
          {m.status === 'stopped' && <span className="muted"> · cut off</span>}
        </div>
        <div className="msg-body"><Markdown text={m.content} /></div>
        {m.contextDropped && <div className="muted small">Earlier messages were dropped because the chat is longer than this model's memory.</div>}
      </div>
    </div>
  );
}

export function DiscussionTranscript({ detail, live, queued, nameOf }: DiscussionTranscriptProps) {
  const speaker = live && detail.participants.find((p) => p.id === live.participantId);
  const ended = endText(detail.state);
  return (
    <>
      {detail.messages.map((m) => (
        <Fragment key={m.id}>
          <Line m={m} detail={detail} nameOf={nameOf} />
          {m.id === detail.state.moderatorNoteAfter && (
            <div className="discussion-end muted">The moderator isn't choosing speakers, so the normal order is being used.</div>
          )}
        </Fragment>
      ))}
      {speaker && (
        <div className="turn">
          <Avatar name={speaker.name} position={speaker.position} />
          <div className="turn-main">
            <div className="turn-name">{speaker.name} <span className="muted">· {nameOf(speaker.modelId)} · {live.status && !live.text ? live.status : 'writing…'}</span></div>
            {live.text && <div className="msg-body"><Markdown text={live.text} /></div>}
          </div>
        </div>
      )}
      {queued.map((text, i) => (
        <div key={i} className="turn host queued">
          <div className="turn-name">You (host) <span className="muted">· sends after this turn</span></div>
          <div className="bubble">{text}</div>
        </div>
      ))}
      {ended && <div className="discussion-end muted">{ended}</div>}
      {detail.summary && (
        <section className="summary-card card">
          <h3>Summary</h3>
          <div className="msg-body"><Markdown text={detail.summary.text} /></div>
          <div className="muted small">
            {nameOf(detail.summary.modelId)}{detail.summary.cost !== null && ` · ${formatCost(detail.summary.cost)}`}
          </div>
        </section>
      )}
    </>
  );
}
