import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { DiscussionDetail, DiscussionState, LibraryModel, Message } from '../../../../shared/types';
import { api, streamDiscussionTurn } from '../../api';
import { formatCost } from '../../lib/format';
import { turnLabel } from '../../lib/discussion';
import { initialLoop, loopReducer, nextAction, type LoopEvent } from '../../lib/discussionLoop';
import { ErrorText } from '../ErrorText';
import { DiscussionOverflowDialog } from './DiscussionOverflowDialog';
import { SpendNotice } from '../SpendNotice';
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

/** Watching a discussion: the browser asks for one turn at a time while it runs, and stops asking when paused or closed. */
export function DiscussionView({ initial, justCreated, models, onChanged }: DiscussionViewProps) {
  const id = initial.chat.id;
  const [detail, setDetail] = useState(initial);
  const [loop, dispatch] = useReducer(loopReducer, undefined, () => initialLoop(initial.state, justCreated));
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [draft, setDraft] = useState('');
  const busy = useRef(false);
  const abort = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const nameOf = useCallback((modelId: string) => models.find((m) => m.id === modelId)?.displayName ?? modelId, [models]);

  const refresh = useCallback(() => {
    api.getDiscussion(id).then(setDetail).catch(() => {});
    onChanged();
  }, [id, onChanged]);
  const setState = (state: DiscussionState) => setDetail((d) => ({ ...d, state }));
  const append = (message: Message) => setDetail((d) => ({ ...d, messages: [...d.messages, message] }));

  async function runTurn() {
    busy.current = true;
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
          append(e.message);
          setState(e.state);
          outcome = { type: 'turnDone', state: e.state, visible: !!e.message.content.trim(), reveal: false };
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
    setLive(null);
    if (controller.signal.aborted) return; // Stop or leaving the page; whoever aborted takes it from here
    dispatch(outcome ?? { type: 'turnFailed', message: 'The turn ended without a reply.', spend: false });
    refresh();
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
  const action = nextAction(loop);
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
  useEffect(() => () => abort.current?.abort(), []);

  useEffect(() => {
    const el = listRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 200) el.scrollTop = el.scrollHeight;
  }, [detail.messages.length, live?.text]);

  async function stop() {
    dispatch({ type: 'pause' }); // no new turn may start while the stop request is on its way
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
  return (
    <div className="chat discussion">
      <header className="chat-header">
        <h1 title={detail.topic}>{detail.topic}</h1>
        <div className="chat-header-tools discussion-tools">
          <span className="muted small">{turnLabel(detail.state)} · {detail.chat.totalCost ? formatCost(detail.chat.totalCost) : '$0.00'}</span>
          <ParticipantsPopover participants={detail.participants} nameOf={nameOf} />
          <button className="link" onClick={() => void moreTurns()}>+2 turns</button>
          {!ended && (running
            ? <button className="link" onClick={() => dispatch({ type: 'pause' })}>Pause</button>
            : <button className="link" onClick={() => dispatch({ type: 'resume' })}>Resume</button>)}
          {!ended && <button className="link danger" onClick={() => void stop()}>Stop</button>}
          {!running && <SummaryButton discussionId={id} models={models} disabled={loop.streaming} onSummary={(summary) => { setDetail((d) => ({ ...d, summary })); refresh(); }} />}
          {!running && <button className="link" onClick={print}>Print</button>}
        </div>
      </header>

      <div className="messages" ref={listRef}>
        <div className="messages-inner">
          <DiscussionTranscript detail={detail} live={live} queued={loop.queued} nameOf={nameOf} />
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
          <div className="composer-bar">
            <span className="muted small">{running ? 'Everyone sees what you say.' : ended ? 'The discussion has ended.' : 'Paused.'}</span>
            <button className="primary" disabled={!draft.trim()} onClick={send}>{loop.streaming ? 'Send after this turn' : 'Send'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
