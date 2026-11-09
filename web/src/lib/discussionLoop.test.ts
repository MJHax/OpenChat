import { describe, it, expect } from 'vitest';
import { initialLoop, loopReducer, nextAction, type LoopEvent, type LoopState } from './discussionLoop';
import type { DiscussionState } from '../../../shared/types';

const active: DiscussionState = { status: 'active', endReason: null, endNote: null, turnLimit: 10, turnsTaken: 0, moderatorDecides: false, moderatorNoteAfter: null };
const ended: DiscussionState = { ...active, status: 'ended', endReason: 'limit', turnsTaken: 10 };
const run = (s: LoopState, ...events: LoopEvent[]) => events.reduce(loopReducer, s);

describe('discussion loop', () => {
  it('runs a new discussion and opens an existing active one paused', () => {
    expect(initialLoop(active, true)).toEqual({ mode: 'running', streaming: false, queued: [], error: null, spendBlocked: false, overflow: null, allowOverflow: false, revealing: false, waitForMe: false, awaitingNext: false });
    expect(initialLoop(active, false).mode).toBe('paused');
    expect(initialLoop(ended, true).mode).toBe('ended');
    expect(nextAction(initialLoop(active, true))).toBe('turn');
    expect(nextAction(initialLoop(active, false))).toBe('idle');
  });

  it('waits while a turn streams', () => {
    expect(nextAction(run(initialLoop(active, true), { type: 'turnStarted' }))).toBe('idle');
  });

  it('pauses after the current turn when paused mid-stream', () => {
    const s = run(initialLoop(active, true), { type: 'turnStarted' }, { type: 'pause' });
    expect(s).toMatchObject({ mode: 'paused', streaming: true });
    const after = loopReducer(s, { type: 'turnDone', state: { ...active, turnsTaken: 1 }, visible: true, reveal: false });
    expect(after.streaming).toBe(false);
    expect(nextAction(after)).toBe('idle');
  });

  it('keeps going after a turn while running', () => {
    const s = run(initialLoop(active, true), { type: 'turnStarted' }, { type: 'turnDone', state: { ...active, turnsTaken: 1 }, visible: true, reveal: false });
    expect(nextAction(s)).toBe('turn');
  });

  it('pauses on a failed turn and does not retry', () => {
    const s = run(initialLoop(active, true), { type: 'turnStarted' }, { type: 'turnFailed', message: 'The model provider returned an error.', spend: false });
    expect(s).toMatchObject({ mode: 'paused', streaming: false, error: 'The model provider returned an error.', spendBlocked: false });
    expect(nextAction(s)).toBe('idle');
  });

  it('marks spend-blocked on a 402 failure, and clears it on resume', () => {
    const s = run(initialLoop(active, true), { type: 'turnFailed', message: 'Daily spending limit reached', spend: true });
    expect(s.spendBlocked).toBe(true);
    expect(run(s, { type: 'resume' })).toMatchObject({ mode: 'running', spendBlocked: false, error: null });
  });

  it('sends a queued host message before the next turn, and only after the stream ends', () => {
    let s = run(initialLoop(active, true), { type: 'turnStarted' }, { type: 'hostTyped', text: 'Wrap it up' });
    expect(nextAction(s)).toBe('idle');
    s = loopReducer(s, { type: 'turnDone', state: { ...active, turnsTaken: 1 }, visible: true, reveal: false });
    expect(nextAction(s)).toBe('sendHost');
    expect(s.queued).toEqual(['Wrap it up']);
    s = loopReducer(s, { type: 'hostSent' });
    expect(s.queued).toEqual([]);
    expect(nextAction(s)).toBe('turn');
  });

  it('sends a host message on an ended discussion without starting a turn', () => {
    let s = run(initialLoop(ended, false), { type: 'hostTyped', text: 'Nice work' });
    expect(nextAction(s)).toBe('sendHost');
    s = loopReducer(s, { type: 'hostSent' });
    expect(nextAction(s)).toBe('idle');
    expect(s.mode).toBe('ended');
  });

  it('pauses with the error when a host message fails to send', () => {
    const s = run(initialLoop(active, true), { type: 'hostTyped', text: 'x' }, { type: 'hostFailed', message: 'Message is empty.' });
    expect(s).toMatchObject({ mode: 'paused', queued: [], error: 'Message is empty.' });
  });

  it('turnDone with an ended state ends the loop', () => {
    const s = run(initialLoop(active, true), { type: 'turnStarted' }, { type: 'turnDone', state: ended, visible: true, reveal: false });
    expect(s.mode).toBe('ended');
    expect(nextAction(s)).toBe('idle');
  });

  it('stops', () => {
    expect(run(initialLoop(active, true), { type: 'turnStarted' }, { type: 'stopped' })).toMatchObject({ mode: 'ended', streaming: false });
  });

  it('clears an old error when stopped', () => {
    const s = run(initialLoop(active, true), { type: 'turnFailed', message: 'No key', spend: true }, { type: 'stopped' });
    expect(s).toMatchObject({ error: null, spendBlocked: false });
  });

  it('turnsAdded starts turns again from ended or paused, as the spec says', () => {
    expect(run(initialLoop(ended, false), { type: 'turnsAdded', state: { ...active, turnLimit: 12 } }).mode).toBe('running');
    expect(run(initialLoop(active, false), { type: 'turnsAdded', state: { ...active, turnLimit: 12 } }).mode).toBe('running');
  });

  it('does not resume an ended discussion', () => {
    expect(run(initialLoop(ended, false), { type: 'resume' }).mode).toBe('ended');
  });

  it('pauses on an overflow and sends anyway on request', () => {
    const overflow = [{ modelId: 'local:a:m', displayName: 'qwen3:1.7b', window: 4096, estimate: 5000 }];
    const s = run(initialLoop(active, true), { type: 'turnStarted' }, { type: 'turnOverflow', overflow, speaker: 'Egg-Defender' });
    expect(s).toMatchObject({ mode: 'paused', streaming: false, overflow: { overflow, speaker: 'Egg-Defender' }, error: null });
    expect(nextAction(s)).toBe('idle');
    const go = loopReducer(s, { type: 'sendAnyway' });
    expect(go).toMatchObject({ mode: 'running', allowOverflow: true, overflow: null });
    expect(nextAction(go)).toBe('turn');
    const again = run(go, { type: 'pause' }, { type: 'resume' });
    expect(again.allowOverflow).toBe(true);
  });

  it('ends after a stop while the overflow dialog is open', () => {
    const s = run(initialLoop(active, true), { type: 'turnOverflow', overflow: [], speaker: 'A' }, { type: 'stopped' });
    expect(s).toMatchObject({ mode: 'ended', overflow: null });
  });

  describe('holds', () => {
    const done = (reveal: boolean, visible = true): LoopEvent => ({ type: 'turnDone', state: { ...active, turnsTaken: 1 }, visible, reveal });
    const started = () => run(initialLoop(active, true), { type: 'turnStarted' });

    it('holds the next turn until the reveal is done', () => {
      const s = loopReducer(started(), done(true));
      expect(s.revealing).toBe(true);
      expect(nextAction(s)).toBe('idle');
      const after = loopReducer(s, { type: 'revealDone' });
      expect(after.revealing).toBe(false);
      expect(nextAction(after)).toBe('turn');
      expect(loopReducer(started(), done(true, false)).revealing).toBe(false);
    });

    it('waits for Next after a visible reply in wait-for-me mode', () => {
      const s = loopReducer(run(started(), { type: 'setWaitForMe', on: true }), done(false));
      expect(s.awaitingNext).toBe(true);
      expect(nextAction(s)).toBe('idle');
      const after = loopReducer(s, { type: 'next' });
      expect(after.awaitingNext).toBe(false);
      expect(nextAction(after)).toBe('turn');
    });

    it('does not resume a paused discussion on Next', () => {
      const s = run(started(), { type: 'setWaitForMe', on: true }, { type: 'pause' }, done(false), { type: 'next' });
      expect(s).toMatchObject({ mode: 'paused', awaitingNext: false });
      expect(nextAction(s)).toBe('idle');
    });

    it('lets a silent moderator turn flow through in wait-for-me mode', () => {
      const s = loopReducer(run(started(), { type: 'setWaitForMe', on: true }), done(false, false));
      expect(s.awaitingNext).toBe(false);
      expect(nextAction(s)).toBe('turn');
    });

    it('starts in wait-for-me mode when asked', () => {
      expect(initialLoop(active, true, true).waitForMe).toBe(true);
      expect(run(initialLoop(active, true), { type: 'setWaitForMe', on: true }).waitForMe).toBe(true);
    });

    it('counts a sent host message as Next', () => {
      let s = run(started(), { type: 'setWaitForMe', on: true }, done(false), { type: 'hostTyped', text: 'Hi' });
      expect(s.awaitingNext).toBe(true);
      expect(nextAction(s)).toBe('sendHost');
      s = loopReducer(s, { type: 'hostSent' });
      expect(s.awaitingNext).toBe(false);
      expect(nextAction(s)).toBe('turn');
    });

    it('holds while the host is drafting and continues when the box is cleared', () => {
      const s = loopReducer(started(), done(false));
      expect(nextAction(s, true)).toBe('idle');
      expect(nextAction(s, false)).toBe('turn');
      expect(nextAction(loopReducer(s, { type: 'hostTyped', text: 'Hi' }), true)).toBe('sendHost');
    });

    it('clears every hold when stopped', () => {
      const s = run(started(), { type: 'setWaitForMe', on: true }, done(true), { type: 'stopped' });
      expect(s).toMatchObject({ revealing: false, awaitingNext: false, mode: 'ended' });
    });
  });
});
