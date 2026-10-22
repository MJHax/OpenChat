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
}

export type LoopEvent =
  | { type: 'resume' }
  | { type: 'pause' }
  | { type: 'turnStarted' }
  | { type: 'turnDone'; state: DiscussionState }
  | { type: 'turnFailed'; message: string; spend: boolean }
  | { type: 'turnOverflow'; overflow: ContextOverflow[]; speaker: string }
  | { type: 'sendAnyway' }
  | { type: 'hostTyped'; text: string }
  | { type: 'hostSent' }
  | { type: 'hostFailed'; message: string }
  | { type: 'stopped' }
  | { type: 'turnsAdded'; state: DiscussionState };

/** A discussion just created starts running; one opened later waits for Resume, so nothing spends unwatched. */
export function initialLoop(state: DiscussionState, justCreated: boolean): LoopState {
  const mode: LoopMode = state.status === 'ended' ? 'ended' : justCreated ? 'running' : 'paused';
  return { mode, streaming: false, queued: [], error: null, spendBlocked: false, overflow: null, allowOverflow: false };
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
      return { ...s, streaming: false, mode: e.state.status === 'ended' ? 'ended' : s.mode };
    case 'turnFailed':
      return { ...s, streaming: false, mode: paused(s.mode), error: e.message, spendBlocked: e.spend };
    case 'turnOverflow':
      return { ...s, streaming: false, mode: paused(s.mode), overflow: { overflow: e.overflow, speaker: e.speaker }, error: null };
    case 'sendAnyway':
      return { ...s, mode: s.mode === 'ended' ? 'ended' : 'running', allowOverflow: true, overflow: null };
    case 'hostTyped':
      return { ...s, queued: [...s.queued, e.text] };
    case 'hostSent':
      return { ...s, queued: s.queued.slice(1) };
    case 'hostFailed':
      return { ...s, queued: s.queued.slice(1), mode: paused(s.mode), error: e.message };
    case 'stopped':
      return { ...s, mode: 'ended', streaming: false, error: null, spendBlocked: false, overflow: null };
    case 'turnsAdded': // +2 turns starts turns again, from paused or ended
      return e.state.status === 'active' ? { ...s, mode: 'running', error: null, spendBlocked: false } : s;
  }
}

/** What the page should do now: nothing while a turn streams, then queued host messages, then the next turn. */
export function nextAction(s: LoopState): 'turn' | 'sendHost' | 'idle' {
  if (s.streaming) return 'idle';
  if (s.queued.length) return 'sendHost';
  return s.mode === 'running' ? 'turn' : 'idle';
}
