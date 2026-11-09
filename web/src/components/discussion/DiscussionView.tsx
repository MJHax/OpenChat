import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { ArrowRight, Pause, Play, SlidersHorizontal, Square } from 'lucide-react';
import type { DiscussionDetail, DiscussionState, LibraryModel, Message } from '../../../../shared/types';
import { api, streamDiscussionTurn } from '../../api';
import { formatCost } from '../../lib/format';
import { turnLabel } from '../../lib/discussion';
import { initialLoop, loopReducer, nextAction, type LoopEvent } from '../../lib/discussionLoop';
import { loadDiscussionPrefs, saveDiscussionPrefs, type DiscussionPrefs } from '../../lib/discussionPrefs';
import { REVEAL_BEAT_MS } from '../../lib/reveal';
import { usePopover } from '../usePopover';
import { ErrorText } from '../ErrorText';
import { DiscussionOverflowDialog } from './DiscussionOverflowDialog';
import { SpendNotice } from '../SpendNotice';
import { DiscussionOptions } from './DiscussionOptions';
import { DiscussionTranscript, type LiveTurn } from './DiscussionTranscript';
import { ParticipantsPopover } from './ParticipantsPopover';
import { SummaryButton } from './SummaryButton';

export interface DiscussionViewProps {
  initial: DiscussionDetail;
  justCreated: boolean;
  models: LibraryModel[];
  onChanged(): void;
}

const isAbort = (e: unknown) => (e as Error)?.name === 'AbortError';

/** The composer bar's options button: the pacing choices, changeable mid-debate. */
function OptionsButton({ prefs, onChange }: { prefs: DiscussionPrefs; onChange(p: DiscussionPrefs): void }) {
  const { open, setOpen, root } = usePopover();
  return (
    <div className="discussion-options-pop" ref={root}>
      <button type="button" className="icon-btn" aria-label="Discussion options" title="Discussion options" aria-expanded={open} aria-haspopup="dialog"
        onClick={() => setOpen(!open)}>
        <SlidersHorizontal size={15} />
      </button>
      {open && (
        <div className="popover discussion-options-panel" role="dialog" aria-label="Discussion options">
          <DiscussionOptions prefs={prefs} onChange={onChange} />
        </div>
      )}
    </div>
  );
}

/** Watching a discussion: the browser asks for one turn at a time while it runs, and stops asking when paused or closed. */
export function DiscussionView({ initial, justCreated, models, onChanged }: DiscussionViewProps) {
  const id = initial.chat.id;
  const [detail, setDetail] = useState(initial);
  const [prefs, setPrefs] = useState(loadDiscussionPrefs);
  const [loop, dispatch] = useReducer(loopReducer, undefined, () => initialLoop(initial.state, justCreated, prefs.waitForMe));
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [draft, setDraft] = useState('');
  const busy = useRef(false);
  const abort = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  // Read when a turn ends, which can be long after the render that started it.
  const prefsRef = useRef(prefs);
  // The saved reply still being revealed, and the timer for the beat after it has fully appeared.
  const revealing = useRef<Message | null>(null);
  const beat = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nameOf = useCallback((modelId: string) => models.find((m) => m.id === modelId)?.displayName ?? modelId, [models]);

  const refresh = useCallback(() => {
    api.getDiscussion(id).then(setDetail).catch(() => {});
    onChanged();
  }, [id, onChanged]);
  const setState = (state: DiscussionState) => setDetail((d) => ({ ...d, state }));
  const append = (message: Message) =>
    setDetail((d) => (d.messages.some((m) => m.id === message.id) ? d : { ...d, messages: [...d.messages, message] }));

  /** Puts a reply that is still being revealed into the transcript now. True if there was one. */
  function settleReveal(): boolean {
    if (beat.current) clearTimeout(beat.current);
    beat.current = null;
    const message = revealing.current;
    if (!message) return false;
    revealing.current = null;
    append(message);
    setLive(null);
    return true;
  }

  // The live reply has fully appeared: after a beat, it joins the transcript and the loop may go on.
  function onRevealed() {
    if (beat.current || !revealing.current) return;
    beat.current = setTimeout(() => {
      beat.current = null;
      if (!settleReveal()) return;
      dispatch({ type: 'revealDone' });
      refresh();
    }, REVEAL_BEAT_MS);
  }

  function changePrefs(p: DiscussionPrefs) {
    setPrefs(p);
    prefsRef.current = p;
    saveDiscussionPrefs(p);
    dispatch({ type: 'setWaitForMe', on: p.waitForMe });
  }

  async function runTurn() {
    busy.current = true;
    settleReveal(); // +2 turns can start a turn while the last reply is still appearing
    const controller = new AbortController();
    abort.current = controller;
    let outcome: LoopEvent | null = null;
    dispatch({ type: 'turnStarted' });
    try {
      await streamDiscussionTurn(id, {
        onStart: (e) => setLive({ participantId: e.participantId, text: '' }),
        onDelta: (text) => setLive((l) => (l ? { ...l, text: l.text + text, status: undefined } : l)),
        onReasoning: () => {},
        onStatus: (message) => setLive((l) => (l ? { ...l, status: message } : l)),
        onDone: (e) => {
          const visible = !!e.message.content.trim();
          const reveal = visible && prefsRef.current.reveal === 'natural';
          if (reveal) {
            // Saved already; it stays the live turn until it has fully appeared.
            revealing.current = e.message;
            setLive((l) => ({ participantId: l?.participantId ?? e.message.participantId ?? '', text: e.message.content, done: true, message: e.message }));
          } else {
            append(e.message);
          }
          setState(e.state);
          outcome = { type: 'turnDone', state: e.state, visible, reveal };
        },
        onError: (e) => {
          if ('state' in e) {
            if (e.partial) append(e.partial);
            setState(e.state);
          }
          outcome = 'overflow' in e && e.overflow
            ? { type: 'turnOverflow', overflow: e.overflow, speaker: e.speaker ?? '' }
            : { type: 'turnFailed', message: e.message, spend: 'status' in e && e.status === 402 };
        },
      }, controller.signal, { allowOverflow: loop.allowOverflow });
    } catch (e) {
      if (!isAbort(e)) outcome = { type: 'turnFailed', message: (e as Error).message || 'The connection was lost.', spend: false };
    }
    // Free the loop before telling it what happened, so the next action can start.
    busy.current = false;
    abort.current = null;
    const stillAppearing = !!revealing.current;
    if (!stillAppearing) setLive(null);
    if (controller.signal.aborted) return; // Stop or leaving the page; whoever aborted takes it from here
    dispatch(outcome ?? { type: 'turnFailed', message: 'The turn ended without a reply.', spend: false });
    if (!stillAppearing) refresh(); // else once it has appeared, so the reloaded transcript can't show it twice
  }

  async function sendHost(text: string) {
    busy.current = true;
    let outcome: LoopEvent;
    try {
      append(await api.postHostMessage(id, text));
      outcome = { type: 'hostSent' };
    } catch (e) {
      outcome = { type: 'hostFailed', message: (e as Error).message };
      setDraft((d) => (d.trim() ? `${text}\n${d}` : text)); // give the text back so nothing typed is lost
    }
    busy.current = false;
    dispatch(outcome);
  }

  // Runs whatever the loop says is next. Deferred a tick so React's dev double-mount never starts a paid turn twice.
  const drafting = draft.trim() !== '';
  const action = nextAction(loop, drafting);
  useEffect(() => {
    if (action === 'idle' || busy.current) return;
    const timer = setTimeout(() => {
      if (busy.current) return;
      if (action === 'turn') void runTurn();
      else void sendHost(loop.queued[0]);
    }, 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action, loop.queued]);

  // Leaving the page cuts off the turn in progress; nothing keeps running unwatched.
  useEffect(() => () => {
    abort.current?.abort();
    if (beat.current) clearTimeout(beat.current);
  }, []);

  // Follow the transcript as it grows (new messages, streamed or revealed words) while the reader is near the bottom.
  useEffect(() => {
    const el = listRef.current;
    const inner = innerRef.current;
    if (!el || !inner) return;
    const follow = new ResizeObserver(() => {
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) el.scrollTop = el.scrollHeight;
    });
    follow.observe(inner);
    return () => follow.disconnect();
  }, []);

  async function stop() {
    dispatch({ type: 'pause' }); // no new turn may start while the stop request is on its way
    settleReveal(); // a reply still appearing shows in full at once
    abort.current?.abort();
    try {
      setState(await api.stopDiscussion(id));
      dispatch({ type: 'stopped' });
    } catch (e) {
      dispatch({ type: 'turnFailed', message: (e as Error).message, spend: false });
    }
    refresh();
  }

  async function moreTurns() {
    try {
      const state = await api.moreTurns(id);
      setState(state);
      dispatch({ type: 'turnsAdded', state });
    } catch (e) {
      dispatch({ type: 'turnFailed', message: (e as Error).message, spend: false });
    }
  }

  function print() {
    const w = window.open(api.discussionReportUrl(id), '_blank');
    w?.addEventListener('load', () => w.print());
  }

  function send() {
    const text = draft.trim();
    if (!text) return;
    dispatch({ type: 'hostTyped', text });
    setDraft('');
  }

  const running = loop.mode === 'running';
  const ended = loop.mode === 'ended';
  // Typing is the only thing keeping a running debate from its next turn.
  const typingHold = running && !loop.streaming && drafting && nextAction(loop) === 'turn';
  const status = typingHold ? 'Waiting for you to send your message.'
    : running ? 'Everyone sees what you say.' : ended ? 'The discussion has ended.' : 'Paused.';
  const moreTurnsHidden = detail.state.status === 'active' && detail.state.moderatorDecides; // the moderator decides when it ends
  return (
    <div className="chat discussion">
      <header className="chat-header">
        <h1 title={detail.topic}>{detail.topic}</h1>
        <div className="chat-header-tools discussion-tools">
          <span className="muted small">{turnLabel(detail.state)} · {detail.chat.totalCost ? formatCost(detail.chat.totalCost) : '$0.00'}</span>
          <ParticipantsPopover participants={detail.participants} nameOf={nameOf} />
          {!moreTurnsHidden && <button className="link" onClick={() => void moreTurns()}>+2 turns</button>}
          {!running && <SummaryButton discussionId={id} models={models} disabled={loop.streaming || loop.revealing} onSummary={(summary) => { setDetail((d) => ({ ...d, summary })); refresh(); }} />}
          {!running && <button className="link" onClick={print}>Print</button>}
        </div>
      </header>

      <div className="messages" ref={listRef}>
        <div className="messages-inner" ref={innerRef}>
          <DiscussionTranscript detail={detail} live={live} queued={loop.queued} naturalReveal={prefs.reveal === 'natural'} onRevealed={onRevealed} nameOf={nameOf} />
          {loop.mode === 'paused' && !loop.streaming && !loop.error && !loop.overflow && (
            <div className="discussion-end muted">Paused. Press Resume to continue.</div>
          )}
          {loop.error && <div className="error-bubble"><ErrorText message={loop.error} /></div>}
        </div>
      </div>

      {loop.overflow && (
        <DiscussionOverflowDialog
          overflow={loop.overflow.overflow}
          speaker={loop.overflow.speaker}
          onStayPaused={() => dispatch({ type: 'pause' })}
          onEnd={() => void stop()}
          onSendAnyway={() => dispatch({ type: 'sendAnyway' })}
        />
      )}

      <div className="composer">
        <div className="composer-box">
          <SpendNotice refreshKey={detail.messages.length} />
          <textarea rows={2} value={draft} placeholder="Say something to the room…" onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }} />
          {/* Laid out so nothing shifts under the pointer as turns start and end: Next appears on the left of the
              buttons, and Send is as wide as its longer label. */}
          <div className="composer-bar">
            <div className="discussion-status">
              {!ended && <OptionsButton prefs={prefs} onChange={changePrefs} />}
              <span className="muted small">{status}</span>
            </div>
            <div className="discussion-controls">
              {!ended && loop.awaitingNext && !loop.revealing && <button onClick={() => dispatch({ type: 'next' })}>Next <ArrowRight size={14} /></button>}
              {!ended && (running
                ? <button onClick={() => dispatch({ type: 'pause' })}><Pause size={14} /> Pause</button>
                : <button onClick={() => dispatch({ type: 'resume' })}><Play size={14} /> Resume</button>)}
              {!ended && <button className="danger-button" onClick={() => void stop()}><Square size={13} /> Stop</button>}
              <button className="primary send-label" disabled={!drafting} onClick={send}>
                <span className={loop.streaming ? 'hidden-label' : undefined}>Send</span>
                <span className={loop.streaming ? undefined : 'hidden-label'}>Send after this turn</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
