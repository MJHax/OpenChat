import type { ContextOverflow, DiscussionState } from '../../../shared/types';

/**
 * The browser drives a discussion one turn at a time. 'running' asks for the next turn as soon as one ends; 'paused'
 * stops asking (the current turn still finishes); 'ended' is the server saying no more turns until more are added.
 */
export type LoopMode = 'running' | 'paused' | 'ended';

export interface LoopState {
  mode: LoopMode;
  /** A turn is streaming right now. */
  streaming: boolean;
  /** Host messages waiting for the current turn to finish, oldest first. */
  queued: string[];
  error: string | null;
  /** The last turn was refused by a spending limit. */
  spendBlocked: boolean;
  /** The next speaker's local model can't hold the discussion; the page asks before going on. */
  overflow: { overflow: ContextOverflow[]; speaker: string } | null;
  /** The host chose Send anyway: turns skip the overflow check from here on. */
  allowOverflow: boolean;
  /** The last reply is still being revealed word by word. */
  revealing: boolean;
  /** Wait-for-me mode: after each reply that showed text, hold until the host presses Next. */
  waitForMe: boolean;
  /** A reply is on screen and the host has not pressed Next (or sent a message) yet. */
  awaitingNext: boolean;
}

export type LoopEvent =
  | { type: 'resume' }
  | { type: 'pause' }
  | { type: 'turnStarted' }
  /** `visible`: the saved reply has text. `reveal`: the view will reveal it, so hold until `revealDone`. */
  | { type: 'turnDone'; state: DiscussionState; visible: boolean; reveal: boolean }
  | { type: 'revealDone' }
  | { type: 'next' }
  | { type: 'setWaitForMe'; on: boolean }
  | { type: 'turnFailed'; message: string; spend: boolean }
  | { type: 'turnOverflow'; overflow: ContextOverflow[]; speaker: string }
  | { type: 'sendAnyway' }
  | { type: 'hostTyped'; text: string }
  | { type: 'hostSent' }
  | { type: 'hostFailed'; message: string }
  | { type: 'stopped' }
  | { type: 'turnsAdded'; state: DiscussionState };

/** A discussion just created starts running; one opened later waits for Resume, so nothing spends unwatched. */
export function initialLoop(state: DiscussionState, justCreated: boolean, waitForMe = false): LoopState {
  const mode: LoopMode = state.status === 'ended' ? 'ended' : justCreated ? 'running' : 'paused';
  return { mode, streaming: false, queued: [], error: null, spendBlocked: false, overflow: null, allowOverflow: false, revealing: false, waitForMe, awaitingNext: false };
}

const paused = (mode: LoopMode): LoopMode => (mode === 'running' ? 'paused' : mode);

export function loopReducer(s: LoopState, e: LoopEvent): LoopState {
  switch (e.type) {
    case 'resume':
      return s.mode === 'ended' ? s : { ...s, mode: 'running', error: null, spendBlocked: false, overflow: null };
    case 'pause':
      return { ...s, mode: paused(s.mode), overflow: null };
    case 'turnStarted':
      return { ...s, streaming: true, error: null };
    case 'turnDone':
      return {
        ...s,
        streaming: false,
        mode: e.state.status === 'ended' ? 'ended' : s.mode,
        revealing: e.visible && e.reveal,
        awaitingNext: e.visible && s.waitForMe,
      };
    case 'revealDone':
      return { ...s, revealing: false };
    case 'next':
      return { ...s, awaitingNext: false };
    case 'setWaitForMe':
      return { ...s, waitForMe: e.on };
    case 'turnFailed':
      return { ...s, streaming: false, mode: paused(s.mode), error: e.message, spendBlocked: e.spend };
    case 'turnOverflow':
      return { ...s, streaming: false, mode: paused(s.mode), overflow: { overflow: e.overflow, speaker: e.speaker }, error: null };
    case 'sendAnyway':
      return { ...s, mode: s.mode === 'ended' ? 'ended' : 'running', allowOverflow: true, overflow: null };
    case 'hostTyped':
      return { ...s, queued: [...s.queued, e.text] };
    case 'hostSent':
      return { ...s, queued: s.queued.slice(1), awaitingNext: false };
    case 'hostFailed':
      return { ...s, queued: s.queued.slice(1), mode: paused(s.mode), error: e.message };
    case 'stopped':
      return { ...s, mode: 'ended', streaming: false, error: null, spendBlocked: false, overflow: null, revealing: false, awaitingNext: false };
    case 'turnsAdded': // +2 turns starts turns again, from paused or ended
      return e.state.status === 'active' ? { ...s, mode: 'running', error: null, spendBlocked: false } : s;
  }
}

/**
 * What the page should do now: nothing while a turn streams, then queued host messages, then the next turn, which also
 * waits for a reveal, a Next press, or the host finishing a message they are drafting.
 */
export function nextAction(s: LoopState, drafting = false): 'turn' | 'sendHost' | 'idle' {
  if (s.streaming) return 'idle';
  if (s.queued.length) return 'sendHost';
  if (s.mode !== 'running') return 'idle';
  return s.revealing || s.awaitingNext || drafting ? 'idle' : 'turn';
}
