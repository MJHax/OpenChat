import { Fragment, useEffect, useLayoutEffect, useRef } from 'react';
import type { DiscussionDetail, Message } from '../../../../shared/types';
import { Markdown } from '../Markdown';
import { formatCost } from '../../lib/format';
import { endText } from '../../lib/discussion';
import { Avatar } from './ParticipantsPopover';
import { useReveal } from './useReveal';
import { WORD_FADE_MS } from '../../lib/wordFade';

export interface LiveTurn {
  participantId: string;
  text: string;
  /** What the server is waiting on (e.g. a model loading, or the moderator choosing the next speaker). */
  status?: string;
  /** The stream has ended; the reply may still be appearing. */
  done?: boolean;
  /** The saved reply, kept here while it is still being revealed. */
  message?: Message;
}

export interface DiscussionTranscriptProps {
  detail: DiscussionDetail;
  live: LiveTurn | null;
  /** Host messages waiting for the current turn to finish. */
  queued: string[];
  /** Show the live reply word by word. */
  naturalReveal: boolean;
  /** The live reply has ended and fully appeared. */
  onRevealed(): void;
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

function LiveLine({ live, speaker, naturalReveal, onRevealed, nameOf }: {
  live: LiveTurn;
  speaker: DiscussionDetail['participants'][number];
  naturalReveal: boolean;
  onRevealed(): void;
  nameOf(id: string): string;
}) {
  const { shown, done, showAll } = useReveal(live.text, naturalReveal, !live.done);
  useEffect(() => {
    if (done && live.done) onRevealed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done, live.done]);

  // When each rendered word first appeared; a new turn starts from empty text and from no words.
  const seen = useRef<number[]>([]);
  if (!shown) seen.current = [];
  // New words fade in. Runs before paint, so none shows at full opacity first. An element React rebuilt gets a fresh
  // animation that carries on from when its word first appeared; one it kept keeps the animation it has.
  const body = useRef<HTMLDivElement>(null);
  const animated = useRef(new WeakSet<Element>());
  useLayoutEffect(() => {
    if (!body.current || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    for (const el of body.current.querySelectorAll<HTMLElement>('.word-fade')) {
      if (animated.current.has(el)) continue;
      animated.current.add(el);
      const fade = el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: WORD_FADE_MS, easing: 'ease-out', fill: 'both' });
      // Pinned to when the word first appeared (same clock as performance.now()), not to the next frame.
      fade.startTime = Number(el.dataset.seen);
    }
  });
  const appearing = !done && shown !== live.text;
  return (
    <div className={`turn${appearing ? ' appearing' : ''}`} onClick={appearing ? showAll : undefined} title={appearing ? 'Click to show the whole reply' : undefined}>
      <Avatar name={speaker.name} position={speaker.position} />
      <div className="turn-main">
        <div className="turn-name">{speaker.name} <span className="muted">· {nameOf(speaker.modelId)} · {live.status ?? 'writing…'}</span></div>
        {shown && <div className="msg-body" ref={body}><Markdown text={shown} fade={{ seen: seen.current }} /></div>}
      </div>
    </div>
  );
}

export function DiscussionTranscript({ detail, live, queued, naturalReveal, onRevealed, nameOf }: DiscussionTranscriptProps) {
  const speaker = live && detail.participants.find((p) => p.id === live.participantId);
  const ended = live ? null : endText(detail.state); // the end line waits until the last reply has fully appeared
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
      {live && speaker && <LiveLine key={live.participantId} live={live} speaker={speaker} naturalReveal={naturalReveal} onRevealed={onRevealed} nameOf={nameOf} />}
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
